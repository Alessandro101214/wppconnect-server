/*
 * CUSTOMIZAÇÃO LOCAL (não oficial) — Central de Automação WhatsApp.
 * Rota somente leitura: GET /api/:session/message-ack/:messageId
 * Executa WPP.chat.getMessageACK(messageId) na página da sessão JÁ conectada.
 * Não abre navegador/cliente/sessão, não envia, não marca como lido, não altera nada.
 * Nunca registra Authorization, token, SECRET_KEY nem IDs de participantes.
 */
import { Request, Response } from 'express';

const ACK_TIMEOUT_MS = 20_000;
// IDs de mensagem do WhatsApp, ex.: true_<chat>@g.us_<hash>_<sender>@lid
const MESSAGE_ID_RE = /^(true|false)_[\w.@-]+_[\w.@-]+$/;

export async function getMessageAck(req: Request, res: Response) {
  /**
   * #swagger.ignore = true
   */
  const session = req.session;
  const { messageId } = req.params;
  const startedAt = Date.now();

  if (!messageId || messageId.length > 256 || !MESSAGE_ID_RE.test(messageId)) {
    return res.status(400).json({ status: 'error', code: 'INVALID_MESSAGE_ID' });
  }

  // Página do navegador da sessão já existente (HostLayer.page). Nada é criado.
  const page = (req.client as any)?.page;
  if (!page || typeof page.evaluate !== 'function') {
    return res.status(409).json({ status: 'error', code: 'SESSION_NOT_READY' });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const evaluation = page.evaluate(async (id: string) => {
      const w = window as any;
      if (!w.WPP?.chat?.getMessageACK) return { __missing: true };
      const r = await w.WPP.chat.getMessageACK(id);
      const n = (v: unknown) => (typeof v === 'number' ? v : null);
      return {
        ack: n(r?.ack),
        fromMe: typeof r?.fromMe === 'boolean' ? r.fromMe : null,
        deliveryRemaining: n(r?.deliveryRemaining),
        readRemaining: n(r?.readRemaining),
        playedRemaining: n(r?.playedRemaining),
        participants: Array.isArray(r?.participants)
          ? r.participants.map((p: any) => ({
              id: typeof p?.id === 'string' ? p.id : null,
              deliveredAt: n(p?.deliveredAt),
              readAt: n(p?.readAt),
              playedAt: n(p?.playedAt),
            }))
          : null,
      };
    }, messageId);

    // Timeout só abandona a espera desta requisição; não toca na sessão/navegador.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ACK_TIMEOUT')), ACK_TIMEOUT_MS);
    });

    const data: any = await Promise.race([evaluation, timeout]);
    if (data?.__missing) {
      return res
        .status(501)
        .json({ status: 'error', code: 'ACK_FUNCTION_UNAVAILABLE' });
    }

    req.logger.info(
      `[insights] message-ack session=${session} participants=${
        data?.participants?.length ?? 'null'
      } ms=${Date.now() - startedAt}`
    );
    return res.status(200).json({ status: 'success', messageId, data });
  } catch (error: any) {
    const msg = String(error?.message ?? '');
    const timedOut = msg === 'ACK_TIMEOUT';
    const notFound = !timedOut && /not ?found/i.test(msg);
    const code = timedOut ? 'ACK_TIMEOUT' : notFound ? 'MESSAGE_NOT_FOUND' : 'ACK_ERROR';

    // Só código e duração: nunca a mensagem bruta (pode conter IDs).
    req.logger.warn(
      `[insights] message-ack session=${session} code=${code} ms=${Date.now() - startedAt}`
    );

    return res
      .status(timedOut ? 504 : notFound ? 404 : 500)
      .json({ status: 'error', code });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
