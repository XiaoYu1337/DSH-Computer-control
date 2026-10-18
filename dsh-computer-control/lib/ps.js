/**
 * 运行 plugins/scripts 下的 PowerShell 助手脚本，并把 stdout 的最后一行 JSON
 * 解析为对象。助手契约：stdout 只输出一个 JSON 对象；失败时 {ok:false,code,message}。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

function parseJsonObject(text) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/u, '').trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    const lines = trimmed.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (line.length === 0) continue;
      try {
        const value = JSON.parse(line);
        if (value !== null && typeof value === 'object') return value;
      } catch {
        // 继续向前找
      }
    }
    return undefined;
  }
}

/**
 * @param {string} scriptPath 绝对路径
 * @param {string[]} args 追加参数
 * @param {{signal?: AbortSignal, timeoutMs?: number}} opts
 */
export async function runPowerShellScript(scriptPath, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const child = spawn(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer;

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener?.('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (!cleanup()) return;
      child.kill();
      reject(makeError('aborted', 'helper aborted by caller'));
    };
    const finish = (error) => {
      if (!cleanup()) return;
      if (error) {
        reject(error);
        return;
      }
      const value = parseJsonObject(stdout);
      if (value === undefined) {
        reject(
          makeError(
            'invalid-helper-output',
            `helper returned no JSON (stdout tail: ${stdout.slice(-400).replace(/\s+/gu, ' ').trim()}; stderr: ${stderr.slice(-400).replace(/\s+/gu, ' ').trim()})`,
          ),
        );
        return;
      }
      if (value.ok === false) {
        reject(makeError(String(value.code ?? 'helper-error'), String(value.message ?? 'helper failed')));
        return;
      }
      resolve(value);
    };

    timer = setTimeout(() => {
      if (!cleanup()) return;
      child.kill();
      reject(makeError('timeout', `helper timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    opts.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += String(chunk).slice(0, MAX_STDOUT - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_STDERR);
    });
    child.on('error', (error) => finish(makeError('helper-spawn-error', error instanceof Error ? error.message : String(error))));
    child.on('exit', (code) => {
      if (code === 0) finish(undefined);
      else if (!settled) {
        const parsed = parseJsonObject(stdout);
        if (parsed !== undefined && parsed.ok === false) {
          finish(makeError(String(parsed.code ?? 'helper-error'), String(parsed.message ?? `helper exited ${String(code)}`)));
        } else {
          finish(
            makeError(
              'helper-exit',
              `helper exited with code ${String(code)}${stderr.trim() ? `: ${stderr.trim().slice(-600)}` : ''}`,
            ),
          );
        }
      }
    });
  });
}

function makeError(code, message) {
  const error = new Error(`computer-control ${code}: ${message}`);
  error.code = code;
  error.detail = message;
  return error;
}
