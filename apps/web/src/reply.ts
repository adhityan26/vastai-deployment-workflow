import type { FastifyReply } from "fastify";

/**
 * Send the one error shape every route uses: {error: {code, message}}, plus a fixed `reason`
 * identifier where a route has one and a fixed `detail` sub-cause (never provider text).
 */
export function sendError(reply: FastifyReply, status: number, code: string, message: string, reason?: string, detail?: string): FastifyReply {
  const error = { code, message, ...(reason === undefined ? {} : { reason }), ...(detail === undefined ? {} : { detail }) };
  return reply.code(status).type("application/json").send({ error });
}
