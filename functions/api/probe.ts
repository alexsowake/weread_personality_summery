// GET /api/probe — diagnostic: emits SSE event immediately, waits 20s, emits again.
// Tests whether EdgeOne has a hard wall-clock limit (~15s) or a TTFB/idle timeout.
//
// Expected results:
//   If 2nd event arrives after 20s → TTFB timeout (fixable by emitting early)
//   If connection drops ~15-16s → hard wall-clock limit (must switch strategy)

export async function onRequestGet(context: { env: Record<string, string | undefined> }): Promise<Response> {
  const env = context.env || {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: string) => {
        controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
      };

      send(JSON.stringify({
        t: 0,
        msg: "probe_start",
        ts: Date.now(),
        env: {
          flash: env.DEEPSEEK_FLASH_MODEL || "(unset)",
          pro: env.DEEPSEEK_PRO_MODEL || "(unset)",
          hasKey: !!env.DEEPSEEK_API_KEY,
        },
      }));

      await new Promise((r) => setTimeout(r, 20_000));

      send(JSON.stringify({ t: 20, msg: "probe_20s", ts: Date.now() }));

      controller.close();
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
