import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 按「记录」轮转的追加写器。
 *
 * - 一条记录一次 write，绝不跨文件切分；
 * - 写前预判大小，超过 maxBytes 先把当前文件 rename 成 .1（历史上移一位）；
 * - 所有写入串在一条 promise 链上，避免并发请求同时判定要轮转、丢段；
 * - 任何异常都吞掉（fail-open），不把错误抛回 magpie 的请求链路。
 */
export class RotatingLog {
  private chain: Promise<void> = Promise.resolve();
  private size = -1; // -1 = 进程内还没探测；宿主重载后第一次写会 stat 回真实大小
  private dropped = 0;
  private rotations = 0; // 本进程内切过几次文件，用来判断"之前写下的块是否还在当前文件里"
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(file: string, maxBytes: number, keep: number) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
  }

  append(payload: string): Promise<void> {
    const buf = Buffer.from(payload, "utf8");
    this.chain = this.chain.then(() => this.doAppend(buf)).catch(() => {
      this.dropped++;
    });
    return this.chain;
  }

  /** 已丢掉的记录数（写盘失败），供状态输出用 */
  get droppedCount(): number {
    return this.dropped;
  }

  /** 本进程内轮转次数。当前文件一变，之前写下的块就不在新文件里了 */
  get rotationCount(): number {
    return this.rotations;
  }

  private async doAppend(buf: Buffer): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });

    if (this.size < 0) {
      this.size = await stat(this.file).then((s) => s.size).catch(() => 0);
    }

    if (this.size > 0 && this.size + buf.length > this.maxBytes) {
      await rotate(this.file, this.keep);
      this.size = 0;
      this.rotations++;
    }

    await appendFile(this.file, buf, { mode: 0o600 });
    // 超限的单条也如实累加：下一条自然会再触发轮转，让它独占一个文件
    this.size += buf.length;
  }
}

export async function rotate(file: string, keep: number): Promise<void> {
  if (keep <= 0) {
    await unlink(file).catch(() => {});
    return;
  }
  await unlink(`${file}.${keep}`).catch(() => {});
  for (let i = keep - 1; i >= 1; i--) {
    await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
  }
  await rename(file, `${file}.1`).catch(() => {});
}
