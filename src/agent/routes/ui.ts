import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentRoutesOptions } from "./agent.js";
import { hasAdminKey, secretMatches } from "./auth.js";
import { budgetSchema, submitSchema } from "../coordinator/coordinator.js";
import { agentPage } from "./ui-page.js";

const COOKIE = "gateway_agent_session";
const IDLE = 30 * 60 * 1000;
const ABSOLUTE = 8 * 60 * 60 * 1000;
interface Session { csrf: string; created: number; touched: number }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const submit = z.object({
  goal: z.string().trim().min(1).max(4000),
  budget: budgetSchema.optional(),
}).strict();

export const agentUiRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, runtime) => {
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; until: number }>();
  const recent: string[] = [];
  const secure = (r: FastifyRequest) => r.protocol === "https" || r.headers["x-forwarded-proto"] === "https";
  const local = (r: FastifyRequest) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(r.ip) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(r.hostname);
  const cookie = (r: FastifyRequest, value: string, maxAge: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/admin/agent; Max-Age=${maxAge}${secure(r) ? "; Secure" : ""}`;
  function session(r: FastifyRequest): Session | undefined {
    const value = r.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value) return;
    const key = hash(value), s = sessions.get(key), now = Date.now();
    if (!s) return;
    if (now - s.touched >= IDLE || now - s.created >= ABSOLUTE) { sessions.delete(key); return; }
    s.touched = now;
    return s;
  }
  function newSession(r: FastifyRequest, reply: FastifyReply): Session {
    const now = Date.now();
    for (const [key, s] of sessions) if (now - s.touched >= IDLE || now - s.created >= ABSOLUTE) sessions.delete(key);
    if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    const s = { csrf: randomBytes(32).toString("hex"), created: now, touched: now };
    sessions.set(hash(token), s);
    reply.header("Set-Cookie", cookie(r, token, ABSOLUTE / 1000));
    return s;
  }
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 8192 }, (_r, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
    if (!secure(request) && !local(request)) return reply.code(403).send({ error: "HTTPS required" });
  });
  app.setErrorHandler((_error, _request, reply) => {
    if (!reply.sent) void reply.code(400).send({ error: "Agent UI request rejected" });
  });
  app.get("", async (request, reply) => {
    const nonce = randomBytes(24).toString("base64");
    reply.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`);
    return reply.type("text/html; charset=utf-8").send(agentPage(nonce, Boolean(session(request))));
  });
  app.post("/login", async (request, reply) => {
    // Block cross-site login forms as well as cross-site scripted requests.
    const origin = request.headers.origin;
    if (request.headers["sec-fetch-site"] === "cross-site" ||
      (origin && origin !== `${secure(request) ? "https" : "http"}://${request.headers.host}`))
      return reply.code(403).send({ error: "Invalid origin" });
    const now = Date.now();
    for (const [ip, entry] of failures) if (entry.until <= now) failures.delete(ip);
    const prior = failures.get(request.ip);
    if (prior && prior.count >= 5) return reply.header("Retry-After", Math.ceil((prior.until - now) / 1000)).code(429).send({ error: "Try again later" });
    const body = z.object({ adminKey: z.string().max(4096) }).safeParse(request.body);
    if (!body.success || !secretMatches(body.data.adminKey, runtime.adminApiKey)) {
      if (failures.size >= 4096 && !prior) failures.delete(failures.keys().next().value!);
      failures.set(request.ip, { count: (prior?.count ?? 0) + 1, until: prior?.until ?? now + 60000 });
      return reply.code(401).send({ error: "Invalid admin key" });
    }
    failures.delete(request.ip);
    newSession(request, reply);
    return reply.code(303).header("Location", "/admin/agent/ui").send();
  });
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path?.startsWith("/admin/agent/ui/api/") && path !== "/admin/agent/ui/logout") return;
    const s = session(request);
    if (!s && !hasAdminKey(request, runtime.adminApiKey)) return reply.code(401).send({ error: "Unauthorized" });
    if (request.method !== "GET" && (!s || !secretMatches(request.headers["x-csrf-token"], s.csrf)))
      return reply.code(403).send({ error: "CSRF token required" });
  });
  app.get("/api/session", async (request, reply) => ({ csrfToken: (session(request) ?? newSession(request, reply)).csrf }));
  app.post("/logout", async (request, reply) => {
    const s = session(request);
    for (const [key, value] of sessions) if (value === s) sessions.delete(key);
    return reply.header("Set-Cookie", cookie(request, "", 0)).send({ ok: true });
  });
  app.post("/api/submit", async request => {
    const input = submit.parse(request.body);
    const task = submitSchema.parse({ ...input, acceptance: [], effect: "read", tier: "R0" });
    const envelope = runtime.sealer.seal(task, "agent:submit");
    const job = await runtime.coordinator.submit(runtime.sealer.open(envelope, "agent:submit"));
    recent.unshift(job.jobId);
    recent.length = Math.min(recent.length, 50);
    return { jobId: job.jobId, state: job.state };
  });
  const status = (id: string) => {
    const job = runtime.coordinator.status(id);
    return { jobId: job.jobId, state: job.state, children: job.children.map(jobId => {
      const child = runtime.delegate.status({ jobId });
      return { jobId, state: child.state, failure: child.failure, lastEventSeq: child.lastEventSeq };
    }) };
  };
  app.get("/api/jobs", async () => ({ jobs: recent.map(status) }));
  app.get<{ Params: { id: string } }>("/api/jobs/:id/status", async r => status(r.params.id));
  // Logs and controls use delegate ids from the coordinator status children.
  app.get<{ Params: { id: string }; Querystring: { fromSeq?: string; toSeq?: string } }>("/api/jobs/:id/log", async r =>
    runtime.delegate.log({ jobId: r.params.id, fromSeq: Number(r.query.fromSeq ?? 0), toSeq: r.query.toSeq === undefined ? undefined : Number(r.query.toSeq) }));
  app.post<{ Params: { id: string } }>("/api/jobs/:id/stop", async r => {
    const job = runtime.delegate.stop({ jobId: r.params.id, reason: "operator" });
    return { jobId: job.jobId, state: job.state };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/summarize", async r => runtime.delegate.summarize({ jobId: r.params.id }));
  app.get("/api/inbox", async () => ({ items: runtime.inbox.list() }));
  app.post<{ Params: { id: string } }>("/api/inbox/:id/approve", async r => {
    const item = runtime.inbox.approve(r.params.id);
    const action = item.action as { jobId?: string };
    if (action.jobId) await runtime.coordinator.advance(action.jobId);
    return { id: item.id, state: item.state };
  });
  app.post<{ Params: { id: string } }>("/api/inbox/:id/deny", async r => {
    const item = runtime.inbox.deny(r.params.id);
    return { id: item.id, state: item.state };
  });
  app.addHook("onClose", async () => { sessions.clear(); failures.clear(); });
};
