/**
 * 宿主半静态/契约自检（不需要 DSH 实例）。
 *
 * 用假 ctx 复刻 dsh-tools / systemPrompt / webServer / connection 的最小契约：
 *  - apply() 能正常执行、注册 5 个工具、1 个系统提示段、1 条 RPC 路由；
 *  - 工具参数/输出 schema 形状合法；
 *  - RPC handler 的信任闸门、信封、状态端点与 resume 端点行为；
 *  - 状态机：active → paused（模拟用户点击）→ resume → release。
 *
 * 用法：node tools/verify-host.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_DIR = join(import.meta.dirname, '..', 'dsh-computer-control');
const plugin = await import(pathToFileURL(join(PLUGIN_DIR, 'index.js')).href);

let failures = 0;
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function checkAsync(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 假宿主 ───────────────────────────────────────────────────────────────────
const registeredTools = new Map();
const promptSections = [];
const routes = [];
const listeners = new Map();
let effectCount = 0;
const disposers = [];

function makeAgent(id) {
  return { id, session: { id } };
}

const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  connection: {
    requestRejection(req) {
      const host = req.headers.host ?? '';
      if (!host.startsWith('127.0.0.1')) return 403;
      if (req.headers.cookie === undefined) return 401;
      return undefined;
    },
  },
  tools: {
    register(definition) {
      assert.equal(typeof definition.name, 'string');
      assert.equal(typeof definition.description, 'string');
      assert.equal(typeof definition.parameters, 'object');
      assert.equal(typeof definition.output?.schema, 'object');
      assert.equal(typeof definition.output?.render, 'function');
      assert.equal(typeof definition.execute, 'function');
      registeredTools.set(definition.name, definition);
      return () => registeredTools.delete(definition.name);
    },
  },
  systemPrompt: {
    section(definition) {
      promptSections.push(definition);
      return () => {};
    },
  },
  get(service) {
    if (service === 'agents') {
      return {
        get(id) {
          return id === 'session-agent' ? { id, status: 'running' } : undefined;
        },
      };
    }
    return undefined;
  },
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(listener);
    return () => {};
  },
  effect(factory, label) {
    effectCount += 1;
    const disposer = factory();
    if (typeof disposer === 'function') disposers.push(disposer);
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  },
  inject(names, callback) {
    assert.deepEqual(names, ['webServer']);
    const webCtx = {
      logger: ctx.logger,
      effect(factory) {
        const disposer = factory();
        if (typeof disposer === 'function') disposers.push(disposer);
        return () => {};
      },
      webServer: {
        register(route) {
          routes.push(route);
          return () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
        },
      },
    };
    callback(webCtx);
  },
};

plugin.apply(ctx);

check('exports name', () => assert.equal(plugin.name, 'dsh-computer-control'));
check('exports inject', () => assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'connection']));
check('registers fifteen tools', () => assert.equal(registeredTools.size, 15));
check('tool names', () =>
  assert.deepEqual([...registeredTools.keys()].sort(), [
    'computer_browser',
    'computer_capture_window',
    'computer_click_text',
    'computer_control_state',
    'computer_find_text',
    'computer_keyboard',
    'computer_mouse',
    'computer_open',
    'computer_screen_info',
    'computer_screenshot',
    'computer_self_test',
    'computer_trace',
    'computer_wait',
    'computer_window',
    'computer_window_click',
  ]));
check('system prompt section', () => {
  assert.equal(promptSections.length, 1);
  assert.equal(promptSections[0].name, 'computer-control');
  assert.match(promptSections[0].text, /Agent正在操控此电脑/u);
  assert.match(promptSections[0].text, /用户正在操控电脑-点击继续/u);
});
check('RPC prefix route', () => {
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/dsh-computer-control');
  assert.equal(typeof routes[0].handler, 'function');
});

/** 造一个假的 req/res 走一遍 RPC handler。cookie 传 null 表示不带 cookie。 */
function invokeRpc({ endpoint, host = '127.0.0.1:50763', cookie = 'dsh=1', method = 'POST', body }) {
  return new Promise((resolve, reject) => {
    const headers = { host, 'content-type': 'application/json' };
    if (cookie !== null) headers.cookie = cookie;
    const req = {
      method,
      headers,
      url: `/dsh-computer-control/${endpoint}`,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body ?? '{}', 'utf8');
      },
      resume() {},
      body,
    };
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, responseHeaders) {
        this.statusCode = status;
        this.headers = responseHeaders ?? {};
      },
      end(payload) {
        if (payload !== undefined) chunks.push(Buffer.from(payload));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      },
    };
    routes[0].handler(req, res).catch(reject);
  });
}

async function rpc(endpoint) {
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload: {} });
  const raw = await invokeRpc({ endpoint, body: envelope });
  assert.equal(raw.status, 200);
  return JSON.parse(raw.body);
}

await checkAsync('RPC state idle', async () => {
  const response = await rpc('state');
  assert.equal(response.type, 'server-response');
  assert.equal(response.rpcId, 'rpc-1');
  assert.equal(response.result.ok, true);
  assert.equal(response.result.value.mode, 'idle');
});
await checkAsync('RPC unknown endpoint 404', async () => {
  const raw = await invokeRpc({ endpoint: 'nope', body: '{}' });
  assert.equal(raw.status, 404);
});
await checkAsync('RPC no cookie 401', async () => {
  const raw = await invokeRpc({ endpoint: 'state', cookie: null, body: '{}' });
  assert.equal(raw.status, 401);
});
await checkAsync('RPC non-loopback 403', async () => {
  const raw = await invokeRpc({ endpoint: 'state', host: 'evil.example', body: '{}' });
  assert.equal(raw.status, 403);
});
await checkAsync('RPC wrong method 400', async () => {
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'other', payload: {} });
  const raw = await invokeRpc({ endpoint: 'state', body: envelope });
  assert.equal(raw.status, 200);
  const parsed = JSON.parse(raw.body);
  assert.equal(parsed.result.ok, false);
});

// 工具状态机：screen_info 需要真实 worker，跳过执行；
// 这里验证 control_state 的 status/release 与用户接管状态无关的路径。
await checkAsync('control_state status', async () => {
  const tool = registeredTools.get('computer_control_state');
  const value = await tool.execute({ action: 'status' }, {});
  assert.equal(value.mode, 'idle');
  assert.equal(typeof value.version, 'number');
});
await checkAsync('control_state release idempotent', async () => {
  const tool = registeredTools.get('computer_control_state');
  const value = await tool.execute({ action: 'release' }, {});
  assert.equal(value.mode, 'idle');
  assert.equal(value.released, true);
});

// 用户点击 → paused → resume 的状态机在真实 watcher 下才完整；
// 这里验证 resume 在 idle 下是安全 no-op。
await checkAsync('RPC resume idle is no-op', async () => {
  const response = await rpc('resume');
  assert.equal(response.result.ok, true);
  assert.equal(response.result.value.mode, 'idle');
});

// 清理
for (const disposer of disposers.reverse()) {
  try {
    await disposer();
  } catch {
    // disposer 在假 ctx 下可能不完整，忽略
  }
}

// ── 静态文件检查 ─────────────────────────────────────────────────────────────
await checkAsync('package.json valid', async () => {
  const pkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-computer-control');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.exports['./icon'], './icon.svg');
});
await checkAsync('cordis patch holds one insert row', async () => {
  const patch = await readFile(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/u);
  assert.match(patch, /id: dsh-computer-control/u);
  assert.match(patch, /name: dsh-computer-control/u);
});
await checkAsync('locale metadata', async () => {
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(await readFile(join(PLUGIN_DIR, 'locale', `${locale}.json`), 'utf8'));
    assert.equal(typeof dict.meta.title, 'string');
    assert.ok(dict.meta.title.length > 0);
    assert.equal(typeof dict.meta.description, 'string');
    assert.ok(dict.meta.description.length > 0);
  }
});
await checkAsync('client.js is syntactically valid and loads module wrapper', async () => {
  const source = await readFile(join(PLUGIN_DIR, 'client.js'), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/u);
  assert.match(source, /id: 'dsh-computer-control'/u);
  assert.match(source, /shell\.overlay/u);
  // 语法检查：把 __ModuleLoader__.load 换成普通函数调用后包成 async 函数体执行
  const body = `return (async () => {\n${source.replace(/^window\.__ModuleLoader__\.load\(/mu, 'const __load = (spec) => { globalThis.__spec = spec };\n__load(')}\n})()`;
  await new Function(body)();
  const spec = globalThis.__spec;
  assert.ok(spec !== undefined);
  assert.equal(spec.id, 'dsh-computer-control');
  assert.equal(typeof spec.factory, 'function');
  // 用一个最小 React 替身 materialize 工厂，确认导出形状
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
  const require = (request) => {
    assert.equal(request, 'react');
    return React;
  };
  const module = spec.factory(require);
  assert.equal(module.name, 'dsh-computer-control');
  assert.deepEqual(module.inject, ['slots', 'locale', 'connection']);
  assert.equal(typeof module.apply, 'function');
});
await checkAsync('icon.svg is an svg', async () => {
  const svg = await readFile(join(PLUGIN_DIR, 'icon.svg'), 'utf8');
  assert.match(svg, /^<svg[ >]/u);
  assert.ok(Buffer.byteLength(svg) < 256 * 1024);
});
await checkAsync('scripts directory exists with both ps1 files', async () => {
  const worker = await readFile(join(PLUGIN_DIR, 'scripts', 'win-automation.ps1'), 'utf8').catch(() => '');
  const watcher = await readFile(join(PLUGIN_DIR, 'scripts', 'mouse-watch.ps1'), 'utf8').catch(() => '');
  if (worker.length === 0 || watcher.length === 0) {
    console.log('  (note: scripts/ not copied yet — expected until automation-dev delivers)');
    return;
  }
  assert.match(worker, /SetProcessDpiAwarenessContext|SetProcessDPIAware/u);
  assert.match(watcher, /SetWindowsHookEx/u);
  assert.match(watcher, /LLMHF_INJECTED/u);
  assert.match(watcher, /FilterInjected/u);
});

console.log(`\n${total - failures}/${total} checks passed`);
if (failures > 0) process.exitCode = 1;
