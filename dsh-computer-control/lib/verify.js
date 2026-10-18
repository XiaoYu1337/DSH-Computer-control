/**
 * 动作校验助手：截图哈希、前后对比。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function hashBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function hashFile(path) {
  return hashBytes(await readFile(path));
}

export function screenshotName(prefix = 'verify') {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.png`;
}

/**
 * 通过 controller.runTask 的 ctx 截一张全屏图，返回 {path, result, hash}。
 * @param {{request: Function}} ctx
 * @param {string} dir
 * @param {string} prefix
 */
export async function captureScreen(ctx, dir, prefix = 'verify') {
  await mkdir(dir, { recursive: true });
  const path = join(dir, screenshotName(prefix));
  const result = await ctx.request('screenshot', { path }, { timeoutMs: 20_000 });
  const hash = await hashFile(path);
  return { path, result, hash };
}

export async function safeHashFile(path) {
  try {
    return await hashFile(path);
  } catch {
    return null;
  }
}
