import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { TokenSigner, verifyPassword } from "../auth.ts";
import { openDb } from "../db.ts";
import { MemoryStore, MemoryValidationError, type Source } from "../memory.ts";
import { HistoryStore } from "../history.ts";
import { parseCommand } from "../commands.ts";
import { runAssistant } from "../assistant.ts";
import { RunLog } from "../log.ts";
import type { ModelClient } from "../model/types.ts";

/**
 * Small HTTP API. Identity comes from exactly one place: the signed bearer token. Request bodies
 * are strict schemas, so a body that tries to name a user (owner, user_id, ...) is rejected, and
 * query strings are never read. Every store call passes the token's user id as the owner.
 *
 * Cross-user access returns 404, not 403: the API answers "no such item for you" whether the id
 * belongs to someone else or to nobody, so ids of other users cannot be probed.
 */

export interface AppOptions {
  dbPath: string;
  signer?: TokenSigner;
  model: () => ModelClient;
  /** JSONL file for run logs and API events. Omit to keep logs in memory only. */
  logFile?: string;
  db?: DatabaseSync;
  port?: number;
}

export interface App {
  url: string;
  close(): Promise<void>;
  /** Server-level event log (logins, API writes, denials). Chat runs get their own RunLog. */
  events: RunLog;
  runs: RunLog[];
  memory: MemoryStore;
  history: HistoryStore;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly issues?: unknown) {
    super(message);
  }
}

const IDENTITY_FIELDS = ["owner", "user", "user_id", "userId", "sub", "uid"];

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  if (body && typeof body === "object") {
    const named = IDENTITY_FIELDS.filter((f) => f in (body as object));
    if (named.length) throw new HttpError(400, "IDENTITY_IN_BODY", `field ${named.join(", ")} is not accepted: the user is taken from the bearer token only`);
  }
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, "INVALID_BODY", "request body did not match the schema", r.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })));
  return r.data;
}

const Login = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();
const Remember = z.object({ key: z.string(), value: z.string() }).strict();
const Correct = z.object({ value: z.string() }).strict();
const Chat = z
  .object({
    message: z.string().min(1).max(4000),
    conversation_id: z.string().optional(),
    documents: z.array(z.object({ name: z.string().min(1).max(120), text: z.string().max(20000) }).strict()).max(5).optional(),
  })
  .strict();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "BODY_TOO_LARGE", "body over 256 KiB");
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "body is not valid JSON");
  }
}

export async function startApp(opts: AppOptions): Promise<App> {
  const db = opts.db ?? openDb(opts.dbPath);
  const signer = opts.signer ?? TokenSigner.random();
  const memory = new MemoryStore(db);
  const history = new HistoryStore(db);
  const events = new RunLog(opts.logFile);
  const runs: RunLog[] = [];
  const userExists = db.prepare("SELECT username FROM users WHERE id = ?");
  const userByName = db.prepare("SELECT id, pw_salt, pw_hash FROM users WHERE username = ?");

  function authenticate(req: IncomingMessage): { userId: string; sid: string } {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (\S+)$/.exec(h);
    if (!m) throw new HttpError(401, "MISSING_TOKEN", "Authorization: Bearer <token> required. Get one from POST /login.");
    const v = signer.verify(m[1]!);
    if (!v.ok) throw new HttpError(401, `TOKEN_${v.reason.toUpperCase()}`, `token rejected: ${v.reason}`);
    if (!userExists.get(v.payload.sub)) throw new HttpError(401, "TOKEN_UNKNOWN_USER", "token names no known user");
    return { userId: v.payload.sub, sid: v.payload.sid };
  }

  async function route(req: IncomingMessage, reqId: string): Promise<{ status: number; body?: unknown; user?: string }> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname; // url.searchParams is deliberately never read
    const method = req.method ?? "GET";

    if (method === "POST" && path === "/login") {
      const b = parseBody(Login, await readJson(req));
      const u = userByName.get(b.username) as { id: string; pw_salt: string; pw_hash: string } | undefined;
      if (!u || !verifyPassword(b.password, u.pw_salt, u.pw_hash)) {
        events.write({ type: "login_failed", req: reqId, username: b.username });
        throw new HttpError(401, "BAD_CREDENTIALS", "unknown user or wrong password");
      }
      const { token, payload } = signer.issue(u.id);
      events.write({ type: "login", req: reqId, user: u.id, sid: payload.sid });
      return { status: 200, user: u.id, body: { token, user_id: u.id, expires_at: new Date(payload.exp * 1000).toISOString(), auth: "test-only HMAC token" } };
    }
    if (method === "GET" && path === "/health") return { status: 200, body: { ok: true, pid: process.pid } };

    const { userId, sid } = authenticate(req);
    const apiSource = (): Source => ({ kind: "api", ref: reqId });
    const memId = /^\/memories\/([A-Za-z0-9_]+)$/.exec(path)?.[1];
    const convId = /^\/conversations\/([A-Za-z0-9_]+)\/messages$/.exec(path)?.[1];

    if (method === "GET" && path === "/me") return { status: 200, user: userId, body: { user_id: userId, username: (userExists.get(userId) as { username: string }).username, session: sid } };

    if (method === "GET" && path === "/memories") {
      const items = memory.list(userId);
      events.write({ type: "memory_read", req: reqId, owner: userId, via: "api", items: items.map((i) => i.id) });
      return { status: 200, user: userId, body: { items } };
    }
    if (method === "POST" && path === "/memories") {
      const b = parseBody(Remember, await readJson(req));
      const r = memory.remember(userId, b.key, b.value, apiSource());
      events.write({ type: "memory_write", req: reqId, owner: userId, action: r.action, item: r.item.id, key: r.item.key, value: r.item.value, version: r.item.version, source: r.item.source });
      return { status: r.action === "created" ? 201 : 200, user: userId, body: r };
    }
    if (memId && method === "GET") {
      const item = memory.get(userId, memId);
      if (!item) throw notFound(userId, memId, reqId, "read");
      events.write({ type: "memory_read", req: reqId, owner: userId, via: "api", items: [item.id] });
      return { status: 200, user: userId, body: { item } };
    }
    if (memId && method === "PATCH") {
      const b = parseBody(Correct, await readJson(req));
      const item = memory.correct(userId, memId, b.value, apiSource());
      if (!item) throw notFound(userId, memId, reqId, "update");
      events.write({ type: "memory_write", req: reqId, owner: userId, action: "corrected", item: item.id, key: item.key, value: item.value, version: item.version, source: item.source });
      return { status: 200, user: userId, body: { item } };
    }
    if (memId && method === "DELETE") {
      if (!memory.forget(userId, memId, apiSource())) throw notFound(userId, memId, reqId, "delete");
      events.write({ type: "memory_delete", req: reqId, owner: userId, item: memId, source: apiSource() });
      return { status: 204, user: userId };
    }
    if (convId && method === "GET") {
      const messages = history.messages(userId, convId);
      if (!messages) throw notFound(userId, convId, reqId, "read_history");
      return { status: 200, user: userId, body: { messages } };
    }
    if (method === "POST" && path === "/chat") return chat(userId, sid, reqId, parseBody(Chat, await readJson(req)));

    throw new HttpError(404, "NOT_FOUND", `no route ${method} ${path}`);
  }

  function notFound(userId: string, id: string, reqId: string, op: string) {
    events.write({ type: "access_denied_or_missing", req: reqId, user: userId, target: id, op, status: 404 });
    return new HttpError(404, "NOT_FOUND", `no ${id.startsWith("conv_") ? "conversation" : "memory item"} ${id} for this user`);
  }

  async function chat(userId: string, sid: string, reqId: string, b: z.infer<typeof Chat>) {
    let conversationId = b.conversation_id;
    if (conversationId && !history.owns(userId, conversationId)) throw notFound(userId, conversationId, reqId, "chat");
    conversationId ??= history.create(userId);
    const prior = history.messages(userId, conversationId) ?? [];
    const userMsg = history.append(userId, conversationId, "user", b.message);
    for (const d of b.documents ?? []) history.append(userId, conversationId, "document", d.text, d.name);

    // Commands are parsed from the user's own message text only, before any model runs.
    const cmd = parseCommand(b.message);
    if (cmd) {
      const source: Source = { kind: "chat_command", ref: userMsg.id };
      let reply: string;
      let status = 200;
      if (cmd.kind === "malformed") {
        reply = cmd.message;
        status = 400;
      } else if (cmd.kind === "list") {
        const items = memory.list(userId);
        events.write({ type: "memory_read", req: reqId, owner: userId, via: "command", items: items.map((i) => i.id) });
        reply = items.length ? items.map((i) => `${i.key}: ${i.value} (v${i.version}, ${i.id})`).join("\n") : "No saved memory.";
      } else if (cmd.kind === "remember") {
        try {
          const r = memory.remember(userId, cmd.key, cmd.value, source);
          events.write({ type: "memory_write", req: reqId, owner: userId, action: r.action, item: r.item.id, key: r.item.key, value: r.item.value, version: r.item.version, source });
          reply = `${r.action === "created" ? "Saved" : r.action === "corrected" ? "Corrected" : "Unchanged"}: ${r.item.key} = ${r.item.value} (v${r.item.version}, ${r.item.id})`;
        } catch (e) {
          if (!(e instanceof MemoryValidationError)) throw e;
          reply = `Not saved: ${e.message}`;
          status = 400;
        }
      } else {
        const item = memory.getByKey(userId, cmd.key);
        if (item && memory.forget(userId, item.id, source)) {
          events.write({ type: "memory_delete", req: reqId, owner: userId, item: item.id, key: item.key, source });
          reply = `Deleted: ${item.key} (${item.id})`;
        } else {
          reply = `Nothing saved under ${cmd.key}.`;
          status = 404;
        }
      }
      const a = history.append(userId, conversationId, "assistant", reply);
      return { status, user: userId, body: { kind: "command", conversation_id: conversationId, message_id: userMsg.id, reply_id: a.id, reply } };
    }

    const log = new RunLog(opts.logFile);
    runs.push(log);
    log.write({ type: "chat", req: reqId, owner: userId, sid, conversation_id: conversationId, message_id: userMsg.id });
    const r = await runAssistant({ owner: userId, message: b.message, documents: b.documents, history: prior }, { model: opts.model(), memory, log });
    const reply = r.answer?.text ?? `No answer (status ${r.status}).`;
    const a = history.append(userId, conversationId, "assistant", reply);
    return {
      status: 200,
      user: userId,
      body: { kind: "assistant", conversation_id: conversationId, message_id: userMsg.id, reply_id: a.id, reply, run_id: r.runId, status: r.status, answer: r.answer, memory_read: r.memoryRead, tool_errors: r.toolErrors },
    };
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqId = `req_${randomBytes(5).toString("hex")}`;
    let status = 500;
    let user: string | undefined;
    let payload: unknown;
    try {
      const out = await route(req, reqId);
      ({ status, user } = out);
      payload = out.body;
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        payload = { error: { code: e.code, message: e.message, ...(e.issues ? { issues: e.issues } : {}) } };
      } else if (e instanceof MemoryValidationError) {
        status = 400;
        payload = { error: { code: "INVALID_MEMORY", message: e.message } };
      } else {
        payload = { error: { code: "INTERNAL", message: (e as Error).message } };
      }
    }
    events.write({ type: "http", req: reqId, method: req.method, path: new URL(req.url ?? "/", "http://local").pathname, status, user: user ?? null });
    res.writeHead(status, { "content-type": "application/json", "x-request-id": reqId });
    res.end(payload === undefined ? undefined : JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    runs,
    memory,
    history,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          if (!opts.db) db.close();
          resolve();
        });
      }),
  };
}
