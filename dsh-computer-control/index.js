/**
 * dsh-computer-control · Host half
 *
 * 让 Agent 真正接管电脑：
 *   - computer_screenshot / computer_screen_info：截屏识别与屏幕信息
 *   - computer_mouse / computer_keyboard：移动、点击、拖拽、滚动、打字、组合键
 *   - computer_control_state：查看接管状态 / 主动交还控制权
 *
 * 接管状态机（idle → active → paused）：
 *   - 任一操控工具被调用 → active：屏幕四边出现细边框式呼吸绿光 + 顶部「Agent正在操控此电脑」；
 *   - 物理鼠标点击（全局低级键状态轮询，非本插件的合成点击）→ paused：Agent 退出控制，
 *     顶部改为「用户正在操控电脑-点击继续」；
 *   - 用户点「点击继续」（客户端 RPC resume）→ active；
 *   - Agent 主动 release，或所属会话本轮结束 → 回到 idle。
 *
 * paused 期间，新的操控工具调用会阻塞等待用户点「点击继续」（最长 PAUSE_WAIT_MS），
 * 这样「点击继续」确实能接着执行 Agent 原本的动作，而不是让 Agent 直接失败。
 *
 * Windows 输入/截图由 scripts/ 下的常驻 PowerShell 进程完成（JSON-lines 协议）：
 *   scripts/win-automation.ps1  常驻 worker：截图、鼠标、键盘、屏幕信息
 *   scripts/mouse-watch.ps1     常驻 watcher：全局鼠标按下事件（用于识别「用户主动点击」）
 */
import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserTool } from './lib/browser-tools.js';
import { createObserveTools } from './lib/observe-tools.js';
import { createExtraTools } from './lib/tools-extra.js';
import { windowTool } from './lib/win.js';
import { ActionTrace, redactArgs, summarizeResult } from './lib/trace.js';
import { captureScreen } from './lib/verify.js';

/** 插件名（Loader 行 id 与客户端清单 id 都用它）。 */
export const name = 'dsh-computer-control';

/** 需要的宿主服务：工具注册、系统提示、RPC 通道的信任闸门。 */
export const inject = ['tools', 'systemPrompt', 'connection'];

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, 'scripts');
const WORKER_SCRIPT = join(SCRIPTS, 'win-automation.ps1');
const WATCHER_SCRIPT = join(SCRIPTS, 'mouse-watch.ps1');
const OVERLAY_SCRIPT = join(SCRIPTS, 'win-overlay.ps1');
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const IS_WINDOWS = process.platform === 'win32';

/** 用户接管后，操控工具最多等待多久让用户点「点击继续」。 */
const PAUSE_WAIT_MS = 120_000;
/** Agent 本轮结束后，绿光保留这么久再淡出（避免工具调用间隙闪烁）。 */
const RELEASE_GRACE_MS = 1_800;
/** 截图保存在系统图片目录，便于用户随时查看和清理；可用 DSH_CC_SCREENSHOT_DIR 覆盖。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PICTURES_DIR = process.env.DSH_CC_PICTURES_DIR ?? join(homedir(), 'Pictures');
const SCREENSHOT_DIR = process.env.DSH_CC_SCREENSHOT_DIR ?? join(PICTURES_DIR, 'DSH-Computer-Control');
/** 持久审计日志（JSONL，按大小轮转）。 */
const TRACE_DIR = join(DSH_HOME, 'storages', 'computer-control', 'trace');
const AUDIT_PATH = join(TRACE_DIR, 'audit.jsonl');
/** 浮层帧率上限：默认 60；0 = 跟随主显示器刷新率；可用 DSH_CC_OVERLAY_MAX_FPS 覆盖。 */
const OVERLAY_MAX_FPS = (() => {
  const configured = Number(process.env.DSH_CC_OVERLAY_MAX_FPS);
  if (Number.isFinite(configured) && configured >= 0) return Math.min(240, Math.round(configured));
  return 60;
})();
/** DirectComposition 实验开关：默认关；DSH_CC_DX_OVERLAY=1 启用。 */
const OVERLAY_USE_DX = process.env.DSH_CC_DX_OVERLAY === '1';
/** 多窗口开关：默认开启；DSH_CC_MULTI_OVERLAY=0 回退单窗口 GDI。 */
const OVERLAY_USE_MULTI = process.env.DSH_CC_MULTI_OVERLAY !== '0';
/** 客户端 RPC 通道（必须匹配宿主 CHANNEL_PATTERN，且不能占用 /api）。 */
const RPC_CHANNEL = '/dsh-computer-control';
const ENDPOINT_STATE = 'state';
const ENDPOINT_RESUME = 'resume';
/** RPC 请求体上限：本插件只有空 body 或 {}。 */
const MAX_REQUEST_BODY_BYTES = 1024;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** 截短动作字幕里的目标文本。 */
function shortLabel(value, max = 26) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 把工具调用转成一条简短中文动作字幕（不包含 fill 值）。 */
function describeToolCall(name, args = {}) {
  switch (name) {
    case 'computer_browser': {
      const action = String(args.action ?? '');
      if (action === 'fill') {
        const target = args.fieldIndex !== undefined ? `字段#${args.fieldIndex}` : shortLabel(args.text || args.selector);
        return `浏览器填入 ${target}`;
      }
      if (action === 'click' || action === 'find') return `浏览器${action === 'click' ? '点击' : '查找'} ${shortLabel(args.text || args.selector)}`;
      if (action === 'navigate' || action === 'launch') return `浏览器打开 ${shortLabel(args.url)}`;
      if (action === 'read') return '读取网页';
      if (action === 'fields') return '读取表单';
      if (action === 'frames') return '读取 iframe';
      return `浏览器 ${action}`;
    }
    case 'computer_click_text':
      return `点击 ${shortLabel(args.query)}`;
    case 'computer_find_text':
      return `查找 ${shortLabel(args.query)}`;
    case 'computer_open':
      return `打开 ${shortLabel(args.target, 36)}`;
    case 'computer_wait':
      return `等待 ${shortLabel(args.value ?? args.waitFor)}`;
    case 'computer_screenshot':
      return '截取屏幕';
    case 'computer_window':
      return `窗口 ${shortLabel(args.action ?? '')}`;
    case 'computer_mouse':
      return `鼠标 ${shortLabel(args.action ?? '')}`;
    case 'computer_keyboard':
      return args.action === 'type' ? `输入文字 ${String(args.text ?? '').length} 字` : `按键 ${shortLabel(args.keys)}`;
    case 'computer_screen_info':
      return '读取屏幕信息';
    default:
      return name.replace(/^computer_/u, '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell 子进程
// ─────────────────────────────────────────────────────────────────────────────

/** 把一行 JSON 解析成对象；坏行返回 undefined（不抛）。 */
function parseLine(line) {
  const text = line.trim();
  if (text.length === 0) return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 常驻 PowerShell worker：stdin/stdout 各一行 JSON。
 * 首次 start() 才 spawn；进程崩溃后下一次请求会自动重启。
 */
class AutomationWorker {
  #child = null;
  #ready = null;
  #readyResolve = null;
  #readyReject = null;
  #readyTimer = null;
  #buffer = '';
  #stderr = '';
  #pending = new Map();
  #seq = 0;

  /** 启动并等待 ready 行；重复调用返回同一个 Promise。 */
  start() {
    if (this.#child !== null) return this.#ready;
    this.#buffer = '';
    this.#stderr = '';
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    // 提前挂 catch，避免启动失败时出现 unhandled rejection。
    this.#ready.catch(() => {});

    const child = spawn(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER_SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.#child = child;
    child.stdin.on('error', () => {
      // 子进程已退出时写入会 EPIPE；吞掉，由 exit 路径负责回收。
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => this.#onExit(error));
    child.on('exit', (code, signal) => {
      const tail = this.#stderr.trim().slice(-600);
      this.#onExit(
        new Error(
          `computer-control automation worker exited (code=${String(code)}${signal ? `, signal=${signal}` : ''})` +
            (tail.length > 0 ? `: ${tail}` : ''),
        ),
      );
    });
    this.#readyTimer = setTimeout(() => {
      this.#readyReject?.(new Error('computer-control automation worker startup timed out'));
    }, 20_000);
    return this.#ready;
  }

  /** 处理 stdout 数据块（可能一行被拆成多块）。 */
  #onStdout(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      this.#onLine(line);
    }
  }

  /** 处理一行协议消息：ready 行或带 id 的响应行。 */
  #onLine(line) {
    const message = parseLine(line);
    if (message === undefined) return;
    if (message.type === 'ready') {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
      this.#readyResolve?.(message);
      return;
    }
    const id = message.id;
    if (typeof id !== 'number' && typeof id !== 'string') return;
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
    if (message.ok === true) entry.resolve(message.result);
    else {
      const error = message.error !== null && typeof message.error === 'object' ? message.error : {};
      entry.reject(
        new Error(
          `computer-control ${String(error.code ?? 'automation-error')}: ${String(error.message ?? 'unknown error')}`,
        ),
      );
    }
  }

  /** worker 退出：拒绝所有等待中的请求，允许下次请求重启。 */
  #onExit(error) {
    if (this.#child === null) return;
    this.#child = null;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#readyReject?.(error);
    this.#ready = null;
    this.#readyResolve = null;
    this.#readyReject = null;
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
      entry.reject(error);
    }
  }

  /**
   * 发送一个动作并等待响应。
   * @param {string} action - worker 动作名。
   * @param {object} params - 动作参数。
   * @param {{timeoutMs?: number, signal?: AbortSignal}} options - 超时与取消。
   * @returns {Promise<object>} worker 的 result。
   */
  async request(action, params, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const signal = options.signal;
    await this.start();
    if (signal?.aborted === true) throw new Error('computer-control: aborted');
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        onAbort: null,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`computer-control automation action timed out: ${action}`));
      }, timeoutMs);
      if (signal !== undefined) {
        entry.onAbort = () => {
          this.#pending.delete(id);
          clearTimeout(entry.timer);
          reject(new Error('computer-control: aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#pending.set(id, entry);
      try {
        this.#child?.stdin.write(`${JSON.stringify({ id, action, params })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        if (signal !== undefined) signal.removeEventListener('abort', entry.onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 关闭 worker 进程（插件卸载或状态归零时调用）。 */
  stop() {
    const child = this.#child;
    this.#onExit(new Error('computer-control automation worker stopped'));
    if (child !== null) {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // 已退出
      }
    }
  }
}

/**
 * 全局鼠标按下 watcher：识别「用户主动点击鼠标」。
 * 只负责上报，是否算用户点击由状态机按合成输入抑制窗口判断。
 */
class ClickWatcher {
  #child = null;
  #ready = null;
  #readyResolve = null;
  #readyTimer = null;
  #buffer = '';
  #stderr = '';
  #onClick;

  constructor(onClick) {
    this.#onClick = onClick;
  }

  /** 启动 watcher（ready 最多等 8s；等不到也不阻塞目标操作）。 */
  start() {
    if (this.#child !== null) return this.#ready;
    this.#buffer = '';
    this.#stderr = '';
    this.#ready = new Promise((resolve) => {
      this.#readyResolve = resolve;
    });
    const child = spawn(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WATCHER_SCRIPT, '-FilterInjected'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.#child = child;
    child.stdin.on('error', () => {
      // 子进程已退出时写入会 EPIPE；吞掉，由 exit 路径负责回收。
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      let index;
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        const message = parseLine(line);
        if (message === undefined) continue;
        if (message.type === 'ready') {
          clearTimeout(this.#readyTimer);
          this.#readyTimer = null;
          this.#readyResolve?.();
          continue;
        }
        if (message.type === 'click') {
          try {
            this.#onClick(message);
          } catch {
            // 状态机异常不应打断 watcher
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-2000);
    });
    child.on('error', () => this.#onExit());
    child.on('exit', () => this.#onExit());
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      this.#readyResolve?.();
    }, 8_000);
    return this.#ready;
  }

  #onExit() {
    if (this.#child === null) return;
    this.#child = null;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#readyResolve?.();
  }

  /** 停止 watcher（离开 active 状态时调用）。 */
  stop() {
    const child = this.#child;
    this.#onExit();
    if (child !== null) {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // 已退出
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 原生屏幕浮层（整个屏幕四边绿光 + 顶部提示）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 屏幕级浮层 helper：常驻 PowerShell 分层窗口进程。
 * 进程内绘制屏幕四边的细边框呼吸绿光与「Agent正在操控此电脑」胶囊；
 * paused 时显示可点击的「用户正在操控电脑-点击继续」，点中后回传 resume 行。
 */
class NativeOverlay {
  #child = null;
  #ready = null;
  #readyResolve = null;
  #readyReject = null;
  #readyTimer = null;
  #buffer = '';
  #stderr = '';
  #onResume;

  constructor(onResume) {
    this.#onResume = onResume;
  }

  /** 启动并等待 ready；返回是否可用。 */
  start() {
    if (this.#child !== null) return this.#ready;
    this.#buffer = '';
    this.#stderr = '';
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#ready.catch(() => {});
    const child = spawn(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OVERLAY_SCRIPT, '-MaxFps', String(OVERLAY_MAX_FPS), ...(OVERLAY_USE_DX ? ['-UseDx'] : []), ...(OVERLAY_USE_MULTI ? ['-Multi'] : [])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.#child = child;
    child.stdin.on('error', () => {
      // 子进程已退出时写入会 EPIPE；吞掉，由 exit 路径负责回收。
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      let index;
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        const message = parseLine(line);
        if (message === undefined) continue;
        if (message.type === 'ready') {
          clearTimeout(this.#readyTimer);
          this.#readyTimer = null;
          this.#readyResolve?.(true);
          continue;
        }
        if (message.type === 'resume') {
          try {
            this.#onResume();
          } catch {
            // 状态机异常不影响浮层进程
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-2000);
    });
    child.on('error', (error) => this.#onExit(error));
    child.on('exit', (code) => {
      this.#onExit(new Error(`overlay exited (code=${String(code)})`));
    });
    this.#readyTimer = setTimeout(() => {
      this.#readyReject?.(new Error('computer-control overlay startup timed out'));
    }, 12_000);
    return this.#ready;
  }

  /** 浮层进度挂掉：标记不可用，允许上层回退到 Web 浮层。 */
  #onExit(error) {
    if (this.#child === null) return;
    this.#child = null;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#readyReject?.(error);
    this.#ready = null;
    this.#readyResolve = null;
    this.#readyReject = null;
  }

  /** 把一条命令写进 helper 的 stdin（进程不可用时静默忽略）。 */
  #send(command) {
    try {
      this.#child?.stdin.write(`${JSON.stringify(command)}\n`);
    } catch {
      // 进程已退出：由 ready Promise 的失败/退出路径处理回退
    }
  }

  /** 显示指定状态（'active' | 'paused'）。 */
  show(mode) {
    this.#send({ cmd: 'show', mode });
  }

  /** 隐藏浮层（保持进程存活）。 */
  hide() {
    this.#send({ cmd: 'hide' });
  }

  /** 在浮层上显示一条动作字幕（active 时可见）。 */
  caption(text, ttlMs = 1800) {
    const value = String(text ?? '').trim();
    if (value.length === 0) return;
    this.#send({ cmd: 'caption', text: value.slice(0, 60), ttlMs: Math.max(600, Math.min(8000, ttlMs)) });
  }

  /** 在浮层上播放一次点击涟漪（物理屏幕坐标）。 */
  ripple(x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    this.#send({ cmd: 'ripple', x: Math.round(px), y: Math.round(py) });
  }

  /** 关闭 helper 进程。 */
  stop() {
    const child = this.#child;
    try {
      child?.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
      child?.stdin.end();
    } catch {
      // 已退出
    }
    this.#onExit(new Error('computer-control overlay stopped'));
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 已退出
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 接管状态机
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建电脑接管的控制状态。
 * @param {object} ctx - 宿主插件上下文（用于读取 agents 状态）。
 * @returns 状态机对象。
 */
function createController(ctx) {
  /** @type {'idle'|'active'|'paused'} */
  let mode = 'idle';
  let version = 0;
  let since = Date.now();
  /** 最近一条动作字幕（native 浮层 + Web 回退浮层共用）。 */
  let captionText = '';
  let captionUntil = 0;
  let ownerAgentId = null;
  let ownerSessionId = null;
  /** 等待「点击继续」的调用。 */
  const waiters = new Set();
  let worker = null;
  let watcher = null;
  /** 原生屏幕浮层；不可用时回退到 Web UI 浮层。 */
  let overlay = null;
  /** 'native'（屏幕级浮层）| 'web'（回退到 DSH Web UI 浮层）。 */
  let overlayMode = 'native';
  /** 原生浮层启动尝试次数：失败重试有限次，之后固定用 Web 回退，避免反复 spawn。 */
  let overlayAttempts = 0;
  const MAX_OVERLAY_ATTEMPTS = 3;
  /** 合成输入抑制窗口：此时间点之前的点击不算用户点击。 */
  let suppressUntil = 0;
  /** 进行中的操控动作数（用于避免结束态误释放）。 */
  let activeCalls = 0;
  /** 是否在 paused 期间所属轮次已经结束（resume 后需要立即安排收尾）。 */
  let pendingReleaseAfterResume = false;
  let releaseTimer = null;
  let currentScreenshotSize = 0;

  /** 到点执行的定时器集合，dispose 时统一清理。 */
  const timers = new Set();
  function schedule(callback, delayMs) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
    return timer;
  }
  function cancelRelease() {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      timers.delete(releaseTimer);
      releaseTimer = null;
    }
  }

  /** 状态变更：递增版本号，客户端轮询据此刷新。 */
  function transition(next, patch = {}) {
    mode = next;
    version += 1;
    since = Date.now();
    if (Object.hasOwn(patch, 'ownerAgentId')) ownerAgentId = patch.ownerAgentId;
    if (Object.hasOwn(patch, 'ownerSessionId')) ownerSessionId = patch.ownerSessionId;
    syncOverlay();
  }

  /** 创建（惰性）原生浮层；启动失败则回退 Web 浮层。 */
  function ensureOverlay() {
    if (!IS_WINDOWS) {
      overlayMode = 'web';
      return null;
    }
    if (overlay !== null) return overlay;
    if (overlayAttempts >= MAX_OVERLAY_ATTEMPTS) {
      overlayMode = 'web';
      return null;
    }
    overlayAttempts += 1;
    const instance = new NativeOverlay(() => {
      if (mode === 'paused') resume();
    });
    overlay = instance;
    void instance.start().then(
      () => {
        if (overlayMode !== 'native') {
          overlayMode = 'native';
          version += 1; // 让 Web 回退浮层立即隐藏
        }
        if (mode === 'active') instance.show('active');
        else if (mode === 'paused') instance.show('paused');
        else instance.hide();
      },
      (error) => {
        // 原生浮层不可用：让 Web 客户端渲染浮层（工具能力不受影响）。
        if (overlay === instance) {
          overlay = null;
          overlayMode = 'web';
          version += 1;
        }
        ctx.logger?.warn?.(`computer-control: native overlay unavailable: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return instance;
  }

  /** 把当前状态同步到原生浮层。 */
  function syncOverlay() {
    if (mode === 'idle') {
      overlay?.hide();
      return;
    }
    const instance = ensureOverlay();
    if (instance === null) return;
    // start() 是异步的：ready 后按当时最新状态再同步一次；这里先乐观发送。
    instance.show(mode);
  }

  /** 客户端/工具共享的状态快照（不泄漏会话 id）。 */
  function snapshot() {
    return {
      mode,
      version,
      since,
      pauseWaitMs: PAUSE_WAIT_MS,
      overlay: overlayMode,
      caption: captionText,
      captionUntil,
    };
  }

  /** 惰性创建 worker（截图/输入共用，加载一次 Add-Type）。 */
  function ensureWorker() {
    if (worker === null) worker = new AutomationWorker();
    return worker;
  }

  /** 停止并丢弃 watcher。 */
  function stopWatcher() {
    if (watcher !== null) {
      watcher.stop();
      watcher = null;
    }
  }

  /** 返回等待用户接管结束的 Promise。 */
  function waitForResume(signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        onAbort: null,
        timer: null,
      };
      function cleanup() {
        waiters.delete(waiter);
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        waiter.timer = null;
        if (signal !== undefined) signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.timer = setTimeout(() => {
        waiter.reject(new Error('computer-control: user takeover wait timed out'));
      }, timeoutMs);
      waiter.onAbort = () => waiter.reject(new Error('computer-control: aborted'));
      if (signal !== undefined) signal.addEventListener('abort', waiter.onAbort, { once: true });
      waiters.add(waiter);
    });
  }

  /** 用户点击 → Agent 退出控制，进入 paused。 */
  function onClick(event) {
    if (mode !== 'active') return;
    const at = typeof event.at === 'number' ? event.at : Date.now();
    if (at <= suppressUntil) return; // 本插件自己合成的点击
    transition('paused');
    stopWatcher();
  }

  /** active 状态下启动 watcher；取不到就等下一次状态切换再试。 */
  function ensureWatcher() {
    if (!IS_WINDOWS || mode !== 'active') return;
    if (watcher === null) {
      watcher = new ClickWatcher(onClick);
      void watcher.start();
    }
  }

  /** Agent 进入 idle（本轮结束）：绿光保留一小会儿再淡出到 idle。 */
  function onAgentIdle(agentId) {
    if (mode !== 'active') return;
    if (agentId !== undefined && agentId !== null && ownerAgentId !== null && agentId !== ownerAgentId) return;
    if (activeCalls > 0) return;
    scheduleRelease();
  }

  /** Agent 被销毁：立即收回控制。 */
  function onAgentDisposed(agentId) {
    if (mode === 'idle') return;
    if (agentId !== undefined && agentId !== null && ownerAgentId !== null && agentId !== ownerAgentId) return;
    release('agent-disposed');
  }

  /** 所属 Agent 是否仍在跑轮次（用于判断 resume 后是否还需要自动释放）。 */
  function ownerRunning() {
    if (ownerAgentId === null) return false;
    const agents = ctx.get('agents');
    if (agents === undefined) return false;
    try {
      return agents.get(ownerAgentId)?.status === 'running';
    } catch {
      return false;
    }
  }

  /** 本轮结束后延迟淡出（真正回到 idle）。 */
  function scheduleRelease() {
    cancelRelease();
    releaseTimer = schedule(() => {
      releaseTimer = null;
      if (mode !== 'active') return;
      if (activeCalls > 0) return;
      release('agent-idle');
    }, RELEASE_GRACE_MS);
  }

  /**
   * 任何操控动作之前：确保处于 active；paused 时等待用户「点击继续」。
   * @param {object|undefined} agent - 调用工具的那个 Agent。
   * @param {AbortSignal|undefined} signal - 工具调用取消信号。
   */
  async function begin(agent, signal) {
    cancelRelease();
    if (mode === 'paused') {
      await waitForResume(signal, PAUSE_WAIT_MS);
    }
    if (mode !== 'active') {
      transition('active', {
        ownerAgentId: agent?.id ?? agent?.session?.id ?? null,
        ownerSessionId: agent?.session?.id ?? agent?.id ?? null,
      });
    } else if (agent !== undefined && agent !== null && (agent.id ?? agent.session?.id) !== undefined) {
      ownerAgentId = agent.id ?? agent.session?.id ?? ownerAgentId;
      ownerSessionId = agent.session?.id ?? ownerAgentId;
    }
    ensureWatcher();
  }

  /**
   * 执行一个操控动作（截图/鼠标/键盘）。
   * @param {string} action - worker 动作。
   * @param {object} params - 动作参数。
   * @param {{agent?: object, signal?: AbortSignal, timeoutMs?: number}} options - 调用上下文。
   */
  async function runAction(action, params, options = {}) {
    if (!IS_WINDOWS) throw new Error('computer-control: this plugin currently supports Windows only');
    await begin(options.agent, options.signal);
    activeCalls += 1;
    // 本动作执行期间及结束后极短时间内，watcher 收到的点击视为合成输入。
    suppressUntil = Date.now() + 1_500;
    notifyWorkerAction(action, params);
    try {
      return await ensureWorker().request(action, params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 15_000,
      });
    } finally {
      activeCalls = Math.max(0, activeCalls - 1);
      suppressUntil = Math.max(suppressUntil, Date.now() + 400);
      if (ownerAgentId !== null && !ownerRunning()) scheduleRelease();
    }
  }

  /**
   * 执行一个非 worker 的控制任务（浏览器 / 等待 / OCR / 窗口 / 打开应用）。
   * task 接收 {request, signal, agent}；request 直接调用自动化 worker（截图/鼠标等）。
   * @param {(task: {request: Function, signal?: AbortSignal, agent?: object}) => Promise<any>} task
   * @param {{agent?: object, signal?: AbortSignal}} options
   */
  async function runTask(task, options = {}) {
    if (!IS_WINDOWS) throw new Error('computer-control: this plugin currently supports Windows only');
    await begin(options.agent, options.signal);
    activeCalls += 1;
    suppressUntil = Date.now() + 1_500;
    try {
      return await task({
        request: (action, params, requestOptions = {}) =>
          ensureWorker().request(action, params, {
            signal: options.signal,
            timeoutMs: requestOptions.timeoutMs ?? 15_000,
          }),
        signal: options.signal,
        agent: options.agent,
      });
    } finally {
      activeCalls = Math.max(0, activeCalls - 1);
      suppressUntil = Math.max(suppressUntil, Date.now() + 400);
      if (ownerAgentId !== null && !ownerRunning()) scheduleRelease();
    }
  }

  /**
   * 只读诊断：启动 worker / 执行检查，但不进入 active、不显示接管浮层。
   * @param {(ctx: {request: Function, snapshot: Function}) => Promise<any>} task
   */
  async function diagnostics(task) {
    return await task({
      request: (action, params, options = {}) =>
        ensureWorker().request(action, params, {
          timeoutMs: options.timeoutMs ?? 15_000,
        }),
      snapshot,
    });
  }

  /** 用户点了「点击继续」：恢复 Agent 控制。 */
  function resume() {
    if (mode !== 'paused') return snapshot();
    cancelRelease();
    transition('active');
    ensureWatcher();
    for (const waiter of [...waiters]) waiter.resolve(true);
    waiters.clear();
    const shouldRelease = pendingReleaseAfterResume || !ownerRunning();
    pendingReleaseAfterResume = false;
    if (shouldRelease) scheduleRelease();
    return snapshot();
  }

  /** 一轮结束（durable turn/end）：Agent 不再需要控制时淡出。 */
  function onTurnEnd(sessionId) {
    if (sessionId === null || sessionId === undefined || ownerSessionId === null) return;
    if (String(sessionId) !== String(ownerSessionId)) return;
    if (mode === 'active') {
      if (activeCalls > 0) return;
      scheduleRelease();
    } else if (mode === 'paused') {
      // 用户接管期间本轮已经结束：等用户点「点击继续」后立即收尾，不把横幅永久留在屏幕上。
      pendingReleaseAfterResume = true;
    }
  }

  /** 主动交还/收回控制（Agent 调用 release，或所属轮次结束）。 */
  function release(reason = 'released') {    if (mode === 'idle') return snapshot();
    cancelRelease();
    pendingReleaseAfterResume = false;
    stopWatcher();
    for (const waiter of [...waiters]) waiter.reject(new Error(`computer-control: control released (${reason})`));
    waiters.clear();
    transition('idle', { ownerAgentId: null, ownerSessionId: null });
    return snapshot();
  }

  /** 插件卸载：停掉一切并拒绝等待者。 */
  function dispose() {
    cancelRelease();
    stopWatcher();
    for (const waiter of [...waiters]) waiter.reject(new Error('computer-control: plugin disposed'));
    waiters.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    overlay?.stop();
    overlay = null;
    worker?.stop();
    worker = null;
  }

  /** 预启动屏幕浮层，缩短首次接管时的绿光出现延迟（隐藏状态）。 */
  function prewarm() {
    if (IS_WINDOWS) void ensureOverlay();
  }

  /** 浮层动作字幕（native 与 Web 回退浮层共用；快照供客户端轮询）。 */
  function caption(text, ttlMs) {
    const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (clean.length === 0) return;
    const ttl = Math.max(600, Math.min(8_000, Number(ttlMs) || 1_600));
    captionText = clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
    captionUntil = Date.now() + ttl;
    overlay?.caption(captionText, ttl);
  }

  /** 浮层点击涟漪（物理屏幕坐标；native 浮层可用时）。 */
  function ripple(x, y) {
    overlay?.ripple(x, y);
  }

  /** worker 动作 -> 字幕 + 点击涟漪。 */
  function notifyWorkerAction(action, params = {}) {
    const labels = {
      click: '点击',
      double_click: '双击',
      right_click: '右键点击',
      middle_click: '中键点击',
      move: '移动鼠标',
      scroll: '滚动',
      drag: '拖拽',
      type: `输入 ${String(params.text ?? '').length} 字`,
      press: `按键 ${shortLabel(params.keys)}`,
      screenshot: '截取屏幕',
      screenInfo: '读取屏幕信息',
    };
    const label = labels[action];
    if (label !== undefined) caption(label, 1_600);
    if (['click', 'double_click', 'right_click', 'middle_click', 'drag'].includes(action)) {
      const x = Number(params.x);
      const y = Number(params.y);
      if (Number.isFinite(x) && Number.isFinite(y)) ripple(x, y);
    }
  }

  /** 递增截图序号（仅用于文件命名）。 */
  function nextScreenshotIndex() {
    currentScreenshotSize += 1;
    return currentScreenshotSize;
  }

  return {
    snapshot,
    begin,
    runAction,
    runTask,
    diagnostics,
    resume,
    release,
    dispose,
    prewarm,
    caption,
    ripple,
    nextScreenshotIndex,
    onAgentIdle,
    onAgentDisposed,
    onTurnEnd,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具定义
// ─────────────────────────────────────────────────────────────────────────────

const objectOutput = (schema, text) => ({
  schema,
  render: (_args, value) => [{ type: 'text', text: text(value) }],
});

/** 文本型输出（大多数工具的结果只需要给模型一段可读回执）。 */
const textOutput = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render: render,
});

/** 截图文件清理：最多保留 120 张、72 小时内。 */
async function pruneScreenshots(screenshotDir) {
  try {
    const entries = await readdir(screenshotDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
      const path = join(screenshotDir, entry.name);
      try {
        const info = await stat(path);
        files.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        // 文件刚被删/权限问题：忽略
      }
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const now = Date.now();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (index < 120 && now - file.mtimeMs < 72 * 3_600_000) continue;
      await unlink(file.path).catch(() => {});
    }
  } catch {
    // 清理失败不影响截图主流程
  }
}

/** 归一化数字参数，非法返回 undefined。 */
const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** 读取 PNG IHDR 中的尺寸。 */
async function readPngSize(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) {
      throw new Error(`computer-control invalid-args: not a PNG screenshot: ${path}`);
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

/**
 * 把「截图内像素坐标」换算成物理屏幕坐标：
 * 优先读截图 sidecar（含 origin/scale/source 尺寸），旧图按 PNG 实际尺寸 + scale=1。
 */
async function resolveScreenshotPoint(input) {
  const path = typeof input?.path === 'string' ? input.path : '';
  const x = asNumber(input?.x);
  const y = asNumber(input?.y);
  if (path.length === 0 || x === undefined || y === undefined) {
    throw new Error('computer-control invalid-args: from_screenshot needs {path, x, y}');
  }
  let meta = null;
  try {
    meta = JSON.parse(await readFile(`${path}.json`, 'utf8'));
  } catch {
    meta = null;
  }
  if (meta === null || typeof meta !== 'object') {
    const size = await readPngSize(path);
    meta = { x: 0, y: 0, width: size.width, height: size.height, sourceWidth: size.width, sourceHeight: size.height, scale: 1 };
  }
  const width = asNumber(meta.width);
  const sourceWidth = asNumber(meta.sourceWidth);
  const scale = asNumber(meta.scale) ?? (width !== undefined && sourceWidth !== undefined && width > 0 ? sourceWidth / width : 1);
  const originX = asNumber(meta.x) ?? 0;
  const originY = asNumber(meta.y) ?? 0;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('computer-control invalid-args: screenshot sidecar has invalid scale');
  }
  return { x: originX + x / scale, y: originY + y / scale };
}

/** 鼠标工具的动作到 worker 调用映射。 */
function mouseWorkerCall(args) {  switch (args.action) {
    case 'move':
      return {
        action: 'move',
        params: { x: asNumber(args.x), y: asNumber(args.y), durationMs: asNumber(args.duration_ms) ?? 260 },
        summary: (result) => `Mouse moved to (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'click':
      return {
        action: 'click',
        params: {
          button: 'left',
          count: 1,
          x: asNumber(args.x),
          y: asNumber(args.y),
          intervalMs: asNumber(args.interval_ms) ?? 120,
        },
        summary: (result) => `Left click at (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'double_click':
      return {
        action: 'click',
        params: { button: 'left', count: 2, x: asNumber(args.x), y: asNumber(args.y), intervalMs: 120 },
        summary: (result) => `Left double-click at (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'right_click':
      return {
        action: 'click',
        params: { button: 'right', count: 1, x: asNumber(args.x), y: asNumber(args.y) },
        summary: (result) => `Right click at (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'middle_click':
      return {
        action: 'click',
        params: { button: 'middle', count: 1, x: asNumber(args.x), y: asNumber(args.y) },
        summary: (result) => `Middle click at (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'scroll':
      return {
        action: 'scroll',
        params: {
          delta: asNumber(args.delta) ?? 120,
          x: asNumber(args.x),
          y: asNumber(args.y),
        },
        summary: (result) => `Scrolled ${String(result.delta)} at (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'drag':
      return {
        action: 'drag',
        params: {
          from: { x: asNumber(args.x), y: asNumber(args.y) },
          to: { x: asNumber(args.to_x), y: asNumber(args.to_y) },
          button: 'left',
          durationMs: asNumber(args.duration_ms) ?? 400,
        },
        summary: (result) => `Dragged to (${result.cursor.x}, ${result.cursor.y}).`,
      };
    case 'position':
      return {
        action: 'cursor',
        params: {},
        summary: (result) => `Cursor is at (${result.cursor.x}, ${result.cursor.y}).`,
      };
    default:
      return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 宿主半注册：工具、系统提示、RPC 通道、Agent 生命周期监听。
 * @param {object} ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  const controller = createController(ctx);
  // 预启动屏幕级浮层（隐藏），让首次接管时绿光更快出现。
  controller.prewarm();

  /** 本轮结束（durable turn/end）→ 稍后淡出绿光；paused 时等用户续接后再收尾。 */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    controller.onTurnEnd(session?.id);
  });
  /** Agent 被销毁 → 立即收回控制。 */
  ctx.on('agent/disposed', (payload) => {
    controller.onAgentDisposed(payload?.agent?.id);
  });
  /** 插件卸载 → 释放状态与子进程。 */
  ctx.effect(() => () => controller.dispose(), 'computer-control: dispose');

  // ── 系统提示：把接管语义讲清楚（工具描述本身保持精简）────────────────────────
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'computer-control',
        order: 320,
        text: [
          '## Computer control',
          'You can operate the user\'s computer with `computer_screen_info`, `computer_screenshot`, `computer_mouse` and `computer_keyboard`. While you use them the user sees a thin emerald border glow around the screen edges and a top banner "Agent正在操控此电脑".',
          'If the user clicks the mouse, control pauses and the banner changes to "用户正在操控电脑-点击继续"; a control call that is waiting then blocks until the user clicks 点击继续 (or times out with `user takeover wait timed out`). If that happens, stop and ask the user to click 点击继续 instead of retrying in a loop.',
          'Screenshots are PNG files: call `read_image` with the returned path to see the screen. Screenshot results include scale/source dimensions; prefer `computer_mouse` with from_screenshot coordinates over manual conversion. IMPORTANT: image previews may be downscaled; always use the actual PNG pixel dimensions for x/y, never coordinates read from a scaled preview. For canvas text/buttons prefer `computer_click_text` (OCR on the actual bitmap). When you are done controlling the computer, call `computer_control_state` with action `release` so the user gets control back immediately.',
          'Prefer semantic tools over coordinate guessing: `computer_open` (URL/app), `computer_window` (list/focus/wait), `computer_wait` (text/url/window/stable), `computer_find_text` and `computer_click_text` (page DOM → UIA → OCR). For web tasks prefer `computer_browser` (launch/attach/navigate/read/click/fill/wait) which controls Edge through CDP and returns URL/title/verification. For windows/canvas where coordinates matter, use `computer_capture_window` then `computer_window_click` with image-relative x/y; the sidecar maps through the window origin and image scale exactly. Use raw screenshot coordinates only as a fallback.',
        ].join('\n'),
      }),
    'computer-control: system prompt',
  );

  // ── 工具 ────────────────────────────────────────────────────────────────────
  const tools = [
    {
      name: 'computer_screenshot',
      description:
        'Capture the computer screen (full virtual desktop, one monitor, or a region) to a PNG file. By default the DeepSeek Harness window is temporarily hidden so it does not appear in the capture; set skipDsh=false to include it. Returns the absolute path and pixel size; call read_image with that path to actually see the screen content.',
      parameters: {
        type: 'object',
        properties: {
          skipDsh: {
            type: 'boolean',
            description: 'Temporarily hide the DeepSeek Harness window during capture, default true. Set false to capture DSH itself.',
          },
          monitor: {
            type: 'integer',
            minimum: 0,
            description: 'Monitor index from computer_screen_info. Omit for the whole virtual desktop.',
          },
          region: {
            type: 'object',
            description: 'Optional rectangle in absolute screen pixels. Omit to capture the whole target.',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number', minimum: 1 },
              height: { type: 'number', minimum: 1 },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          scale: {
            type: 'number',
            minimum: 0.1,
            maximum: 1,
            description: 'Resize factor of the saved image, default 1 (full resolution).',
          },
        },
        additionalProperties: false,
      },
      output: objectOutput(
        {
          type: 'object',
          properties: {
            path: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            x: { type: 'number' },
            y: { type: 'number' },
            sourceWidth: { type: 'number' },
            sourceHeight: { type: 'number' },
            scale: { type: 'number' },
            fileBytes: { type: 'number' },
            skippedDsh: { type: 'object', additionalProperties: true },
          },
          required: ['path', 'width', 'height'],
          additionalProperties: true,
        },
        (value) =>
          `Screenshot saved to ${value.path} (${value.width}x${value.height} px, origin ${value.x ?? 0},${value.y ?? 0}, scale ${value.scale ?? 1}; source ${value.sourceWidth ?? value.width}x${value.sourceHeight ?? value.height}${value.skippedDsh ? `; skipped DSH ${String(value.skippedDsh.title ?? value.skippedDsh.hwnd)}` : ''}). Call read_image with this path to inspect it.`,
      ),
      async execute(args, exec) {
        await mkdir(SCREENSHOT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
        const path = join(SCREENSHOT_DIR, `screen-${stamp}-${String(controller.nextScreenshotIndex())}.png`);
        const params = { path };
        let skippedDsh = null;
        if (args.skipDsh !== false) {
          try {
            const listed = await windowTool({ action: 'list' }, { signal: exec?.signal });
            const windows = Array.isArray(listed.windows) ? listed.windows : [];
            const candidates = windows.filter(
              (item) =>
                /deepseek\s*harness/iu.test(String(item.process ?? '')) ||
                /deepseek\s*harness/iu.test(String(item.title ?? '')),
            );
            candidates.sort((a, b) => {
              if ((b.foreground === true) !== (a.foreground === true)) return b.foreground === true ? 1 : -1;
              return Number(b.w) * Number(b.h) - Number(a.w) * Number(a.h);
            });
            const dshWindow = candidates[0];
            if (dshWindow !== undefined && Number.isFinite(Number(dshWindow.hwnd))) {
              params.hideHwnd = Number(dshWindow.hwnd);
              skippedDsh = {
                hwnd: Number(dshWindow.hwnd),
                title: String(dshWindow.title ?? ''),
                process: String(dshWindow.process ?? ''),
              };
            }
          } catch {
            // Window enumeration is best-effort; capture still proceeds without skipping.
          }
        }
        if (typeof args.monitor === 'number') params.monitor = args.monitor;
        if (args.region !== null && typeof args.region === 'object') params.region = args.region;
        if (typeof args.scale === 'number') params.scale = args.scale;
        const result = await controller.runAction('screenshot', params, { agent: exec?.agent, signal: exec?.signal, timeoutMs: 25_000 });
        void pruneScreenshots(SCREENSHOT_DIR);
        const scale =
          typeof result.scale === 'number'
            ? result.scale
            : typeof result.sourceWidth === 'number' && typeof result.width === 'number' && result.width > 0
              ? result.width / result.sourceWidth
              : 1;
        const value = {
          path: result.path,
          width: result.width,
          height: result.height,
          sourceWidth: result.sourceWidth ?? result.width,
          sourceHeight: result.sourceHeight ?? result.height,
          scale,
        };
        if (typeof result.x === 'number') value.x = result.x;
        if (typeof result.y === 'number') value.y = result.y;
        if (typeof result.fileBytes === 'number') value.fileBytes = result.fileBytes;
        if (skippedDsh !== null) value.skippedDsh = skippedDsh;
        // sidecar：让 computer_mouse 的 from_screenshot 能自动换算保存图 → 物理坐标。
        const meta = {
          version: 1,
          path: value.path,
          width: value.width,
          height: value.height,
          x: value.x ?? 0,
          y: value.y ?? 0,
          sourceWidth: value.sourceWidth,
          sourceHeight: value.sourceHeight,
          scale,
          createdAt: new Date().toISOString(),
        };
        await writeFile(`${value.path}.json`, JSON.stringify(meta), 'utf8').catch(() => {});
        return value;
      },
    },
    {
      name: 'computer_capture_window',
      description:
        'Capture one top-level window by title regex to a PNG and return both window and client mapping. Use area=client to exclude title bar/shadow; the sidecar records the exact capture origin and image scale, so computer_window_click turns image coordinates back into exact physical screen pixels. Prefer this over estimating coordinates from a full-screen screenshot.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Window title regex (case-insensitive).' },
          area: { type: 'string', enum: ['client', 'window'], description: 'Capture the client area (default) or the full window rect.' },
          scale: { type: 'number', minimum: 0.1, maximum: 1, description: 'Optional image scale, default 1.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: objectOutput(
        { type: 'object', additionalProperties: true },
        (value) =>
          `Window capture saved to ${String(value.path)} (${String(value.width)}x${String(value.height)} px, ${String(value.area)} ${String(value.captureRect.x)},${String(value.captureRect.y)} ${String(value.captureRect.w)}x${String(value.captureRect.h)}, scale ${String(value.scale)}). Use computer_window_click with this path and image-relative x/y.`,
      ),
      async execute(args, exec) {
        if (typeof args.title !== 'string' || args.title.trim().length === 0) {
          throw new Error('computer-control invalid-args: title is required');
        }
        const listed = await windowTool({ action: 'list' }, { signal: exec?.signal });
        const windows = Array.isArray(listed.windows) ? listed.windows : [];
        let regex;
        try {
          regex = new RegExp(args.title, 'iu');
        } catch {
          throw new Error('computer-control invalid-args: title is not a valid regex');
        }
        const window = windows.find((item) => regex.test(String(item.title ?? '')));
        if (window === undefined) throw new Error(`computer-control window_not_found: no window matched ${args.title}`);
        const area = args.area === 'window' ? 'window' : 'client';
        const full = {
          x: Math.round(Number(window.x ?? 0)),
          y: Math.round(Number(window.y ?? 0)),
          w: Math.max(1, Math.round(Number(window.w ?? 0))),
          h: Math.max(1, Math.round(Number(window.h ?? 0))),
        };
        const client = {
          x: Math.round(Number(window.clientX ?? full.x)),
          y: Math.round(Number(window.clientY ?? full.y)),
          w: Math.max(1, Math.round(Number(window.clientW ?? full.w))),
          h: Math.max(1, Math.round(Number(window.clientH ?? full.h))),
        };
        const captureRect = area === 'client' ? client : full;
        const x = captureRect.x;
        const y = captureRect.y;
        const w = captureRect.w;
        const h = captureRect.h;
        // A screen crop only returns the target window when that window is
        // actually visible. Focus it first and verify; otherwise we would
        // silently capture DSH (or another occluding window) while keeping the
        // target's origin in the sidecar.
        await windowTool({ action: 'focus', windowId: Number(window.hwnd) }, { signal: exec?.signal });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const afterFocus = await windowTool({ action: 'list' }, { signal: exec?.signal });
        const focused = Array.isArray(afterFocus.windows)
          ? afterFocus.windows.find((item) => Number(item.hwnd) === Number(window.hwnd))
          : undefined;
        if (focused === undefined || focused.foreground !== true) {
          throw new Error(`computer-control window_not_foreground: ${String(window.title ?? '')} could not be raised for capture`);
        }
        await mkdir(SCREENSHOT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
        const path = join(SCREENSHOT_DIR, `window-${stamp}-${String(controller.nextScreenshotIndex())}.png`);
        const params = { path, region: { x, y, width: w, height: h } };
        if (typeof args.scale === 'number') params.scale = args.scale;
        const shot = await controller.runAction('screenshot', params, {
          agent: exec?.agent,
          signal: exec?.signal,
          timeoutMs: 25_000,
        });
        const width = Number(shot.width ?? w);
        const height = Number(shot.height ?? h);
        const scaleX = w / width;
        const scaleY = h / height;
        const meta = {
          version: 2,
          capture: path,
          hwnd: window.hwnd ?? null,
          title: window.title ?? '',
          area,
          window: { ...full, hwnd: window.hwnd ?? null, title: window.title ?? '' },
          client,
          captureRect,
          image: { width, height },
          scale: Number(shot.scale ?? 1),
          scaleX,
          scaleY,
        };
        await writeFile(`${path}.window.json`, JSON.stringify(meta), 'utf8');
        return {
          path,
          width,
          height,
          area,
          window: meta.window,
          client,
          captureRect,
          image: { width, height },
          scale: Number(shot.scale ?? 1),
          scaleX,
          scaleY,
          hwnd: window.hwnd ?? null,
        };
      },
    },
    {
      name: 'computer_window_click',
      description:
        'Click at image-relative coordinates inside a window captured by computer_capture_window. The tool reads the capture sidecar and maps x/y through the window origin and image scale to exact physical screen pixels; no eyeballing or manual conversion.',
      parameters: {
        type: 'object',
        properties: {
          capture: { type: 'string', description: 'PNG path returned by computer_capture_window.' },
          x: { type: 'number', description: 'X in captured image pixels (0 = left edge).' },
          y: { type: 'number', description: 'Y in captured image pixels (0 = top edge).' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left.' },
          double: { type: 'boolean', description: 'Double-click when true.' },
        },
        required: ['capture', 'x', 'y'],
        additionalProperties: false,
      },
      output: objectOutput(
        { type: 'object', additionalProperties: true },
        (value) => `Clicked window-relative (${String(value.imageX)}, ${String(value.imageY)}) → screen (${String(value.screenX)}, ${String(value.screenY)}).`,
      ),
      async execute(args, exec) {
        if (typeof args.capture !== 'string' || args.capture.length === 0) {
          throw new Error('computer-control invalid-args: capture is required');
        }
        let meta;
        try {
          meta = JSON.parse(await readFile(`${args.capture}.window.json`, 'utf8'));
        } catch {
          throw new Error('computer-control invalid-args: capture sidecar missing; call computer_capture_window first');
        }
        const imageX = Number(args.x);
        const imageY = Number(args.y);
        if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) {
          throw new Error('computer-control invalid-args: x and y must be finite numbers');
        }
        if (imageX < 0 || imageY < 0 || imageX > meta.image.width || imageY > meta.image.height) {
          throw new Error(`computer-control invalid-args: point outside capture (${String(meta.image.width)}x${String(meta.image.height)})`);
        }
        const origin = meta.captureRect ?? meta.window;
        const screenX = Math.round(Number(origin.x) + imageX * Number(meta.scaleX ?? 1));
        const screenY = Math.round(Number(origin.y) + imageY * Number(meta.scaleY ?? 1));
        let raised = false;
        if (Number.isFinite(Number(meta.hwnd))) {
          await windowTool({ action: 'focus', windowId: Number(meta.hwnd) }, { signal: exec?.signal });
          await new Promise((resolve) => setTimeout(resolve, 80));
          raised = true;
        }
        const result = await controller.runAction('click', {
          button: args.button ?? 'left',
          count: args.double === true ? 2 : 1,
          x: screenX,
          y: screenY,
          intervalMs: 120,
        }, {
          agent: exec?.agent,
          signal: exec?.signal,
          timeoutMs: 20_000,
        });
        return {
          capture: args.capture,
          imageX,
          imageY,
          screenX,
          screenY,
          raised,
          cursor: result.cursor ?? { x: screenX, y: screenY },
        };
      },
    },
    {
      name: 'computer_screen_info',
      description:
        'Report the monitor layout (virtual desktop bounds and per-monitor rectangles), the current cursor position, and the active window title/process. Use this before screenshotting or clicking to translate what you see into absolute coordinates.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: objectOutput(
        { type: 'object', additionalProperties: true },
        (value) => {
          const monitors = Array.isArray(value.monitors)
            ? value.monitors
                .map(
                  (monitor) =>
                    `#${String(monitor.index)} ${String(monitor.width)}x${String(monitor.height)} at (${String(monitor.x)},${String(monitor.y)})${monitor.primary === true ? ' primary' : ''}`,
                )
                .join('; ')
            : 'unknown';
          const active = value.activeWindow;
          const activeText =
            active !== null && typeof active === 'object'
              ? `"${String(active.title ?? '')}" (${String(active.process ?? '')}, pid ${String(active.pid ?? '')})`
              : 'none';
          const cursor = value.cursor ?? { x: 0, y: 0 };
          return `Monitors: ${monitors}. Cursor: (${String(cursor.x)}, ${String(cursor.y)}). Active window: ${activeText}.`;
        },
      ),
      async execute(_args, exec) {
        return controller.runAction('screenInfo', {}, { agent: exec?.agent, signal: exec?.signal, timeoutMs: 15_000 });
      },
    },
    {
      name: 'computer_mouse',
      description:
        'Control the mouse on the computer screen. Coordinates are absolute physical pixels of the virtual desktop (0,0 is the top-left of the primary monitor; other monitors may have negative coordinates). Actions: move, click, double_click, right_click, middle_click, scroll, drag, position. Alternatively pass from_screenshot {path,x,y} with coordinates in a saved screenshot; the plugin maps them to physical pixels using the screenshot sidecar. IMPORTANT: x/y must be actual PNG pixels, not coordinates read from a downscaled preview. For canvas text/buttons prefer computer_click_text. Drag needs x/y (start) and to_x/to_y (end); scroll uses delta in mouse-wheel units (positive = up).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'scroll', 'drag', 'position'],
            description: 'What to do with the mouse.',
          },
          x: { type: 'number', description: 'Absolute x coordinate (optional for click/scroll/drag-start).' },
          y: { type: 'number', description: 'Absolute y coordinate (optional for click/scroll/drag-start).' },
          to_x: { type: 'number', description: 'Drag end x (required for drag).' },
          to_y: { type: 'number', description: 'Drag end y (required for drag).' },
          delta: { type: 'number', description: 'Scroll amount in wheel units (positive = up, 120 per notch).' },
          from_screenshot: {
            type: 'object',
            description: 'Coordinates in a saved screenshot; the plugin reads its sidecar and converts to physical pixels. Do not combine with x/y.',
            properties: {
              path: { type: 'string', description: 'Absolute path returned by computer_screenshot.' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['path', 'x', 'y'],
            additionalProperties: false,
          },
          duration_ms: { type: 'number', minimum: 0, maximum: 5000, description: 'Move/drag animation duration in ms.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: objectOutput(
        {
          type: 'object',
          properties: {
            cursor: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
          required: ['cursor'],
          additionalProperties: true,
        },
        (value) => `Done. Cursor is now at (${String(value.cursor.x)}, ${String(value.cursor.y)}).`,
      ),
      async execute(args, exec) {
        let callArgs = args;
        if (args.from_screenshot !== undefined && args.from_screenshot !== null) {
          if (args.x !== undefined || args.y !== undefined) {
            throw new Error('computer-control invalid-args: pass either x/y or from_screenshot, not both');
          }
          const point = await resolveScreenshotPoint(args.from_screenshot);
          callArgs = { ...args, x: point.x, y: point.y };
        }
        const call = mouseWorkerCall(callArgs);
        if (call === undefined) throw new Error(`computer-control: unknown mouse action "${String(args.action)}"`);
        if (call.action === 'drag') {
          if (call.params.from.x === undefined || call.params.from.y === undefined || call.params.to.x === undefined || call.params.to.y === undefined) {
            throw new Error('computer-control: drag needs x/y (start) and to_x/to_y (end)');
          }
        }
        if (call.action === 'click' && (call.params.x === undefined) !== (call.params.y === undefined)) {
          throw new Error('computer-control: click needs both x and y, or neither');
        }
        const result = await controller.runAction(call.action, call.params, {
          agent: exec?.agent,
          signal: exec?.signal,
          timeoutMs: 20_000,
        });
        return { cursor: result.cursor, action: args.action };
      },
    },
    {
      name: 'computer_keyboard',
      description:
        'Type text or press keys on the computer. action=type inserts arbitrary Unicode text (Chinese included) into the currently focused application via clipboard paste — click/focus the target field first with computer_mouse. action=press sends a key chord such as "ctrl+shift+s", "enter", "win+r", "alt+tab", "f5", or a comma-separated sequence like "ctrl+a,delete".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['type', 'press'], description: 'type = insert text, press = send key chord(s).' },
          text: { type: 'string', maxLength: 20000, description: 'Text to type. Required for action=type.' },
          keys: { type: 'string', maxLength: 255, description: 'Key chord or comma-separated sequence. Required for action=press.' },
          repeat: { type: 'integer', minimum: 1, maximum: 20, description: 'How many times to repeat the chord (default 1).' },
          sensitive: { type: 'boolean', description: 'Do not record the typed text/keys in the action trace (use for passwords).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: objectOutput(
        {
          type: 'object',
          properties: {
            action: { type: 'string' },
            length: { type: 'number' },
            keys: { type: 'string' },
          },
          required: ['action'],
          additionalProperties: true,
        },
        (value) =>
          value.action === 'type'
            ? `Typed ${String(value.length ?? 0)} character(s) into the focused window.`
            : `Pressed ${String(value.keys ?? '')}.`,
      ),
      async execute(args, exec) {
        if (args.action === 'type') {
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('computer-control: action=type needs a non-empty text');
          const result = await controller.runAction('type', { text: args.text }, {
            agent: exec?.agent,
            signal: exec?.signal,
            timeoutMs: 30_000,
          });
          return { action: 'type', length: result.length };
        }
        if (typeof args.keys !== 'string' || args.keys.trim().length === 0) throw new Error('computer-control: action=press needs keys');
        const result = await controller.runAction('key', { keys: args.keys, repeat: args.repeat ?? 1 }, {
          agent: exec?.agent,
          signal: exec?.signal,
          timeoutMs: 20_000,
        });
        return { action: 'press', keys: result.keys ?? args.keys };
      },
    },
    {
      name: 'computer_control_state',
      description:
        'Inspect the computer-control takeover state (idle / active / paused), or give control back to the user with action=release. Call it with action=release when you are done controlling the computer; releasing does not need user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'release'], description: 'status = read state, release = hand control back to the user.' },
        },
        additionalProperties: false,
      },
      output: objectOutput(
        { type: 'object', additionalProperties: true },
        (value) =>
          value.mode === 'idle'
            ? `Computer control: idle (the Agent does not control the computer; overlay: ${String(value.overlay ?? 'native')}).`
            : `Computer control: ${String(value.mode)} (overlay: ${String(value.overlay ?? 'native')})${value.released === true ? ' (released by the Agent)' : ''}.`,
      ),
      async execute(args) {
        if (args.action === 'release') {
          controller.release('agent-request');
          return { ...controller.snapshot(), released: true };
        }
        return controller.snapshot();
      },
    },
  ];

  const trace = new ActionTrace({ limit: 120, auditPath: AUDIT_PATH, maxAuditBytes: 1_048_576, auditBackups: 3 });
  const browserTools = createBrowserTool({ controller });
  const extraTools = createExtraTools({
    controller,
    screenshotDir: SCREENSHOT_DIR,
    getBrowser: browserTools.getBrowser,
  });
  const observeTools = createObserveTools({ controller, trace, screenshotDir: SCREENSHOT_DIR, traceDir: TRACE_DIR });
  ctx.effect(() => () => { void browserTools.dispose(); }, 'computer-control: browser cleanup');
  /** 工具返回值必须是 lossless JSON：去掉 undefined/NaN 等非 JSON 值。 */
  const toJsonSafe = (value) => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  };
  const untraced = new Set(['computer_trace', 'computer_self_test']);
  for (const tool of [...tools, browserTools.tool, ...extraTools, ...observeTools]) {
    const originalExecute = typeof tool.execute === 'function' ? tool.execute.bind(tool) : undefined;
    const shouldTrace = !untraced.has(tool.name);
    const tracedTool =
      originalExecute === undefined
        ? tool
        : {
            ...tool,
            execute: async (args, exec) => {
              const started = Date.now();
              try {
                const value = toJsonSafe(await originalExecute(args, exec));
                if (shouldTrace) {
                  controller.caption(describeToolCall(tool.name, args), 1_600);
                  if (value?.clicked === true && value?.coordinateSpace === 'screen' && value?.target) {
                    const target = value.target;
                    const x = Number(target.x) + Number(target.w ?? 0) / 2;
                    const y = Number(target.y) + Number(target.h ?? 0) / 2;
                    controller.ripple(x, y);
                  }
                  trace.record({
                    tool: tool.name,
                    ok: true,
                    args: redactArgs(args),
                    elapsedMs: Date.now() - started,
                    result: summarizeResult(value),
                  });
                }
                return value;
              } catch (error) {
                if (shouldTrace) {
                  let screenshot = null;
                  try {
                    const captured = await controller.diagnostics(async (ctx) =>
                      await captureScreen(ctx, SCREENSHOT_DIR, 'trace-fail'),
                    );
                    screenshot = captured.path;
                  } catch {
                    screenshot = null;
                  }
                  trace.record({
                    tool: tool.name,
                    ok: false,
                    args: redactArgs(args),
                    elapsedMs: Date.now() - started,
                    error: {
                      code: String(error?.code ?? 'error'),
                      message: String(error instanceof Error ? error.message : error).slice(0, 300),
                    },
                    screenshot,
                  });
                }
                throw error;
              }
            },
          };
    ctx.effect(() => ctx.tools.register(tracedTool), `computer-control: tool ${tool.name}`);
  }

  // ── 客户端 RPC 通道（Web UI 轮询状态 / 点「点击继续」）──────────────────────
  const handleChannelRequest = async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.writeHead(rejection);
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(RPC_CHANNEL.length + 1) : undefined;
    if (req.method !== 'POST' || endpoint === undefined || !isEndpoint(endpoint)) {
      req.resume();
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      req.resume();
      res.writeHead(415);
      res.end('content type must be application/json');
      return;
    }
    const text = await readBoundedBody(req);
    let envelope;
    try {
      envelope = text === undefined ? undefined : JSON.parse(text);
    } catch {
      envelope = undefined;
    }
    if (envelope === undefined) {
      res.writeHead(400);
      res.end('body is not JSON');
      return;
    }
    if (endpoint !== ENDPOINT_STATE && endpoint !== ENDPOINT_RESUME) {
      req.resume();
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request';
    if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') {
      respondJson(res, { type: 'server-response', rpcId, result: failure('bad-request', 'bad client-request envelope') });
      return;
    }
    if (envelope.method !== endpoint) {
      respondJson(res, {
        type: 'server-response',
        rpcId,
        result: failure('bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`),
      });
      return;
    }
    let result;
    try {
      result =
        endpoint === ENDPOINT_RESUME
          ? { ok: true, value: controller.resume() }
          : { ok: true, value: controller.snapshot() };
    } catch (error) {      ctx.logger?.warn?.(error);
      res.writeHead(500);
      res.end(`handler failure: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    respondJson(res, { type: 'server-response', rpcId, result });
  };

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: RPC_CHANNEL, handler: handleChannelRequest }),
      `computer-control: ${RPC_CHANNEL} RPC channel`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC 通道辅助（与宿主 connection 契约一致）
// ─────────────────────────────────────────────────────────────────────────────

/** 失败信封（与宿主 apiProxy 的 err() 同形）。 */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/** 端点路径是否合法（每段都符合宿主 rpc-host 的段规则）。 */
function isEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && ENDPOINT_SEGMENT_PATTERN.test(segment));
}

/** 读取有上限的请求体；超限或不可读返回 undefined。 */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        req.resume();
        return undefined;
      }
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** 回 200 JSON（业务失败也在 200 信封里）。 */
function respondJson(res, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}
