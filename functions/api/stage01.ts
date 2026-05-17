// POST /api/stage01
// Body: { wereadKey: string, count: number }
// Returns: SSE stream — status/progress/meta/summaries events.
//
// The final `summaries` event contains the Stage01Result JSON, which the
// client must POST to /api/stage2 to produce the portrait.

import { runStage01, type ProgressEvent } from "../../lib/pipeline.ts";

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

  let body: { wereadKey?: string; count?: number };
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "请求体不是有效的 JSON" }), { status: 400 });
  }

  const wereadKey = body.wereadKey;
  const count = body.count;
  if (!wereadKey || !wereadKey.startsWith("wrk-")) {
    return new Response(JSON.stringify({ error: "无效的 WeRead API Key" }), { status: 400 });
  }
  if (typeof count !== "number" || count < 1 || count > 50) {
    return new Response(JSON.stringify({ error: "无效的 count" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      send({ type: "status", message: "正在启动..." });
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`data: {"type":"ping"}\n\n`)); } catch {}
      }, 5000);

      try {
        await runStage01({
          wereadKey,
          count,
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
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      // Critical: EdgeOne applies Brotli to text/* by default, which buffers
      // the entire SSE stream until enough data accumulates for a compressed
      // block. Declaring identity disables that.
      "Content-Encoding": "identity",
    },
  });
}
