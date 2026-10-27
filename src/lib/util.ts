import { createHash } from "node:crypto";

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** 1234 → "1.2 KB"，便于阅读体积 */
export function kb(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function hash(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);
}

/** 2026-10-27 20:55:15（本地时区） */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 按 UTF-8 字节截断：保留前 75% + 后 20%，中间打标记。
 * 单条消息过大时不至于把整个日志淹没，也尽量保留收尾的关键信息。
 */
export function clampText(s: string, maxBytes: number): string {
  const total = byteLength(s);
  if (total <= maxBytes) return s;

  const buf = Buffer.from(s, "utf8");
  const head = buf.subarray(0, Math.floor(maxBytes * 0.75)).toString("utf8").replace(/\uFFFD+$/, "");
  const tail = buf
    .subarray(Math.max(0, buf.length - Math.floor(maxBytes * 0.2)))
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
  const omitted = total - byteLength(head) - byteLength(tail);
  return `${head}\n…[已截断 ${kb(omitted)}，原文共 ${kb(total)}]…\n${tail}`;
}
