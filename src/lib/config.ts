import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Format = "text" | "jsonl";

/** 默认数据目录名（与包名一致） */
const DATA_DIR = "magpie-local-shortlog";
/** 更名前的目录名，仅用于兼容读取 */
const LEGACY_DATA_DIR = "magpie-log";

export interface LogConfig {
  enabled: boolean;
  dir: string;
  file: string;
  format: Format;
  maxFileMB: number;
  keepFiles: number;
  origins: string[];
  skipPaths: string[];
  skipAux: boolean;
  showReasoning: boolean;
  showToolCalls: boolean;
  maxTextBytes: number;
  systemReprintHours: number;
  debug: boolean;
  redactKeys: string[];
}

export const DEFAULTS: LogConfig = {
  // 默认关：装完必须显式开启一次（日志含 system prompt 与源码，见 README 隐私说明）
  enabled: false,
  dir: "",
  file: "conversations.log",
  format: "text",
  maxFileMB: 20,
  keepFiles: 5,
  origins: ["local"],
  skipPaths: ["/v1/messages/count_tokens", "/v1/models", "/v1beta/models"],
  skipAux: true,
  showReasoning: false,
  showToolCalls: true,
  maxTextBytes: 256 * 1024,
  // 同一会话/客户端距上次输出系统提示词超过这么久，就重印一次（0 = 不按时间重印）
  systemReprintHours: 6,
  debug: false,
  redactKeys: [
    "authorization",
    "api_key",
    "apikey",
    "api-key",
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "client_secret",
    "password",
    "cookie",
    "set-cookie",
  ],
};

const cache = new Map<string, LogConfig>();

/** ctx.options → 完整配置；同一种 options 只解析一次 */
export function configOf(options: unknown): LogConfig {
  const key = JSON.stringify(options ?? null);
  const hit = cache.get(key);
  if (hit) return hit;

  const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
  const cfg: LogConfig = {
    enabled: bool(o.enabled, DEFAULTS.enabled),
    dir: typeof o.dir === "string" ? o.dir.trim() : DEFAULTS.dir,
    file: typeof o.file === "string" && o.file.trim() ? safeName(o.file) : DEFAULTS.file,
    format: o.format === "jsonl" ? "jsonl" : "text",
    maxFileMB: clamp(o.maxFileMB, 1, 512, DEFAULTS.maxFileMB),
    keepFiles: clamp(o.keepFiles, 0, 50, DEFAULTS.keepFiles),
    origins: Array.isArray(o.origins) ? o.origins.map(String) : DEFAULTS.origins,
    skipPaths: Array.isArray(o.skipPaths) ? o.skipPaths.map(String) : DEFAULTS.skipPaths,
    skipAux: bool(o.skipAux, DEFAULTS.skipAux),
    showReasoning: bool(o.showReasoning, DEFAULTS.showReasoning),
    showToolCalls: bool(o.showToolCalls, DEFAULTS.showToolCalls),
    maxTextBytes: clamp(o.maxTextKB, 1, 8192, 256) * 1024,
    systemReprintHours: clamp(o.systemReprintHours, 0, 720, DEFAULTS.systemReprintHours),
    debug: bool(o.debug, DEFAULTS.debug),
    redactKeys: Array.isArray(o.redactKeys)
      ? [...DEFAULTS.redactKeys, ...o.redactKeys.map(String)]
      : DEFAULTS.redactKeys,
  };

  if (cache.size > 8) cache.clear();
  cache.set(key, cfg);
  return cfg;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function clamp(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 文件名只允许单层，防止 ../ 越界 */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 64) || DEFAULTS.file;
}

/** magpie 的配置目录：$XDG_CONFIG_HOME/magpie，否则 ~/.config/magpie（macOS 同样） */
export function magpieConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "magpie") : join(homedir(), ".config", "magpie");
}

/** 日志根目录：options.dir > $MAGPIE_LOG_DIR > <config>/plugin-data/<包名> */
export function dataDir(cfg: LogConfig): string {
  if (cfg.dir) return cfg.dir;
  const env = process.env.MAGPIE_LOG_DIR;
  if (env) return env;

  const base = join(magpieConfigDir(), "plugin-data");
  const current = join(base, DATA_DIR);
  // 更名前叫 magpie-log：旧目录还在、新目录还没建时继续原地追加，历史日志不失联。
  // 想迁到新目录，把旧目录 mv 成新名字即可（下次调用会自动改走新路径）。
  if (!existsSync(current) && existsSync(join(base, LEGACY_DATA_DIR))) return join(base, LEGACY_DATA_DIR);
  return current;
}

/** 唯一的追加文件（轮转时变 .1 / .2 …） */
export function logFile(cfg: LogConfig): string {
  return join(dataDir(cfg), cfg.file);
}
