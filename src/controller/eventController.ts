/*
 * CUSTOMIZAÇÃO LOCAL (não oficial) — Central de Automação WhatsApp. Evento V1.
 * POST /api/:session/send-event-message
 * Executa SOMENTE WPP.chat.sendEventMessage(groupId, { name, description, startTime, endTime })
 * na página da sessão JÁ conectada. Sem location, sem callType.
 * Uma chamada por requisição, NUNCA repetida (timeout = resultado incerto, não reenvia).
 * Nunca registra Authorization, token, nome/descrição do evento nem dados internos.
 */
import { Request, Response } from 'express';

export const EVENT_TIMEOUT_MS = 60_000;
export const NAME_MAX = 256;
export const DESCRIPTION_MAX = 2048;
/** Segundos Unix plausíveis: 2020-01-01 .. 2100-01-01 (rejeita milissegundos). */
export const MIN_EPOCH_S = 1_577_836_800;
export const MAX_EPOCH_S = 4_102_444_800;
/** Duração máxima aceita: 31 dias. */
export const MAX_DURATION_S = 31 * 24 * 3600;
const GROUP_ID_RE = /^[0-9]{5,40}(-[0-9]{5,20})?@g\.us$/;

export type EventPayload = {
  groupId: string;
  name: string;
  description?: string;
  startTime: number;
  endTime: number;
};

export type ValidationResult =
  | { ok: true; value: EventPayload }
  | { ok: false; code: string };

const isEpoch = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isInteger(v) &&
  v >= MIN_EPOCH_S &&
  v <= MAX_EPOCH_S;

/** Validação pura (sem sessão) — executada ANTES de qualquer chamada ao WA-JS. */
export function validateEventPayload(
  body: any,
  nowS: number = Math.floor(Date.now() / 1000)
): ValidationResult {
  if (!body || typeof body !== 'object')
    return { ok: false, code: 'INVALID_BODY' };
  const allowed = new Set([
    'phone',
    'isGroup',
    'name',
    'description',
    'startTime',
    'endTime',
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return { ok: false, code: 'UNSUPPORTED_FIELD' };
  }
  if (body.isGroup !== true) return { ok: false, code: 'GROUP_ONLY' };

  const phones = Array.isArray(body.phone) ? body.phone : [body.phone];
  if (phones.length !== 1 || typeof phones[0] !== 'string') {
    return { ok: false, code: 'SINGLE_GROUP_REQUIRED' };
  }
  const groupId = phones[0].trim();
  if (!GROUP_ID_RE.test(groupId))
    return { ok: false, code: 'INVALID_GROUP_ID' };

  if (typeof body.name !== 'string') return { ok: false, code: 'INVALID_NAME' };
  const name = body.name.trim();
  if (!name || name.length > NAME_MAX)
    return { ok: false, code: 'INVALID_NAME' };

  let description: string | undefined;
  if (body.description !== undefined && body.description !== null) {
    if (
      typeof body.description !== 'string' ||
      body.description.length > DESCRIPTION_MAX
    ) {
      return { ok: false, code: 'INVALID_DESCRIPTION' };
    }
    description = body.description.trim() || undefined;
  }

  if (!isEpoch(body.startTime))
    return { ok: false, code: 'INVALID_START_TIME' };
  if (!isEpoch(body.endTime)) return { ok: false, code: 'INVALID_END_TIME' };
  if (body.startTime <= nowS) return { ok: false, code: 'START_TIME_IN_PAST' };
  if (body.endTime <= body.startTime)
    return { ok: false, code: 'END_BEFORE_START' };
  if (body.endTime - body.startTime > MAX_DURATION_S)
    return { ok: false, code: 'DURATION_TOO_LONG' };

  return {
    ok: true,
    value: {
      groupId,
      name,
      description,
      startTime: body.startTime,
      endTime: body.endTime,
    },
  };
}

export async function sendEventMessage(req: Request, res: Response) {
  /**
   * #swagger.ignore = true
   */
  const session = req.session;
  const startedAt = Date.now();

  const v = validateEventPayload(req.body);
  if (!v.ok) return res.status(400).json({ status: 'error', code: v.code });

  const page = (req.client as any)?.page;
  if (!page || typeof page.evaluate !== 'function') {
    return res.status(409).json({ status: 'error', code: 'SESSION_NOT_READY' });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Chamada ÚNICA. Só os campos da V1 são repassados (sem location/callType).
    const evaluation = page.evaluate(async (p: EventPayload) => {
      const w = window as any;
      if (!w.WPP?.chat?.sendEventMessage) return { __missing: true };
      const opts: any = {
        name: p.name,
        startTime: p.startTime,
        endTime: p.endTime,
      };
      if (p.description) opts.description = p.description;
      const r = await w.WPP.chat.sendEventMessage(p.groupId, opts);
      return { id: typeof r?.id === 'string' ? r.id : null };
    }, v.value);

    // Timeout só abandona a espera; NÃO cancela nem repete a chamada.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('EVENT_TIMEOUT')),
        EVENT_TIMEOUT_MS
      );
    });

    const data: any = await Promise.race([evaluation, timeout]);
    if (data?.__missing) {
      return res
        .status(501)
        .json({ status: 'error', code: 'EVENT_FUNCTION_UNAVAILABLE' });
    }
    if (!data?.id) {
      // Pode ter sido criado, mas sem ID confirmado → incerto, nunca repetir.
      req.logger.warn(
        `[events] send-event session=${session} code=NO_MESSAGE_ID ms=${
          Date.now() - startedAt
        }`
      );
      return res
        .status(502)
        .json({ status: 'error', code: 'EVENT_RESULT_UNCONFIRMED' });
    }

    req.logger.info(
      `[events] send-event session=${session} ok ms=${Date.now() - startedAt}`
    );
    // Mesmo envelope das rotas de envio (Central lê response[0].id).
    return res
      .status(201)
      .json({ status: 'success', response: [{ id: data.id }] });
  } catch (error: any) {
    const msg = String(error?.message ?? '');
    const timedOut = msg === 'EVENT_TIMEOUT';
    const code = timedOut
      ? 'EVENT_RESULT_UNCONFIRMED'
      : /can_not_send_message_to_this_groupType/i.test(msg)
      ? 'GROUP_TYPE_NOT_ALLOWED'
      : /chat.*not.*found|not ?found/i.test(msg)
      ? 'GROUP_NOT_FOUND'
      : 'EVENT_ERROR';
    // Só código e duração: nunca a mensagem bruta nem stack.
    req.logger.warn(
      `[events] send-event session=${session} code=${code} ms=${
        Date.now() - startedAt
      }`
    );
    const status = timedOut
      ? 504
      : code === 'GROUP_NOT_FOUND'
      ? 404
      : code === 'GROUP_TYPE_NOT_ALLOWED'
      ? 422
      : 500;
    return res.status(status).json({ status: 'error', code });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
