/**
 * 从请求体 / 回复体里抽出「对话本身」：系统提示词、用户说了什么、回答了什么。
 * 工具定义、参数 schema、图片二进制全部丢弃 —— 它们占了日志体积的 60% 以上，
 * 却对"看对话"没有价值。
 */

export type Item =
  | { k: "user"; text: string }
  | { k: "assistant"; text: string }
  | { k: "tool_result"; count: number }
  | { k: "tool_call"; names: string[] };

export interface ReqView {
  system: string;
  items: Item[];
}

export interface ReplyView {
  text: string;
  reasoning: string;
  toolNames: string[];
  finish: string;
  usage: Record<string, number>;
}

type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/* ------------------------------ 请求 ------------------------------ */

export function extractRequest(body: unknown, fallbackQuery = ""): ReqView {
  if (!isObj(body)) return { system: "", items: fallbackQuery ? [{ k: "user", text: fallbackQuery }] : [] };

  const msgs = normalizeMessages(body);
  const system = systemText(body, msgs);
  const items = tailItems(msgs);

  if (!items.some((i) => i.k === "user") && fallbackQuery) {
    items.unshift({ k: "user", text: fallbackQuery });
  }
  return { system, items };
}

/**
 * 只取「最后一条 assistant 之后」的消息。
 * 多轮对话每轮都会重发整段历史，这一步天然去重，不需要维护任何跨请求状态；
 * 插件中途重启也不会把历史再抄一遍。assistant 的回复本身在响应侧记录，这里不再重复。
 */
function tailItems(msgs: Msg[]): Item[] {
  const chat = msgs.filter((m) => m.role !== "system" && m.role !== "developer");
  let start = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].role === "assistant") {
      start = i + 1;
      break;
    }
  }

  const out: Item[] = [];
  for (const m of chat.slice(start)) {
    const names = m.toolNames.filter(Boolean);

    if (m.role === "assistant") {
      if (m.text.trim()) out.push({ k: "assistant", text: m.text });
      if (names.length) out.push({ k: "tool_call", names });
      continue;
    }

    // 工具结果：独立 tool / function 角色，或包在 user 消息里的 tool_result 块
    const isTool = m.role === "tool" || m.role === "function" || m.toolResults > 0;
    if (isTool) {
      out.push({ k: "tool_result", count: m.toolResults || 1 });
      if (!m.text.trim()) continue;
      // 有些实现把工具结果塞进 user 角色但带正文，正文也不当"用户提问"
    } else if (m.text.trim()) {
      out.push({ k: "user", text: m.text });
    }

    if (names.length) out.push({ k: "tool_call", names });
  }
  return out;
}

interface Msg {
  role: string;
  text: string;
  toolResults: number;
  toolNames: string[];
}

function normalizeMessages(body: Obj): Msg[] {
  const out: Msg[] = [];

  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      if (!isObj(raw)) continue;
      out.push(toMsg(raw.role, raw.content, raw.tool_calls));
    }
    return out;
  }

  // OpenAI Responses API：input 是字符串或条目数组
  if (typeof body.input === "string") {
    out.push({ role: "user", text: body.input, toolResults: 0, toolNames: [] });
    return out;
  }
  if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      if (!isObj(raw)) continue;
      const type = String(raw.type || "");
      if (type === "function_call_output" || type === "tool_result") {
        out.push({ role: "tool", text: "", toolResults: 1, toolNames: [] });
      } else if (type === "function_call") {
        out.push({ role: "assistant", text: "", toolResults: 0, toolNames: [String(raw.name || "")] });
      } else {
        out.push(toMsg(raw.role ?? "user", raw.content, raw.tool_calls));
      }
    }
  }
  return out;
}

function toMsg(role: unknown, content: unknown, toolCalls: unknown): Msg {
  const c = parseContent(content);
  const names = [...c.toolNames];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const name = isObj(tc) ? (isObj(tc.function) ? tc.function.name : tc.name) : "";
      if (name) names.push(String(name));
    }
  }
  return { role: String(role || "user"), text: c.text, toolResults: c.toolResults, toolNames: names };
}

function parseContent(content: unknown): { text: string; toolResults: number; toolNames: string[] } {
  if (typeof content === "string") return { text: content, toolResults: 0, toolNames: [] };
  if (!Array.isArray(content)) return { text: "", toolResults: 0, toolNames: [] };

  const texts: string[] = [];
  const toolNames: string[] = [];
  let toolResults = 0;
  let images = 0;

  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!isObj(part)) continue;
    const type = String(part.type || "");
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof part.text === "string") texts.push(part.text);
    } else if (type === "image" || type === "image_url" || type === "input_image") {
      images++;
    } else if (type === "tool_result") {
      toolResults++;
    } else if (type === "tool_use") {
      toolNames.push(String(part.name || ""));
    }
  }

  if (images > 0) texts.push(`[图片 ×${images}]`);
  return { text: texts.join("\n"), toolResults, toolNames };
}

function systemText(body: Obj, msgs: Msg[]): string {
  const parts: string[] = [];
  const push = (s: unknown) => {
    const t = typeof s === "string" ? s : "";
    if (t.trim() && !parts.includes(t)) parts.push(t);
  };

  push(body.instructions); // Responses API
  push(body.system); // Anthropic（字符串形态）
  if (Array.isArray(body.system)) {
    const joined = body.system
      .map((b: unknown) => (isObj(b) && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
    push(joined);
  }
  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      if (isObj(raw) && (raw.role === "system" || raw.role === "developer")) {
        push(parseContent(raw.content).text);
      }
    }
  }
  void msgs;
  return parts.join("\n\n---\n\n");
}

/* ------------------------------ 回复 ------------------------------ */

export function extractReply(reply: unknown): ReplyView {
  const empty: ReplyView = { text: "", reasoning: "", toolNames: [], finish: "", usage: {} };
  if (!isObj(reply)) return empty;

  // OpenAI chat completions
  if (Array.isArray(reply.choices) && reply.choices.length) {
    const choice = isObj(reply.choices[0]) ? reply.choices[0] : {};
    const msg = isObj(choice.message) ? choice.message : choice.delta || {};
    const parsed = parseContent(isObj(msg) ? msg.content : "");
    const names: string[] = [...parsed.toolNames];
    if (isObj(msg) && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = isObj(tc) ? (isObj(tc.function) ? tc.function.name : tc.name) : "";
        if (name) names.push(String(name));
      }
    }
    return {
      text: parsed.text,
      reasoning: isObj(msg) && typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
      toolNames: names.filter(Boolean),
      finish: String(choice.finish_reason || ""),
      usage: pickUsage(reply.usage),
    };
  }

  // Anthropic messages
  if (Array.isArray(reply.content)) {
    const texts: string[] = [];
    const thinking: string[] = [];
    const names: string[] = [];
    for (const block of reply.content) {
      if (!isObj(block)) continue;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
      else if (block.type === "tool_use") names.push(String(block.name || ""));
    }
    return {
      text: texts.join("\n"),
      reasoning: thinking.join("\n"),
      toolNames: names.filter(Boolean),
      finish: String(reply.stop_reason || ""),
      usage: pickUsage(reply.usage),
    };
  }

  // OpenAI Responses API
  if (Array.isArray(reply.output)) {
    const texts: string[] = [];
    const names: string[] = [];
    for (const item of reply.output) {
      if (!isObj(item)) continue;
      if (item.type === "function_call") names.push(String(item.name || ""));
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (isObj(c) && typeof c.text === "string") texts.push(c.text);
      }
    }
    return {
      text: texts.join("\n"),
      reasoning: "",
      toolNames: names.filter(Boolean),
      finish: String(reply.status || ""),
      usage: pickUsage(reply.usage),
    };
  }

  if (typeof reply === "string") return { ...empty, text: reply };
  return empty;
}

function pickUsage(usage: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(usage)) return out;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"]) {
    const v = usage[key];
    if (typeof v === "number") out[key] = v;
  }
  return out;
}

/* --------------------------- 辅助调用识别 --------------------------- */

const AUX_PATTERNS = [
  "generate a concise, sentence-case title",
  "isnewtopic",
  "you are a title generator",
  "generate a short title",
  "conversation title",
];

/** 会话标题生成这类后台请求不是"对话"，默认不记 */
export function isAux(system: string): boolean {
  if (!system) return false;
  const s = system.toLowerCase();
  return AUX_PATTERNS.some((p) => s.includes(p));
}
