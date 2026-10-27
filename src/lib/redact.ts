const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
];

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MASK = "[redacted]";
const MAX_STRING_SCAN = 64 * 1024; // 超长字符串只做字段级脱敏，避免拖慢钩子
const MAX_DEPTH = 64;

/**
 * 深拷贝 + 脱敏。绝不修改 magpie 传进来的 body（宿主会用它发请求）。
 * 字段名命中黑名单 → 整值替换；字符串再做一遍令牌正则。
 */
export function redact(value: unknown, secretKeys: string[]): unknown {
  const keys = new Set(secretKeys.map((k) => k.toLowerCase()));
  return walk(value, keys, 0);
}

function walk(v: unknown, keys: Set<string>, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[…]";

  if (typeof v === "string") {
    if (v.length > MAX_STRING_SCAN) return v;
    let out = v;
    for (const [re, to] of RULES) out = out.replace(re, to);
    return out;
  }

  if (Array.isArray(v)) {
    return v.map((item) => walk(item, keys, depth + 1));
  }

  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(src)) {
      if (UNSAFE_KEYS.has(k)) continue;
      out[k] = keys.has(k.toLowerCase()) ? MASK : walk(val, keys, depth + 1);
    }
    return out;
  }

  return v;
}
