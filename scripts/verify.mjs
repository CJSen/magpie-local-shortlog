/**
 * 脱离 magpie 的自测：直接调钩子，用假 ctx 模拟宿主。
 * 跑：node --experimental-strip-types scripts/verify.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "magpie-shortlog-verify-"));
process.env.MAGPIE_LOG_DIR = root;

const { onRequest, onResponse } = await import("../src/hooks.ts");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : `  << ${extra}`}`);
}

function makeCtx(opts, patch = {}) {
  return {
    options: opts,
    agent: "workbuddy",
    session: "s1",
    origin: "local",
    protocol: "chat",
    path: "/v1/chat/completions",
    model: "deepseek/deepseek-flash",
    stream: true,
    query: "",
    state: {},
    ...patch,
  };
}

async function exchange(ctx, body, reply) {
  await onRequest(body, ctx);
  await onResponse(reply, { ...ctx, success: true });
}

const chatReply = (text) => ({
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
});

const logText = async (dir) => readFile(join(dir, "conversations.log"), "utf8").catch(() => "");

/* ---------------- 1. 基础：只落对话，工具定义不进日志 ---------------- */
const OPT = { enabled: true, maxFileMB: 20, keepFiles: 5 };
const ctx1 = makeCtx(OPT);

const sysPrompt = "This conversation is powered by Demo.\n" + "A".repeat(2000);
const toolBlob = {
  type: "function",
  function: { name: "Bash", description: "Z".repeat(20000), parameters: { type: "object", properties: {} } },
};

await exchange(
  ctx1,
  { model: "m", messages: [{ role: "system", content: sysPrompt }, { role: "user", content: "用户第一问" }], tools: [toolBlob] },
  chatReply("第一答"),
);

/* ---------------- 2. 多轮：历史不重复抄 ---------------- */
await exchange(
  ctx1,
  {
    model: "m",
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: "用户第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "用户第二问" },
    ],
    tools: [toolBlob],
  },
  chatReply("第二答"),
);

/* ---------------- 3. 后台标题生成：跳过 ---------------- */
await exchange(
  makeCtx(OPT),
  {
    messages: [
      { role: "system", content: "Generate a concise, sentence-case title (3-7 words) that captures the main topic." },
      { role: "user", content: "<session>随便聊聊</session>" },
    ],
  },
  chatReply('{"isNewTopic": true, "title": "随便聊聊"}'),
);

/* ---------------- 4. Anthropic 协议 ---------------- */
const ctx2 = makeCtx(OPT, { session: "s2", protocol: "messages", path: "/v1/messages" });
await exchange(
  ctx2,
  { system: "你是严谨的助手", messages: [{ role: "user", content: [{ type: "text", text: "anthropic 问" }] }] },
  { content: [{ type: "text", text: "anthropic 答" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 3 } },
);

/* ---------------- 5. 工具轮：只留标记，不留内容 ---------------- */
await exchange(
  makeCtx(OPT, { session: "s3" }),
  { messages: [{ role: "system", content: "sys-3" }, { role: "user", content: "帮我读个文件" }] },
  {
    choices: [
      {
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "Read" } }] },
        finish_reason: "tool_calls",
      },
    ],
  },
);
await exchange(
  makeCtx(OPT, { session: "s3" }),
  {
    messages: [
      { role: "system", content: "sys-3" },
      { role: "user", content: "帮我读个文件" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "Read" } }] },
      { role: "tool", content: "TOOL_OUTPUT_SHOULD_NOT_APPEAR".repeat(100) },
    ],
  },
  chatReply("文件里是配置"),
);

/* ---------------- 6. 脱敏 ---------------- */
await exchange(
  makeCtx(OPT, { session: "s4" }),
  { messages: [{ role: "user", content: "我的 key 是 sk-abcdefghijklmnopqrstuvwx 帮我看看" }] },
  chatReply("收到"),
);

/* ---------------- 6b. 正文被截断、只剩思考内容 ---------------- */
await exchange(
  makeCtx(OPT, { session: "s5" }),
  { messages: [{ role: "user", content: "空正文场景" }] },
  {
    choices: [
      { message: { role: "assistant", content: "", reasoning_content: "思考了很久但没给出正文" }, finish_reason: "length" },
    ],
  },
);

const text = await logText(root);
const files = await readdir(root);

check("单文件：只生成 conversations.log", files.join(",") === "conversations.log", files.join(","));
check("不带工具定义", !text.includes("ZZZZZZZZZZ"), "tool schema 泄漏");
check("系统提示词只输出一次", text.split("This conversation is powered by Demo").length - 1 === 1, "system 重复");
check("首轮用户消息", text.includes("[用户]\n用户第一问"));
check("首轮回复", text.includes("[助手]\n第一答"));
check("第二轮只记新消息", text.includes("[用户]\n用户第二问") && text.split("用户第一问").length - 1 === 1, "历史重复");
check("标题生成被跳过", !text.includes("随便聊聊"));
check("anthropic 协议", text.includes("anthropic 问") && text.includes("anthropic 答") && text.includes("你是严谨的助手"));
check("工具轮：调用与结果只留标记", text.includes("[调用工具] Read") && text.includes("[工具结果 ×1 · 内容省略]"));
check("工具输出内容未落盘", !text.includes("TOOL_OUTPUT_SHOULD_NOT_APPEAR"));
check("只剩思考内容时给预览", text.includes("[无正文 · 仅有思考内容") && text.includes("思考了很久但没给出正文"));
check("脱敏：sk- 令牌", text.includes("[redacted]") && !text.includes("sk-abcdefghijklmnopqrstuvwx"));
const rules = (text.match(/^━{72}$/gm) || []).length;
check("每轮一条粗分隔线", rules === 7, String(rules));

/* ---------------- 7. 开关与来源闸门 ---------------- */
const before = (await stat(join(root, "conversations.log"))).size;
await exchange(
  makeCtx({ enabled: false }),
  { messages: [{ role: "user", content: "关闭时不该出现" }] },
  chatReply("不写"),
);
await exchange(
  makeCtx(OPT, { origin: "remote" }),
  { messages: [{ role: "user", content: "远程来源不该出现" }] },
  chatReply("不写"),
);
const after = (await stat(join(root, "conversations.log"))).size;
check("enabled=false / 非本地来源都不写", before === after, `${before} → ${after}`);

/* ---------------- 8. 单文件轮转 ---------------- */
const rotRoot = join(root, "rot");
await mkdir(rotRoot, { recursive: true });
const ROT = { enabled: true, dir: rotRoot, maxFileMB: 1, keepFiles: 3, maxTextKB: 256 };
const bigSys = "S".repeat(200 * 1024);
const bigUser = "U".repeat(100 * 1024);
for (let i = 0; i < 4; i++) {
  await exchange(
    makeCtx(ROT, { session: `rot-${i}` }),
    { messages: [{ role: "system", content: bigSys }, { role: "user", content: `第${i}轮\n${bigUser}` }] },
    chatReply("好的"),
  );
}

const rotFiles = (await readdir(rotRoot)).sort();
const contents = {};
const sizes = {};
for (const f of rotFiles) {
  contents[f] = await readFile(join(rotRoot, f), "utf8");
  sizes[f] = (await stat(join(rotRoot, f))).size;
}

check("轮转产生了历史文件", rotFiles.length >= 2, rotFiles.join(","));
check("单文件不超阈值太多", Object.values(sizes).every((s) => s <= 1024 * 1024 + 400 * 1024), JSON.stringify(sizes));
check(
  "没有半截记录（每个文件都以分隔线开头）",
  Object.values(contents).every((c) => c.startsWith("━".repeat(72))),
  "存在切分",
);
const turnsTotal = Object.values(contents).reduce((n, c) => n + (c.match(/^━{72}$/gm) || []).length, 0);
check("轮转后总轮次 = 4", turnsTotal === 4, String(turnsTotal));

/* ---------------- 9. 系统提示词回显策略（A/B/C） ---------------- */
const sysDir = join(root, "sys");
const SYSOPT = { enabled: true, dir: sysDir, maxFileMB: 20, keepFiles: 3, systemReprintHours: 6 };
const sysLog = () => readFile(join(sysDir, "conversations.log"), "utf8").catch(() => "");
const turn = (sys, ...rest) => ({
  messages: [{ role: "system", content: sys }, ...rest.map((t) => (typeof t === "string" ? { role: "user", content: t } : t))],
});

/* A：未变化时留一行占位，正文只出现一次 */
await exchange(makeCtx(SYSOPT, { session: "a1", agent: "alpha" }), turn("alpha-sys", "问1"), chatReply("答1"));
await exchange(
  makeCtx(SYSOPT, { session: "a1", agent: "alpha" }),
  turn("alpha-sys", "问1", { role: "assistant", content: "答1" }, "问2"),
  chatReply("答2"),
);
let t = await sysLog();
check("A 首轮标注「本会话首次」", /\[系统提示词 · [\d.]+ B · 本会话首次\]/.test(t), t.slice(0, 200));
check("A 未变化时留占位行", /\[系统提示词 · [\d.]+ B · 未变化\]/.test(t), "缺少占位行");
check("A 全文仍然只出现一次", t.split("alpha-sys").length - 1 === 1, "重复输出");

/* B：同一会话隔 7 小时重印（无 session 的客户端靠这条兜底） */
await exchange(makeCtx(SYSOPT, { session: "b1", agent: "alpha" }), turn("window-sys", "b问1"), chatReply("b答1"));
const realNow = Date.now;
Date.now = () => realNow() + 7 * 3600_000;
await exchange(
  makeCtx(SYSOPT, { session: "b1", agent: "alpha" }),
  turn("window-sys", "b问1", { role: "assistant", content: "b答1" }, "b问2"),
  chatReply("b答2"),
);
Date.now = realNow;
t = await sysLog();
check("B 超过时间窗重印", t.includes("距上次超过 6 小时"), "时间窗未生效");
check("B 重印后全文出现两次", t.split("window-sys").length - 1 === 2, String(t.split("window-sys").length - 1));

/* C：切回原客户端时重印（即使会话 id 相同） */
await exchange(makeCtx(SYSOPT, { session: "c1", agent: "alpha" }), turn("switch-sys", "c1"), chatReply("r1"));
await exchange(makeCtx(SYSOPT, { session: "c1", agent: "beta" }), turn("beta-sys", "c2"), chatReply("r2"));
await exchange(
  makeCtx(SYSOPT, { session: "c1", agent: "alpha" }),
  turn("switch-sys", "c1", { role: "assistant", content: "r1" }, "c3"),
  chatReply("r3"),
);
t = await sysLog();
check("C 切回原客户端重印", t.split("switch-sys").length - 1 === 2, "未重印");
check("C 标注「客户端切换」", t.includes("客户端切换"), "缺少原因标注");

/* D：轮转后重印（否则新文件里的对话没有提示词根） */
const rotSysDir = join(root, "sysrot");
const SYSROT = { enabled: true, dir: rotSysDir, maxFileMB: 1, keepFiles: 3, maxTextKB: 64 };
await exchange(makeCtx(SYSROT, { session: "r0", agent: "alpha" }), turn("rot-root-sys", "起点"), chatReply("ok"));
for (let i = 0; i < 20; i++) {
  await exchange(makeCtx(SYSROT, { session: `fill-${i}`, agent: "alpha" }), turn(`fill-sys-${i}`, "F".repeat(90 * 1024)), chatReply("ok"));
}
await exchange(
  makeCtx(SYSROT, { session: "r0", agent: "alpha" }),
  turn("rot-root-sys", "起点", { role: "assistant", content: "ok" }, "后来"),
  chatReply("ok"),
);
const rotAll = (
  await Promise.all((await readdir(rotSysDir)).map((f) => readFile(join(rotSysDir, f), "utf8")))
).join("\n");
check("D 轮转后重印提示词", rotAll.includes("日志已轮转，重印"), "未重印");
check("D 提示词根数 ≥ 2", (rotAll.split("rot-root-sys").length - 1) >= 2, String(rotAll.split("rot-root-sys").length - 1));

/* E：系统提示词里的密钥同样要脱敏（早前版本正文明文落盘） */
await exchange(
  makeCtx(SYSOPT, { session: "e1", agent: "alpha" }),
  turn("系统里的密钥 sk-abcdefghijklmnopqrstuvwx 不该出现", "e问"),
  chatReply("e答"),
);
t = await sysLog();
check("E 系统提示词也脱敏", t.includes("[redacted]") && !t.includes("sk-abcdefghijklmnopqrstuvwx"), "密钥泄漏");

/* F：更名后的目录兼容（旧 magpie-log 目录仍在时继续原地追加） */
const { dataDir } = await import("../src/lib/config.ts");
const altHome = await mkdtemp(join(tmpdir(), "shortlog-xdg-"));
const savedXdg = process.env.XDG_CONFIG_HOME;
const savedDirEnv = process.env.MAGPIE_LOG_DIR;
delete process.env.MAGPIE_LOG_DIR;
process.env.XDG_CONFIG_HOME = altHome;

const pdata = join(altHome, "magpie", "plugin-data");
await mkdir(join(pdata, "magpie-log"), { recursive: true });
check("F 只有旧目录时沿用 magpie-log", dataDir({ dir: "" }) === join(pdata, "magpie-log"), dataDir({ dir: "" }));
await mkdir(join(pdata, "magpie-local-shortlog"), { recursive: true });
check(
  "F 新目录存在后改走新路径",
  dataDir({ dir: "" }) === join(pdata, "magpie-local-shortlog"),
  dataDir({ dir: "" }),
);

process.env.MAGPIE_LOG_DIR = savedDirEnv;
if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = savedXdg;
await rm(altHome, { recursive: true, force: true });

/* ---------------- 收尾 ---------------- */
console.log(`\n样本：${root}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (process.env.KEEP_SAMPLES !== "1") await rm(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
