import type { LogConfig } from "./config.ts";
import type { Item, ReqView, ReplyView } from "./conversation.ts";
import { byteLength, clampText, fmtTime, kb } from "./util.ts";

const HEAVY = "━".repeat(72);
const LIGHT = "─".repeat(72);

export interface Header {
  ts: number;
  agent: string;
  model: string;
  ms: number;
  ok: boolean;
  session: string;
}

/**
 * 系统提示词的渲染决策。
 * text 非空 = 本轮输出全文；text 为空但 bytes > 0 = 本轮省略，只留一行占位说明。
 */
export interface SysBlock {
  text: string;
  bytes: number;
  note: string;
}

/**
 * 请求侧先渲染成块（不含表头 —— 耗时/成败要等回复才知道）。
 * 只保留渲染后的文本，不长期持有原始 body，避免并发请求把内存撑大。
 */
export function renderRequest(view: ReqView, cfg: LogConfig, sys: SysBlock): string {
  const blocks: string[] = [];

  if (sys.text.trim()) {
    const note = sys.note ? ` · ${sys.note}` : "";
    blocks.push(`[系统提示词 · ${kb(sys.bytes)}${note}]\n${clampText(sys.text, cfg.maxTextBytes)}`);
  } else if (sys.bytes > 0) {
    // 省略也要留一行：任何一轮都能看出"这轮有提示词、多大、为什么没重复输出"
    blocks.push(`[系统提示词 · ${kb(sys.bytes)} · ${sys.note || "未变化"}]`);
  }

  for (const item of view.items) {
    const block = renderItem(item, cfg);
    if (block) blocks.push(block);
  }
  return blocks.length ? `${blocks.join("\n\n")}\n\n` : "";
}

function renderItem(item: Item, cfg: LogConfig): string {
  switch (item.k) {
    case "user":
      return `[用户]\n${clampText(item.text, cfg.maxTextBytes)}`;
    case "assistant":
      return `[助手 · 历史]\n${clampText(item.text, cfg.maxTextBytes)}`;
    case "tool_call":
      return cfg.showToolCalls ? `[调用工具] ${item.names.join(", ")}` : "";
    case "tool_result":
      return cfg.showToolCalls ? `[工具结果 ×${item.count} · 内容省略]` : "";
    default:
      return "";
  }
}

export function renderReply(reply: ReplyView, cfg: LogConfig, ok: boolean): string {
  const blocks: string[] = [];

  if (reply.text.trim()) blocks.push(`[助手]\n${clampText(reply.text, cfg.maxTextBytes)}`);
  if (cfg.showReasoning && reply.reasoning.trim()) blocks.push(`[思考]\n${clampText(reply.reasoning, cfg.maxTextBytes)}`);
  if (reply.toolNames.length && cfg.showToolCalls) blocks.push(`[调用工具] ${reply.toolNames.join(", ")}`);

  if (!ok && !reply.text.trim()) {
    blocks.push("[错误] 上游未返回成功（magpie 不暴露错误文本）");
  } else if (!reply.text.trim() && !reply.toolNames.length) {
    if (reply.reasoning.trim() && !cfg.showReasoning) {
      // 正文被 token 上限截断时往往只剩思考内容，给个预览，免得日志看起来一片空白
      const bytes = byteLength(reply.reasoning);
      const preview = clampText(reply.reasoning, 400).replace(/\n/g, " ");
      blocks.push(`[无正文 · 仅有思考内容 ${kb(bytes)}${reply.finish ? ` · finish_reason=${reply.finish}` : ""}]\n${preview}`);
    } else {
      blocks.push(reply.finish ? `[空回复 · finish_reason=${reply.finish}]` : "[空回复]");
    }
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

export function renderHeader(h: Header): string {
  const bits = [fmtTime(h.ts), h.agent || "未知客户端", h.model || "未知模型", `${h.ms}ms`];
  if (h.session) bits.push(`会话 ${h.session.slice(0, 8)}`);
  if (!h.ok) bits.push("失败");
  return [HEAVY, bits.join(" · "), LIGHT, "", ""].join("\n");
}

/** 整轮：表头 + 请求块 + 回复块；轮与轮之间留两个空行，方便肉眼和 grep 定位 */
export function renderText(h: Header, requestBlock: string, reply: ReplyView, cfg: LogConfig): string {
  return `${renderHeader(h)}${requestBlock}${renderReply(reply, cfg, h.ok)}\n\n`;
}

export function renderJson(h: Header, requestBlock: string, reply: ReplyView): string {
  const rec = {
    v: 2,
    t: "turn",
    ts: new Date(h.ts).toISOString(),
    agent: h.agent,
    session: h.session,
    model: h.model,
    ms: h.ms,
    ok: h.ok,
    request: requestBlock,
    reply: {
      text: reply.text,
      reasoning: reply.reasoning || undefined,
      tools: reply.toolNames.length ? reply.toolNames : undefined,
      finish: reply.finish || undefined,
      usage: Object.keys(reply.usage).length ? reply.usage : undefined,
    },
  };
  return `${JSON.stringify(rec)}\n`;
}
