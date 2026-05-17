// DeepSeek API client. Compatible with OpenAI Chat Completions schema.
// Endpoint: https://api.deepseek.com/v1/chat/completions
// Models (user-confirmed they're on DeepSeek V4 family):
//   - flash: fast/cheap for Stage 1 per-book summarization
//   - pro:   smart for Stage 2 final synthesis (streamed)

const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";

export interface DeepSeekConfig {
  apiKey: string;
  flashModel: string; // e.g. "deepseek-chat" or specific flash id
  proModel: string;   // e.g. "deepseek-reasoner" or specific pro id
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function complete(
  cfg: DeepSeekConfig,
  model: string,
  messages: Message[],
  opts: { temperature?: number; max_tokens?: number; response_format?: "json" } = {},
): Promise<string> {
  const body: any = {
    model,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.max_tokens ?? 1500,
    stream: false,
  };
  if (opts.response_format === "json") body.response_format = { type: "json_object" };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DeepSeek ${model} HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  return json.choices?.[0]?.message?.content ?? "";
}

// Streaming generator yielding text deltas.
export async function* completeStream(
  cfg: DeepSeekConfig,
  model: string,
  messages: Message[],
  opts: { temperature?: number; max_tokens?: number } = {},
): AsyncGenerator<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 4000,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`DeepSeek ${model} stream HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* ignore malformed line */ }
    }
  }
}
