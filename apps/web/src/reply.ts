import type { FastifyReply } from "fastify";

/**
 * Send the one error shape every route uses: {error: {code, message}}, plus a fixed `reason`
 * identifier where a route has one (never provider text).
 */
export function sendError(reply: FastifyReply, status: number, code: string, message: string, reason?: string): FastifyReply {
  const error = reason === undefined ? { code, message } : { code, message, reason };
  return reply.code(status).type("application/json").send({ error });
}
