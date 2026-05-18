// Node.js HTTP server (Hono) — replaces EdgeOne Pages Functions.
// Run: tsx server/index.ts (loads .env automatically via --env-file or dotenv).
//
// Endpoints:
//   POST /api/check    → { totalBookCount }
//   POST /api/stage01  → SSE: status/progress/meta/summaries
//   POST /api/stage2   → SSE: status/portrait_delta/done

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getNotebooksTotal } from "../lib/weread.ts";
import { runStage01, runStage2, type ProgressEvent, type Stage01Result } from "../lib/pipeline.ts";

const app = new Hono();

app.use("/api/*", cors({
  origin: (origin) => {
    if (!origin) return origin;
    // Allow EdgeOne preview / production domains and the apex aicw.me (for local browsing).
    if (/\.edgeone\.(dev|cool|app)$/.test(origin)) return origin;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    if (origin === "https://aicw.me" || origin === "https://www.aicw.me") return origin;
    if (origin === "https://read.aicw.me") return origin;
    if (origin === "https://wereadwave.cn" || origin === "https://www.wereadwave.cn") return origin;
    return null;
  },
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  maxAge: 86400,
}));

function deepseekCfg() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("服务端未配置 DEEPSEEK_API_KEY");
  return {
    apiKey,
    flashModel: process.env.DEEPSEEK_FLASH_MODEL || "deepseek-chat",
    proModel: process.env.DEEPSEEK_PRO_MODEL || "deepseek-reasoner",
  };
}

app.get("/health", (c) => c.text("ok"));

app.post("/api/check", async (c) => {
  try {
    const { wereadKey } = await c.req.json<{ wereadKey?: string }>();
    if (!wereadKey || !wereadKey.startsWith("wrk-")) {
      return c.json({ error: "无效的 API Key 格式，应以 wrk- 开头" }, 400);
    }
    const totalBookCount = await getNotebooksTotal(wereadKey);
    return c.json({ totalBookCount });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

app.post("/api/stage01", async (c) => {
  let body: { wereadKey?: string; count?: number };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "请求体不是有效的 JSON" }, 400); }

  const { wereadKey, count } = body;
  if (!wereadKey || !wereadKey.startsWith("wrk-")) return c.json({ error: "无效的 WeRead API Key" }, 400);
  if (typeof count !== "number" || count < 1 || count > 50) return c.json({ error: "无效的 count" }, 400);

  let cfg: ReturnType<typeof deepseekCfg>;
  try { cfg = deepseekCfg(); }
  catch (e: any) { return c.json({ error: e.message }, 500); }

  return streamSSE(c, async (stream) => {
    const send = (e: ProgressEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const heartbeat = setInterval(() => {
      stream.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(() => {});
    }, 15000);
    try {
      await send({ type: "status", message: "正在启动..." });
      await runStage01({ wereadKey, count, deepseek: cfg, emit: send });
      await stream.sleep(200); // flush pending writeSSE before stream closes
    } finally {
      clearInterval(heartbeat);
    }
  });
});

app.post("/api/stage2", async (c) => {
  let body: { result?: Stage01Result };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "请求体不是有效的 JSON" }, 400); }

  const result = body.result;
  if (!result || !Array.isArray(result.summaries) || !result.meta) {
    return c.json({ error: "无效的 result 数据" }, 400);
  }

  let cfg: ReturnType<typeof deepseekCfg>;
  try { cfg = deepseekCfg(); }
  catch (e: any) { return c.json({ error: e.message }, 500); }

  return streamSSE(c, async (stream) => {
    const send = (e: ProgressEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const heartbeat = setInterval(() => {
      stream.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(() => {});
    }, 15000);
    try {
      await send({ type: "status", message: "正在生成阅读人格画像..." });
      await runStage2({ result, deepseek: cfg, emit: send });
      await stream.sleep(200);
    } finally {
      clearInterval(heartbeat);
    }
  });
});

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`weread-summery API listening on http://127.0.0.1:${port}`);
