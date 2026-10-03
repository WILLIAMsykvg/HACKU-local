/**
 * 本地服务器：node:http，不引入框架。
 * 每个访客一套独立状态（cookie 区分），全部在内存里；前端打包后的静态文件也由这里托管。
 *
 * 运行：node --env-file-if-exists=.env src/server/server.ts
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { Bundle } from "../attest/types.ts";
import { parseLang, setLangSource, t, type Lang } from "../i18n.ts";
import { verifyChain } from "../log/chain.ts";
import { SERVER_KEYS, Session } from "./session.ts";

/** 每个请求（以及它发起的代理运行）用请求自己的语言 */
const requestLang = new AsyncLocalStorage<Lang>();
setLangSource(() => requestLang.getStore() ?? "zh");

const PORT = Number(process.env["PORT"] ?? 8787);
const DEEPSEEK_KEY = process.env["DEEPSEEK_API_KEY"];
const TAVILY_KEY = process.env["TAVILY_API_KEY"];
const STRIPE_KEY = process.env["STRIPE_SECRET_KEY"];
const SERP_KEY = process.env["SERPAPI_KEY"];
const ACCESS_CODE = process.env["DEMO_ACCESS_CODE"];
const MAX_LLM_RUNS_PER_SESSION = 20;
const SESSION_IDLE_MS = 6 * 3600_000;

const STATIC_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));

const sessions = new Map<string, Session>();

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}, 10 * 60_000).unref();

function sessionFor(req: IncomingMessage, res: ServerResponse): Session {
  const sid = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  let s = sid ? sessions.get(sid) : undefined;
  if (!s) {
    s = new Session();
    sessions.set(s.id, s);
    res.setHeader("Set-Cookie", `sid=${s.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=21600`);
  }
  s.lastSeen = Date.now();
  return s;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error(t("请求太大", "Request too large"));
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const safe = normalize(path).replace(/^([/\\])+/, "");
  let file = join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(STATIC_DIR, "index.html");
  }
  if (!existsSync(file)) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("前端还没打包：先运行 npm run build。接口在 /api/state。");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function sse(req: IncomingMessage, res: ServerResponse, s: Session): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write("state", s.publicState());
  const off = s.subscribe(write);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    off();
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (!p.startsWith("/api/")) return serveStatic(req, res);

  const s = sessionFor(req, res);
  const m = req.method ?? "GET";

  if (m === "GET" && p === "/api/events") return sse(req, res, s);
  if (m === "GET" && p === "/api/state") return send(res, 200, s.publicState());
  if (m === "GET" && p === "/api/config") {
    return send(res, 200, {
      llm_available: Boolean(DEEPSEEK_KEY),
      llm_requires_code: Boolean(ACCESS_CODE),
      search_live: Boolean(TAVILY_KEY),
      reference_via: SERP_KEY ? "serpapi" : TAVILY_KEY ? "tavily" : "none",
      stripe_test: Boolean(STRIPE_KEY?.startsWith("sk_test_")),
    });
  }
  if (m === "GET" && p === "/api/keys") {
    return send(res, 200, {
      bank: SERVER_KEYS.bank.publicKey,
      merchant: SERVER_KEYS.merchant.publicKey,
      location: s.deviceKey,
      note: t(
        "Ed25519 公钥（JWK 的 x，base64url）。定位那把是这台设备在强认证时登记的。",
        "Ed25519 public keys (JWK x, base64url). The location key is the one this device registered at strong authentication.",
      ),
    });
  }
  if (m === "GET" && p === "/api/log") return send(res, 200, { log: s.log, chain: verifyChain(s.log) });

  if (m !== "POST") return send(res, 404, { error: t("没有这个接口", "No such endpoint") });
  const body = await readJson(req);

  if (p === "/api/auth/strong") {
    const key = typeof body["device_key"] === "string" ? body["device_key"] : null;
    s.strongAuth(key);
    return send(res, 200, s.publicState());
  }
  if (p === "/api/clock") {
    const h = Number(body["offset_hours"] ?? 0);
    if (!Number.isFinite(h) || h < 0 || h > 48) return send(res, 400, { error: t("offset_hours 要在 0 到 48 之间", "offset_hours must be between 0 and 48") });
    s.setClockOffset(h);
    return send(res, 200, s.publicState());
  }
  if (p === "/api/mandate/revoke") {
    s.revoke();
    return send(res, 200, s.publicState());
  }
  if (p === "/api/mandate/restore") {
    s.restoreMandate();
    return send(res, 200, s.publicState());
  }
  if (p === "/api/reset") {
    sessions.delete(s.id);
    res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
    return send(res, 200, { ok: true });
  }

  if (p === "/api/agent/run") {
    const mode = body["mode"] === "llm" ? "llm" : "scripted";
    const prompt = String(body["prompt"] ?? "").slice(0, 300).trim();
    if (!prompt) return send(res, 400, { error: t("先告诉代理要买什么", "Tell the agent what to buy first") });
    if (mode === "llm") {
      if (!DEEPSEEK_KEY) return send(res, 400, { error: t("服务器没有配置大模型", "No language model is configured on the server") });
      if (ACCESS_CODE && body["access_code"] !== ACCESS_CODE) return send(res, 403, { error: t("大模型模式需要访问码", "DeepSeek mode needs the access code") });
      if (s.llmRuns >= MAX_LLM_RUNS_PER_SESSION) {
        return send(res, 429, { error: t("这个会话的大模型次数用完了，请用脚本模式", "This session has used up its DeepSeek runs; use scripted mode") });
      }
    }
    if (s.agentBusy) return send(res, 409, { error: t("代理正在工作", "The agent is still working") });
    send(res, 202, { started: true });
    s.runAgent({ mode, prompt, injection: body["injection"] === true, deepseekKey: DEEPSEEK_KEY, tavilyKey: TAVILY_KEY, serpKey: SERP_KEY })
      .catch((e: Error) => s.emit("agent", { kind: "say", text: t(`代理出错了：${e.message}`, `The agent hit an error: ${e.message}`) }))
      .finally(() => s.emit("state", s.publicState()));
    return;
  }

  const om = /^\/api\/orders\/(ord_[\w-]+)\/(claims|submit|consent|tamper-ship-to)$/.exec(p);
  if (om) {
    const [, id, action] = om as unknown as [string, string, string];
    if (action === "claims") return send(res, 200, await s.issueServerClaims(id));
    if (action === "tamper-ship-to") return send(res, 200, s.publicOrder(s.tamperShipTo(id)));
    if (action === "submit") {
      const order = await s.submitBundle(id, body["bundle"] as Bundle, STRIPE_KEY);
      return send(res, 200, s.publicOrder(order));
    }
    if (action === "consent") {
      const r = await s.consent(id, Number(body["latency_ms"] ?? 0), STRIPE_KEY);
      return send(res, 200, { order: s.publicOrder(r.order), message: r.message });
    }
  }
  return send(res, 404, { error: t("没有这个接口", "No such endpoint") });
}

function langOf(req: IncomingMessage): Lang {
  const header = req.headers["x-lang"];
  const query = new URL(req.url ?? "/", "http://x").searchParams.get("lang");
  return parseLang(typeof header === "string" ? header : query);
}

createServer((req, res) => {
  requestLang.run(langOf(req), () =>
    route(req, res).catch((e: Error) => {
      if (!res.headersSent) send(res, 400, { error: e.message });
      else res.end();
    }),
  );
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  console.log(
    `大模型：${DEEPSEEK_KEY ? "已配置" : "未配置"} · 联网搜索：${TAVILY_KEY ? "已配置" : "未配置"} · ` +
      `参考价：${SERP_KEY ? "SerpAPI" : TAVILY_KEY ? "Tavily 摘要" : "无"} · Stripe：${STRIPE_KEY ? "已配置" : "模拟"}`,
  );
});
