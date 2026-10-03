/**
 * DeepSeek 聊天接口（OpenAI 兼容格式）。直接用 fetch，不装 SDK。
 * 关闭思考模式：代理要来回调用好几次工具，非思考模式更快更省。
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export const DEEPSEEK_MODEL = "deepseek-flash";

export async function chat(
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
): Promise<ChatResult> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      thinking: { type: "disabled" },
      temperature: 0.2,
      messages,
      tools,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DeepSeek 返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices: { message: ChatResult["message"]; finish_reason: string }[];
    usage?: ChatResult["usage"];
  };
  const c = data.choices[0];
  if (!c) throw new Error("DeepSeek 没有返回结果");
  return { message: c.message, finish_reason: c.finish_reason, usage: data.usage };
}
