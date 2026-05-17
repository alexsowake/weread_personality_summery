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
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
      }, 15000);

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
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
