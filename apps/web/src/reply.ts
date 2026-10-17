import type { FastifyReply } from "fastify";

/** Send the one error shape every route uses: {error: {code, message}}. */
export function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).type("application/json").send({ error: { code, message } });
}
