import { randomUUID } from "node:crypto";

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { configOf, dataDir, logFile, type LogConfig } from "./lib/config.ts";
import { extractReply, extractRequest, isAux } from "./lib/conversation.ts";
import { renderJson, renderText, renderRequest, type Header, type SysBlock } from "./lib/render.ts";
import { redact } from "./lib/redact.ts";
import { RotatingLog } from "./lib/rotate.ts";
import { byteLength, hash } from "./lib/util.ts";

interface Link {
  id: string;
  t0: number;
  block: string; // 已渲染、已脱敏的「系统提示词 + 用户输入」
  /** 本轮是否输出了系统提示词全文；用于写盘后回填「块落在第几个文件」 */
  sys?: { key: string; h: string; printed: boolean };
}

interface SysState {
  h: string; // 提示词指纹
  ts: number; // 上次输出全文的时间
  rot: number; // 输出时所在文件的轮转代次
}

const writers = new Map<string, RotatingLog>();
const recent = new Map<string, Link>();
const sysSeen = new Map<string, SysState>(); // 会话 → 上次输出记录
const LINK_TTL = 180_000;
const SYS_MAX_KEYS = 512;
let lastAgent = ""; // 上一次真正落盘的客户端，用来识别"换了个软件"
let logged = 0;

/**
 * 请求进网关、路由之前调用。
 * 只读 body，永不修改、永不拒绝：返回 undefined 即"保持原样"。
 */
export async function onRequest(body: unknown, ctx: any): Promise<undefined> {
  try {
    const cfg = configOf(ctx?.options);
    // 先失效本会话的旧链接：本次请求若被过滤掉，回复也就绝不能落到上一轮的块上
    const key = sessionKey(ctx);
    recent.delete(key);
    await dbg(cfg, `req origin=${str(ctx?.origin)} path=${str(ctx?.path)} agent=${str(ctx?.agent)} session=${str(ctx?.session)} model=${str(ctx?.model)}`);

    if (!cfg.enabled) return skip(ctx);

    const origin = typeof ctx?.origin === "string" && ctx.origin ? ctx.origin : "unknown";
    if (!cfg.origins.includes(origin)) return skip(ctx);

    const path = typeof ctx?.path === "string" ? ctx.path : "";
    if (cfg.skipPaths.includes(path)) return skip(ctx);

    const view = extractRequest(body, str(ctx?.query));
    await dbg(cfg, `  view system=${view.system.length}B items=${view.items.length} [${view.items.map((i) => i.k).join(",")}]`);
    if (cfg.skipAux && isAux(view.system)) {
      await dbg(cfg, "  skip: aux");
      return skip(ctx);
    }
    if (!view.system && view.items.length === 0) {
      await dbg(cfg, "  skip: empty");
      return skip(ctx);
    }

    // 先脱敏：系统提示词同样要过一遍，不能因为"不分段输出"就漏掉
    const clean = redact(view, cfg.redactKeys) as typeof view;
    const agent = str(ctx?.agent);
    const sys = decideSystem(cfg, key, agent, clean.system, writerFor(cfg).rotationCount);
    await dbg(cfg, `  sys ${sys.bytes}B -> ${sys.text ? sys.note || "输出全文" : "不回显"}`);
    const block = renderRequest(clean, cfg, sys);

    const t0 = Date.now();
    const link: Link = {
      id: `${t0.toString(36)}-${randomUUID().slice(0, 8)}`,
      t0,
      block,
      sys: sys.text ? { key, h: sys.h, printed: true } : undefined,
    };

    lastAgent = agent; // 只有真正落盘的请求才算"换过客户端"
    const state = ctx?.state;
    if (state && typeof state === "object") state.magpieLog = link;
    recent.set(key, link);
    sweep();
    report(ctx, "ready", block.length);
  } catch (e) {
    fail(ctx, e);
  }
  return undefined;
}

/**
 * 输出结束后的一次尽力通知（fire-and-forget，可能丢）。
 * 回复不可修改；把「请求块 + 回复块」作为一整轮一次性追加，避免并发请求交错。
 */
export async function onResponse(reply: unknown, ctx: any): Promise<void> {
  try {
    const cfg = configOf(ctx?.options);
    if (!cfg.enabled) return;

    const link = linkOf(ctx);
    if (!link) return; // 请求没记（来源被过滤/后台调用），回复也就不记

    const ok = ctx?.success === true;
    const header: Header = {
      ts: link.t0,
      agent: str(ctx?.agent),
      model: str(ctx?.model),
      ms: Date.now() - link.t0,
      ok,
      session: str(ctx?.session),
    };
    const view = extractReply(reply);
    const payload =
      cfg.format === "jsonl"
        ? renderJson(header, link.block, view)
        : renderText(header, link.block, view, cfg);

    const writer = writerFor(cfg);
    await writer.append(payload);
    // 本轮刚写过全文：回填"落在第几代文件"，之后一旦轮转就能触发重印
    if (link.sys?.printed) {
      const rec = sysSeen.get(link.sys.key);
      if (rec && rec.h === link.sys.h) rec.rot = writer.rotationCount;
    }
    report(ctx, "ready", payload.length);
  } catch (e) {
    fail(ctx, e);
  }
}

/* ---------- 内部 ---------- */

/** 全局只有一个追加文件，轮转成 .1 / .2 … */
function writerFor(cfg: LogConfig): RotatingLog {
  const file = logFile(cfg);
  const key = `${file}|${cfg.maxFileMB}|${cfg.keepFiles}`;
  let w = writers.get(key);
  if (!w) {
    w = new RotatingLog(file, cfg.maxFileMB * 1024 * 1024, cfg.keepFiles);
    writers.set(key, w);
    if (writers.size > 8) writers.clear();
  }
  return w;
}

/** ctx.state 优先；宿主没给 state 时退回到「同会话最近一次请求」，超过 TTL 视为失效 */
function linkOf(ctx: any): Link | undefined {
  const state = ctx?.state;
  if (state && typeof state === "object" && state.magpieLog) return state.magpieLog as Link;

  const link = recent.get(sessionKey(ctx));
  if (!link) return undefined;
  if (Date.now() - link.t0 > LINK_TTL) {
    recent.delete(sessionKey(ctx));
    return undefined;
  }
  return link;
}

function sweep(): void {
  if (recent.size <= 64) return;
  const now = Date.now();
  for (const [k, v] of recent) {
    if (now - v.t0 > LINK_TTL) recent.delete(k);
  }
  while (recent.size > 64) {
    const first = recent.keys().next();
    if (first.done) break;
    recent.delete(first.value);
  }
}

function sessionKey(ctx: any): string {
  return `${str(ctx?.agent)}\u0000${str(ctx?.session)}`;
}

/**
 * 系统提示词是否回显全文。去重键是 (客户端, 会话)，避免每轮重复几十 KB。
 * 以下四种情况会重印：
 *   1. 提示词本身变了（sha1 变了）；
 *   2. 换了客户端（上一次落盘的是别的 agent）；
 *   3. 距上次输出超过 systemReprintHours（无 session 的客户端靠这条才不会"一辈子只出现一次"）；
 *   4. 日志已经轮转（全文留在 .1/.2 里，当前文件需要一份根）。
 */
function decideSystem(
  cfg: LogConfig,
  key: string,
  agent: string,
  system: string,
  rot: number,
): SysBlock & { h: string } {
  const bytes = byteLength(system);
  if (!system.trim()) return { text: "", bytes: 0, note: "", h: "" };

  const h = hash(system);
  const prev = sysSeen.get(key);
  const now = Date.now();
  const windowMs = cfg.systemReprintHours * 3600_000;

  let note = "";
  if (!prev) note = "本会话首次";
  else if (prev.h !== h) note = "提示词已变更";
  else if (lastAgent && agent && lastAgent !== agent) note = "客户端切换";
  else if (prev.rot !== rot) note = "日志已轮转，重印";
  else if (windowMs > 0 && now - prev.ts > windowMs) note = `距上次超过 ${cfg.systemReprintHours} 小时`;

  if (!note) return { text: "", bytes, note: "未变化", h };

  // 控制 Map 体积：淘汰最早插入的那个，而不是整表清空（清空会让所有会话重印一遍）
  if (!sysSeen.has(key) && sysSeen.size >= SYS_MAX_KEYS) {
    const oldest = sysSeen.keys().next();
    if (!oldest.done) sysSeen.delete(oldest.value);
  }
  sysSeen.set(key, { h, ts: now, rot });
  return { text: system, bytes, note, h };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 排查用：把钩子的进出与判定理由追加到 debug.log（默认关闭） */
async function dbg(cfg: LogConfig, msg: string): Promise<void> {
  if (!cfg.debug) return;
  try {
    await appendFile(join(dataDir(cfg), "debug.log"), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    /* 排查日志失败不影响主链路 */
  }
}

function skip(ctx: any): undefined {
  report(ctx, "skipped");
  return undefined;
}

function report(ctx: any, code: string, bytes = 0): void {
  try {
    ctx?.report?.(code, bytes);
  } catch {
    /* 统计失败不影响记录 */
  }
}

/** 任何异常都不外抛：钩子失败会 fail-open，但错误必须留痕，否则无从排查 */
function fail(ctx: any, e: unknown): void {
  if (logged < 20) {
    logged++;
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    console.error(`[magpie-local-shortlog] ${msg}`);
  }
  report(ctx, "unavailable");
}
