// POST /api/check
// Body: { wereadKey: string }
// Returns: { totalBookCount: number }
// Used after the user submits their Key, so the frontend can render the correct tier selector.

import { getNotebooksTotal } from "../../lib/weread.ts";

export async function onRequestPost(context: { request: Request }): Promise<Response> {
  try {
    const { wereadKey } = await context.request.json() as { wereadKey?: string };
    if (!wereadKey || !wereadKey.startsWith("wrk-")) {
      return json({ error: "无效的 API Key 格式，应以 wrk- 开头" }, 400);
    }
    const totalBookCount = await getNotebooksTotal(wereadKey);
    return json({ totalBookCount });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
