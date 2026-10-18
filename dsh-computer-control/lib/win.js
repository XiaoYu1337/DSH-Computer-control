/**
 * Windows 窗口与「打开目标」助手。
 * 窗口枚举/聚焦/等待由 scripts/window-tools.ps1 完成（UIA/Win32）。
 */
import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShellScript } from './ps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const WINDOW_TOOL = join(SCRIPTS, 'window-tools.ps1');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function lookLikeUrl(value) {
  return /^https?:\/\//iu.test(value);
}

function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('computer-control invalid-args: target is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('computer-control blocked-url: computer_open only allows http/https URLs');
  }
  return url.toString();
}

/**
 * 打开 URL / 应用 / 文件。使用参数数组 spawn，不经过 shell，避免命令注入。
 * @param {{target: string, kind?: 'auto'|'url'|'app'|'file', args?: string[]}} input
 */
export async function openTarget(input) {
  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (target.length === 0) throw new Error('computer-control invalid-args: target is required');
  const args = Array.isArray(input?.args) ? input.args.map(String) : [];
  let kind = input?.kind ?? 'auto';

  if (kind === 'auto') {
    if (lookLikeUrl(target)) kind = 'url';
    else if (await exists(target)) {
      const lower = target.toLowerCase();
      kind = /\.(exe|bat|cmd|com)$/u.test(lower) ? 'app' : 'file';
    } else {
      kind = 'app';
    }
  }

  if (kind === 'url') {
    const url = assertHttpUrl(target);
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();
    return { target: url, kind, pid: child.pid ?? null, startedAt: Date.now() };
  }

  if (kind === 'file') {
    const absolute = isAbsolute(target) ? resolve(target) : resolve(target);
    if (!(await exists(absolute))) throw new Error(`computer-control not-found: file does not exist: ${absolute}`);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`computer-control invalid-args: not a regular file: ${absolute}`);
    const child = spawn('explorer.exe', [absolute], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    return { target: absolute, kind, pid: child.pid ?? null, startedAt: Date.now() };
  }

  if (kind === 'app') {
    const child = spawn(target, args, { detached: true, windowsHide: false, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { target, args, kind, pid: child.pid ?? null, startedAt: Date.now() };
  }

  throw new Error(`computer-control invalid-args: unknown kind ${JSON.stringify(String(kind))}`);
}

function buildWindowArgs(params) {
  const args = ['-Action', String(params.action ?? 'list')];
  if (typeof params.title === 'string' && params.title.length > 0) args.push('-Title', params.title);
  if (typeof params.process === 'string' && params.process.length > 0) args.push('-Process', params.process);
  if (Number.isInteger(params.windowId) && params.windowId > 0) args.push('-WindowId', String(params.windowId));
  if (Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) args.push('-TimeoutMs', String(Math.round(params.timeoutMs)));
  return args;
}

/**
 * @param {{action: 'list'|'focus'|'wait', title?: string, process?: string, windowId?: number, timeoutMs?: number}} params
 * @param {{signal?: AbortSignal, timeoutMs?: number}} opts
 */
export async function windowTool(params, opts = {}) {
  const action = params?.action;
  if (action !== 'list' && action !== 'focus' && action !== 'wait') {
    throw new Error(`computer-control invalid-args: unknown window action ${JSON.stringify(String(action))}`);
  }
  if (action === 'focus' && typeof params.windowId !== 'number' && !params.title && !params.process) {
    throw new Error('computer-control invalid-args: window focus needs windowId, title or process');
  }
  const timeout = action === 'wait' ? Math.min(60_000, Math.max(500, params.timeoutMs ?? 15_000)) : opts.timeoutMs ?? 20_000;
  const result = await runPowerShellScript(WINDOW_TOOL, buildWindowArgs({ ...params, action }), {
    signal: opts.signal,
    timeoutMs: timeout + 5_000,
  });
  return result;
}
