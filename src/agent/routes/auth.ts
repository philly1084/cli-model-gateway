import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function secretMatches(actual: unknown, configured: string | undefined): boolean {
  if (!configured || typeof actual !== "string") return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(actual), hash(configured));
}

export function hasAdminKey(request: FastifyRequest, configured: string | undefined): boolean {
  const auth = request.headers.authorization;
  const key = request.headers["x-admin-key"] ??
    (auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : undefined);
  return secretMatches(key, configured);
}
