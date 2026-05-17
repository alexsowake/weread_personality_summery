// POST /api/analyze
// Body: { wereadKey: string, tier: "lt20" | "20" | "30" | "40" | "50" }
// Returns: SSE stream of ProgressEvent JSON (one per `data:` line).
//
// DeepSeek credentials come from EdgeOne environment vars:
//   DEEPSEEK_API_KEY     — bearer token
//   DEEPSEEK_FLASH_MODEL — model id for Stage 1 (e.g. "deepseek-chat")
//   DEEPSEEK_PRO_MODEL   — model id for Stage 2 (e.g. "deepseek-reasoner")

import { run, type ProgressEvent } from "../../lib/pipeline.ts";

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

  let body: { wereadKey?: string; tier?: string };
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: "请求体不是有效的 JSON" }), { status: 400 });
  }

  const wereadKey = body.wereadKey;
  const tier = body.tier as any;
  if (!wereadKey || !wereadKey.startsWith("wrk-")) {
    return new Response(JSON.stringify({ error: "无效的 WeRead API Key" }), { status: 400 });
  }
  if (!["lt20", "20", "30", "40", "50"].includes(tier)) {
    return new Response(JSON.stringify({ error: "无效的档位" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        const payload = `data: ${JSON.stringify(e)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };
      // Heartbeat to keep proxies from buffering (every 15s).
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
      }, 15000);

      try {
        await run({
          wereadKey,
          tier,
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
    },
  });
}
