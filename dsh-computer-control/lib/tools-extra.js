/**
 * P0 扩展工具：open / window / wait / find_text / click_text。
 * 这层只做编排；实际能力来自 lib/win.js、lib/locator/*、BrowserSession（后续接入）。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { clickBestMatch } from './matching.js';
import { locateText } from './locator/index.js';
import { captureScreen, hashFile } from './verify.js';
import { openTarget, windowTool } from './win.js';

function textOutput(render) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: String(render(args, value)) }],
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('computer-control aborted: wait cancelled');
      error.code = 'aborted';
      reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });

/**
 * @param {{controller: object, screenshotDir: string, getBrowser?: () => object|null}} deps
 */
export function createExtraTools(deps) {
  const { controller, screenshotDir } = deps;
  const getBrowser = deps.getBrowser ?? (() => null);

  /** 截一张图供 OCR 使用；可选 windowTitle 时只截该窗口区域，避免匹配到聊天/其它窗口。 */
  async function screenshotForOcr(task, windowTitle) {
    await mkdir(screenshotDir, { recursive: true });
    const path = join(screenshotDir, `locate-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`);
    const params = { path };
    if (typeof windowTitle === 'string' && windowTitle.length > 0) {
      try {
        if (task.__windowList === undefined) {
          const listed = await windowTool({ action: 'list' }, { signal: task.signal });
          task.__windowList = Array.isArray(listed.windows) ? listed.windows : [];
        }
        const regex = new RegExp(windowTitle, 'iu');
        const window = task.__windowList.find((item) => regex.test(String(item.title ?? '')));
        if (window !== undefined) {
          // 操作/识别窗口前先抬到前台，用户能直接看到 Agent 正在看的界面。
          await windowTool({ action: 'focus', windowId: Number(window.hwnd) }, { signal: task.signal });
          await sleep(100, task.signal);
          params.region = {
            x: Math.round(Number(window.x ?? 0)),
            y: Math.round(Number(window.y ?? 0)),
            width: Math.max(1, Math.round(Number(window.w ?? 0))),
            height: Math.max(1, Math.round(Number(window.h ?? 0))),
          };
        }
      } catch {
        // 窗口查找失败就退回全屏
      }
    }
    const result = await task.request('screenshot', params, { timeoutMs: 20_000 });
    const hash = await hashFile(path);
    return { path, result, hash };
  }

  function locatorDeps(task, extra = {}) {
    return {
      browser: getBrowser(),
      screenshot: () => screenshotForOcr(task, extra.windowTitle),
      getScreenBounds: async () => {
        if (task.__screenBounds === undefined) {
          const info = await task.request('screenInfo', {}, { timeoutMs: 10_000 });
          const monitors = Array.isArray(info.monitors) ? info.monitors : [];
          if (monitors.length === 0) {
            task.__screenBounds = null;
          } else {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const monitor of monitors) {
              minX = Math.min(minX, Number(monitor.x ?? 0));
              minY = Math.min(minY, Number(monitor.y ?? 0));
              maxX = Math.max(maxX, Number(monitor.x ?? 0) + Number(monitor.width ?? 0));
              maxY = Math.max(maxY, Number(monitor.y ?? 0) + Number(monitor.height ?? 0));
            }
            task.__screenBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          }
        }
        return task.__screenBounds;
      },
      signal: task.signal,
      ...extra,
    };
  }

  async function currentPageState(browser) {
    if (browser === null) return null;
    try {
      const url = typeof browser.url === 'function' ? await browser.url() : undefined;
      const title = typeof browser.title === 'function' ? await browser.title() : undefined;
      const hash = typeof browser.screenshotHash === 'function' ? await browser.screenshotHash() : undefined;
      return { url, title, hash };
    } catch {
      return null;
    }
  }

  return [
    {
      name: 'computer_open',
      description:
        'Open a URL, application, or file on the computer. kind=auto detects http(s) URLs and existing files; app targets are launched with an argument array (no shell). Returns the started pid when available. Use computer_window wait to wait for its window.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', minLength: 1, description: 'http(s) URL, executable, or file path.' },
          kind: { type: 'string', enum: ['auto', 'url', 'app', 'file'], description: 'How to interpret target (default auto).' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for app launches.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => `Opened ${String(value.kind)} ${String(value.target)}${value.pid ? ` (pid ${String(value.pid)})` : ''}.`),
      async execute(args, exec) {
        return await controller.runTask(
          async () => await openTarget(args),
          { agent: exec?.agent, signal: exec?.signal, timeoutMs: 20_000 },
        );
      },
    },
    {
      name: 'computer_window',
      description:
        'List, focus/restore, or wait for top-level windows. action=list includes minimized windows (hwnd/title/process/rect/foreground/minimized); set includeHidden=true to also enumerate tray-hidden windows. action=focus activates a window, restoring it first if minimized; action=restore is an explicit alias that also searches hidden windows; action=wait polls until a matching window exists (timeoutMs). Use this instead of guessing taskbar coordinates.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'focus', 'restore', 'wait'] },
          includeHidden: { type: 'boolean', description: 'Include tray-hidden windows in list/focus matching.' },
          title: { type: 'string', description: 'Window title regular expression.' },
          process: { type: 'string', description: 'Process executable name (e.g. msedge).' },
          windowId: { type: 'integer', minimum: 1, description: 'HWND from action=list.' },
          timeoutMs: { type: 'integer', minimum: 200, maximum: 60000, description: 'Wait timeout for action=wait (default 15000).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => {
        if (Array.isArray(value.windows)) {
          const lines = value.windows.slice(0, 12).map((w) => `hwnd ${w.hwnd} "${w.title}" (${w.process}${w.foreground ? ', foreground' : ''}${w.minimized ? ', minimized' : ''}${w.visible === false ? ', hidden' : ''})`);
          return `Windows (${String(value.windows.length)}): ${lines.length > 0 ? lines.join('; ') : 'none'}.`;
        }
        if (value.window !== undefined) {
          return `${value.focused === true ? 'Focused' : 'Found'} hwnd ${String(value.window.hwnd)} "${String(value.window.title)}" (${String(value.window.process)}).`;
        }
        return JSON.stringify(value);
      }),
      async execute(args, exec) {
        return await controller.runTask(
          async () => await windowTool(args, { signal: exec?.signal }),
          { agent: exec?.agent, signal: exec?.signal, timeoutMs: 70_000 },
        );
      },
    },
    {
      name: 'computer_wait',
      description:
        'Wait for a UI condition instead of sleeping: for=text (find text via page/UIA/OCR), for=url (attached browser URL), for=window (window title regex/process), for=stable (screen stops changing). Returns matched + elapsedMs; timeout returns matched=false rather than throwing.',
      parameters: {
        type: 'object',
        properties: {
          for: { type: 'string', enum: ['text', 'url', 'window', 'stable'], description: 'What to wait for.' },
          value: { type: 'string', description: 'Text/query, URL substring, or window title regex.' },
          scope: { type: 'string', enum: ['auto', 'page', 'window', 'screen'], description: 'For for=text: locate scope (default auto).' },
          match: { type: 'string', enum: ['contains', 'exact'], description: 'For for=text (default contains).' },
          process: { type: 'string', description: 'For for=window: process name.' },
          windowTitle: { type: 'string', description: 'For for=text with screen/OCR scope: capture only this window (title regex) to avoid matching other apps.' },
          timeoutMs: { type: 'integer', minimum: 200, maximum: 120000, description: 'Default 15000.' },
          intervalMs: { type: 'integer', minimum: 100, maximum: 2000, description: 'Poll interval (default 250).' },
        },
        required: ['for'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) =>
        value.matched === true
          ? `Wait matched (${String(value.source ?? '')}) after ${String(value.elapsedMs)} ms.`
          : `Wait timed out after ${String(value.elapsedMs ?? 0)} ms (${String(value.reason ?? 'timeout')}).`,
      ),
      async execute(args, exec) {
        const timeoutMs = Math.min(120_000, Math.max(200, args.timeoutMs ?? 15_000));
        const intervalMs = Math.min(2_000, Math.max(100, args.intervalMs ?? 250));
        return await controller.runTask(
          async (task) => {
            const started = Date.now();
            const deadline = started + timeoutMs;
            if (args.for === 'window') {
              const result = await windowTool(
                { action: 'wait', title: typeof args.value === 'string' ? args.value : undefined, process: args.process, timeoutMs },
                { signal: task.signal },
              );
              return { matched: true, source: 'window', elapsedMs: Date.now() - started, window: result.window };
            }
            if (args.for === 'url') {
              const browser = getBrowser();
              if (browser === null) throw new Error('computer-control browser-not-attached: no browser session for for=url');
              const needle = String(args.value ?? '');
              if (needle.length === 0) throw new Error('computer-control invalid-args: for=url needs value');
              while (Date.now() < deadline) {
                const url = typeof browser.url === 'function' ? await browser.url() : '';
                if (String(url ?? '').includes(needle)) {
                  return { matched: true, source: 'url', url, elapsedMs: Date.now() - started };
                }
                await sleep(intervalMs, task.signal);
              }
              return { matched: false, source: 'url', reason: 'timeout', elapsedMs: Date.now() - started };
            }
            if (args.for === 'stable') {
              let previous = null;
              while (Date.now() < deadline) {
                const shot = await captureScreen(task, screenshotDir, 'stable');
                if (previous !== null && previous === shot.hash) {
                  return { matched: true, source: 'screen', elapsedMs: Date.now() - started, hash: shot.hash };
                }
                previous = shot.hash;
                await sleep(intervalMs, task.signal);
              }
              return { matched: false, source: 'screen', reason: 'timeout', elapsedMs: Date.now() - started };
            }
            if (args.for === 'text') {
              const value = String(args.value ?? '').trim();
              if (value.length === 0) throw new Error('computer-control invalid-args: for=text needs value');
              while (Date.now() < deadline) {
                const located = await locateText(
                  { query: value, scope: args.scope ?? 'auto', match: args.match ?? 'contains', maxResults: 5 },
                  locatorDeps(task, { windowTitle: args.windowTitle }),
                );
                if (located.matches.length > 0) {
                  return {
                    matched: true,
                    source: located.source,
                    coordinateSpace: located.coordinateSpace,
                    elapsedMs: Date.now() - started,
                    matches: located.matches.slice(0, 5),
                  };
                }
                await sleep(intervalMs, task.signal);
              }
              return { matched: false, source: 'text', reason: 'timeout', elapsedMs: Date.now() - started };
            }
            throw new Error(`computer-control invalid-args: unknown wait kind ${JSON.stringify(String(args.for))}`);
          },
          { agent: exec?.agent, signal: exec?.signal, timeoutMs: timeoutMs + 15_000 },
        );
      },
    },
    {
      name: 'computer_find_text',
      description:
        'Find visible text on screen with semantic sources: page (browser DOM), window (UI Automation), screen (Windows OCR). Returns matches with x/y/w/h and source. coordinateSpace=page means CSS pixels inside the page; coordinateSpace=screen means absolute physical screen pixels. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Text to find.' },
          match: { type: 'string', enum: ['contains', 'exact'], description: 'Default contains.' },
          scope: { type: 'string', enum: ['auto', 'page', 'window', 'screen'], description: 'Default auto (page if attached, then UIA, then OCR).' },
          prefer: { type: 'string', enum: ['button', 'link', 'input', 'any'], description: 'For Canvas/OCR: prefer compact button-like words over explanatory paragraphs.' },
          windowTitle: { type: 'string', description: 'For window scope: restrict to a title regex.' },
          maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => {
        const matches = Array.isArray(value.matches) ? value.matches : [];
        const preview = matches
          .slice(0, 8)
          .map((m) => {
            const kind = m.kind ?? m.tag ?? m.controlType ?? '';
            const selector = m.selectorHint ? ` ${String(m.selectorHint)}` : '';
            return `"${String(m.text)}"@(${Math.round(m.x)},${Math.round(m.y)})${kind ? ` [${String(kind)}]` : ''}${selector}`;
          })
          .join('; ');
        return `Found ${String(matches.length)} match(es) via ${String(value.source)} (${String(value.coordinateSpace)}): ${preview || 'none'}.`;
      }),
      async execute(args, exec) {
        return await controller.runTask(
          async (task) =>
            await locateText(
              {
                query: args.query,
                match: args.match ?? 'contains',
                scope: args.scope ?? 'auto',
                prefer: args.prefer,
                windowTitle: args.windowTitle,
                maxResults: args.maxResults ?? 20,
              },
              locatorDeps(task, { windowTitle: args.windowTitle }),
            ),
          { agent: exec?.agent, signal: exec?.signal, timeoutMs: 60_000 },
        );
      },
    },
    {
      name: 'computer_click_text',
      description:
        'Find visible text and click it: page hits click through the browser DOM; window/screen hits click at the matched center with the real mouse. Returns the match and a verification (changed + before/after URL/title or screenshot hash change). Use this instead of estimating coordinates for labeled buttons/links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          match: { type: 'string', enum: ['contains', 'exact'], description: 'Default contains.' },
          scope: { type: 'string', enum: ['auto', 'page', 'window', 'screen'], description: 'Default auto.' },
          windowTitle: { type: 'string' },
          prefer: { type: 'string', enum: ['button', 'link', 'input', 'any'], description: 'Prefer buttons/links/inputs when multiple matches exist (default button; use any for plain text).' },
          index: { type: 'integer', minimum: 0, maximum: 49, description: 'Which match to click after ranking (default 0).' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
          verify: { type: 'boolean', description: 'Verify after clicking (default true).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput((_args, value) => {
        if (value.clicked !== true) return `No clickable match for "${String(value.query)}" (${String(value.source ?? 'none')}).`;
        const target = value.target ?? {};
        return `Clicked "${String(target.text ?? value.query)}" via ${String(value.source)} at (${Math.round(target.x ?? 0)},${Math.round(target.y ?? 0)}). changed=${String(value.verification?.changed ?? 'unknown')}.`;
      }),
      async execute(args, exec) {
        const index = Math.max(0, Math.min(49, args.index ?? 0));
        return await controller.runTask(
          async (task) => {
            const browser = getBrowser();
            const located = await locateText(
              {
                query: args.query,
                match: args.match ?? 'contains',
                scope: args.scope ?? 'auto',
                prefer: args.prefer ?? 'button',
                windowTitle: args.windowTitle,
                maxResults: Math.max(index + 1, 5),
              },
              locatorDeps(task, { windowTitle: args.windowTitle }),
            );
            if (located.matches.length === 0) {
              return { clicked: false, query: args.query, source: located.source, matches: [] };
            }
            const match = located.matches[Math.min(index, located.matches.length - 1)];
            if (located.source === 'page' && browser !== null) {
              const before = await currentPageState(browser);
              const clicked = await clickBestMatch(browser, {
                text: args.query,
                match: args.match === 'exact' ? 'exact' : 'contains',
                prefer: args.prefer === 'any' ? undefined : args.prefer,
                index,
              });
              const after = await currentPageState(browser);
              const verification = {
                changed: Boolean(before === null || after === null || before.url !== after.url || before.title !== after.title || before.hash !== after.hash),
                before,
                after,
              };
              return { clicked: true, source: 'page', target: clicked.match, candidates: clicked.candidates, verification };
            }
            const before = args.verify === false ? null : await captureScreen(task, screenshotDir, 'click-before');
            const x = Number(match.x) + Number(match.w ?? 0) / 2;
            const y = Number(match.y) + Number(match.h ?? 0) / 2;
            await task.request(
              'click',
              { x: Math.round(x), y: Math.round(y), button: args.button === 'right' ? 'right' : args.button === 'middle' ? 'middle' : 'left', count: 1, intervalMs: 120 },
              { timeoutMs: 20_000 },
            );
            let verification;
            if (args.verify !== false) {
              await sleep(500, task.signal);
              const after = await captureScreen(task, screenshotDir, 'click-after');
              verification = { changed: before.hash !== after.hash, before: { hash: before.hash }, after: { hash: after.hash } };
            }
            return {
              clicked: true,
              source: located.source,
              coordinateSpace: located.coordinateSpace,
              target: { text: match.text, x, y, w: match.w, h: match.h },
              verification,
            };
          },
          { agent: exec?.agent, signal: exec?.signal, timeoutMs: 90_000 },
        );
      },
    },
  ];
}
