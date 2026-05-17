// POST /api/stage2
// Body: { result: Stage01Result }
// Returns: SSE stream — status/portrait_delta/done events.

import { runStage2, type ProgressEvent, type Stage01Result } from "../../lib/pipeline.ts";

interface Env {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_FLASH_MODEL?: string;
  DEEPSEEK_PRO_MODEL?: string;
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const env = context.env || ({} as Env);
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "服务端未配置 DEEPSEEK_API_KEY" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let body: { result?: Stage01Result };
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "请求体不是有效的 JSON" }), { status: 400 });
  }

  const result = body.result;
  if (!result || !Array.isArray(result.summaries) || !result.meta) {
    return new Response(JSON.stringify({ error: "无效的 result 数据" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  // EdgeOne CDN force-applies Brotli regardless of Content-Type or
  // Content-Encoding: identity. Brotli buffers compressible (low-entropy)
  // text indefinitely. Workaround: pad every flush with ~16KB of random
  // base64 chars (high entropy) inside an SSE comment line. Brotli can't
  // compress randomness, so it must emit a block, which reaches the browser.
  const noise = (n: number): string => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * 62)];
    return s;
  };
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        // portrait_deltas arrive in rapid bursts and self-flush brotli blocks;
        // larger/infrequent events get noise padding to force an immediate flush.
        const pad = e.type === "portrait_delta" ? "" : `:${noise(16384)}\n`;
        controller.enqueue(encoder.encode(`${pad}data: ${JSON.stringify(e)}\n\n`));
      };
      send({ type: "status", message: "正在生成阅读人格画像..." });
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`:${noise(16384)}\ndata: {"type":"ping"}\n\n`)); } catch {}
      }, 3000);

      try {
        await runStage2({
          result,
          deepseek: {
            apiKey,
            flashModel: env.DEEPSEEK_FLASH_MODEL || "deepseek-chat",
            proModel: env.DEEPSEEK_PRO_MODEL || "deepseek-reasoner",
          },
          emit: send,
        });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      // EdgeOne CDN auto-applies Brotli compression to text/event-stream
      // (and ignores Content-Encoding: identity on responses), which buffers
      // the SSE stream until enough bytes accumulate for a brotli block —
      // making the browser see 0 body bytes for 60s, then time out.
      // Use application/octet-stream to bypass the text/* compression rule.
      // Frontend parses the SSE format manually; it doesn't need text/event-stream.
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
