/**
 * Launch a dedicated Microsoft Edge instance for CDP automation.
 *
 * Isolation guarantees:
 *  - Always passes `--user-data-dir=%TEMP%\dsh-cc-edge-<random>`, so the user's normal
 *    Edge profile is never opened or modified.
 *  - Always passes a fresh loopback `--remote-debugging-port`.
 *  - `close()` kills the spawned process tree and recursively removes the temporary
 *    profile. It is idempotent and never throws.
 *
 * Public API:
 *   launchEdge({url, timeoutMs=20000, edgePath?}) ->
 *     {port, pid, profileDir, edgePath, args, version, close()}
 */

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROFILE_PREFIX = 'dsh-cc-edge-';
const IS_WINDOWS = process.platform === 'win32';

function launchError(code, message, extra) {
  const error = new Error(message);
  error.name = 'LaunchError';
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Promisified execFile that never rejects (returns `{ok, code, stdout, stderr}`). */
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          code: error?.code ?? 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error ?? null,
        });
      },
    );
  });
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Locate `msedge.exe` using, in order:
 *   1. well-known Program Files / LocalAppData locations;
 *   2. the "App Paths" registry keys (HKLM/HKCU, including WOW6432Node);
 *   3. `where msedge.exe` on PATH.
 * @returns {Promise<string|null>}
 */
export async function findEdgePath() {
  const seen = new Set();
  const candidates = [];
  const push = (candidate) => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(resolved);
  };

  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
    'C:\\Program Files (x86)',
    'C:\\Program Files',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA) : null,
  ].filter(Boolean);
  for (const root of roots) push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  // Registry "App Paths" (msedge.exe is not always registered, but some installs are).
  const appPathKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ];
  for (const key of appPathKeys) {
    const result = await run('reg.exe', ['query', key, '/ve'], { timeoutMs: 5000 });
    if (!result.ok) continue;
    const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im.exec(result.stdout);
    if (!match) continue;
    let value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value && (await fileExists(value))) return path.resolve(value);
  }

  // PATH lookup.
  const where = await run('where.exe', ['msedge.exe'], { timeoutMs: 5000 });
  if (where.ok) {
    for (const line of where.stdout.split(/\r?\n/)) {
      const value = line.trim();
      if (value && (await fileExists(value))) return path.resolve(value);
    }
  }

  return null;
}

/**
 * Ask the OS for a free TCP port bound to the loopback interface.
 * @returns {Promise<number>}
 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (Number.isInteger(port) && port > 0) resolve(port);
        else reject(launchError('browser_not_launched', 'Could not allocate a loopback port for Edge'));
      });
    });
  });
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function taskkillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!IS_WINDOWS) {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
  const result = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15_000 });
  return result.ok;
}

/**
 * Best-effort scan for Edge processes that reference our private profile directory.
 * This is deliberately scoped to `msedge.exe` command lines containing the unique
 * temp profile path, so a user's normal Edge instance can never match.
 * @param {string} profileDir
 * @returns {Promise<number[]>}
 */
async function findEdgePidsByProfile(profileDir) {
  if (!IS_WINDOWS) return [];
  const escaped = String(profileDir).replace(/'/g, "''");
  const script = [
    `$target = '${escaped}';`,
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" -ErrorAction SilentlyContinue |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |',
    '  Select-Object -ExpandProperty ProcessId) -join ","',
  ].join('\n');
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: 15_000 },
  );
  if (!result.ok) return [];
  return result.stdout
    .trim()
    .split(/[,\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function removeProfileDir(profileDir) {
  const resolved = path.resolve(profileDir);
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(PROFILE_PREFIX)) {
    return false;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

/**
 * Launch an isolated Edge instance and wait for its DevTools endpoint.
 *
 * @param {{url?: string, timeoutMs?: number, edgePath?: string}} [options]
 * @returns {Promise<{
 *   port: number,
 *   pid: number,
 *   profileDir: string,
 *   edgePath: string,
 *   args: string[],
 *   version: object,
 *   close: () => Promise<void>,
 * }>}
 */
export async function launchEdge(options = {}) {
  const url = typeof options.url === 'string' && options.url.length > 0 ? options.url : 'about:blank';
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20_000;

  const edgePath = options.edgePath ?? (await findEdgePath());
  if (!edgePath) {
    throw launchError(
      'browser_not_launched',
      'Microsoft Edge (msedge.exe) was not found in Program Files, App Paths or PATH',
      { probes: ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'registry App Paths', 'where.exe'] },
    );
  }

  const port = await getFreePort();
  const profileDir = path.join(os.tmpdir(), `${PROFILE_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.mkdir(profileDir, { recursive: false });
  } catch (error) {
    throw launchError('browser_not_launched', `Could not create Edge temp profile ${profileDir}: ${error.message}`, {
      profileDir,
      cause: error,
    });
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=msEdgeSyncPromo,msEdgeSigninPromo',
    '--new-window',
    url,
  ];

  let child = null;
  let spawnError = null;
  try {
    child = spawn(edgePath, args, { stdio: 'ignore', windowsHide: true });
  } catch (error) {
    spawnError = error;
  }
  if (!child || spawnError) {
    await removeProfileDir(profileDir);
    throw launchError('browser_not_launched', `Failed to spawn Edge: ${spawnError?.message ?? 'unknown error'}`, {
      edgePath,
      args,
      cause: spawnError,
    });
  }
  child.on('error', (error) => {
    spawnError = error;
  });

  let closePromise = null;
  let version = null;
  let closed = false;

  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (child?.pid) {
        await taskkillTree(child.pid);
      }
      // Give Chromium a moment to release profile locks, then sweep any surviving
      // children that still reference this unique profile directory.
      await sleep(200);
      const leftovers = await findEdgePidsByProfile(profileDir);
      for (const pid of leftovers) {
        if (pid !== child?.pid) await taskkillTree(pid);
      }
      if (leftovers.length > 0) await sleep(250);
      await removeProfileDir(profileDir);
      closed = true;
    })();
    return closePromise;
  };

  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (spawnError) break;
    if (child.exitCode !== null) break;
    try {
      const candidate = await fetchJson(`http://127.0.0.1:${port}/json/version`, Math.min(1500, Math.max(250, deadline - Date.now())));
      if (candidate && typeof candidate.webSocketDebuggerUrl === 'string' && candidate.webSocketDebuggerUrl.length > 0) {
        version = candidate;
        break;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  if (!version) {
    const reason = spawnError
      ? `Edge failed to start: ${spawnError.message}`
      : child.exitCode !== null
        ? `Edge exited early with code ${child.exitCode}`
        : `Edge DevTools endpoint 127.0.0.1:${port} did not become ready within ${timeoutMs}ms`;
    await close();
    throw launchError('browser_not_launched', reason, {
      edgePath,
      port,
      profileDir,
      args,
      cause: lastError ?? spawnError ?? null,
    });
  }

  return {
    port,
    pid: child.pid,
    profileDir,
    edgePath,
    args,
    version,
    get closed() {
      return closed;
    },
    close,
  };
}

export default launchEdge;
