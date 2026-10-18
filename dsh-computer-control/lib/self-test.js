/**
 * computer_self_test：一次性检查浮层、worker、UIA/OCR、窗口助手、浏览器内核。
 * 使用 controller.diagnostics（不触发接管/浮层），适合在验收前或插件重载后运行。
 */
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findUiaText } from './locator/uia.js';
import { ocrImage } from './locator/ocr.js';
import { windowTool } from './win.js';

async function runCheck(checks, id, label, fn, { skip = false } = {}) {
  if (skip) {
    checks.push({ id, label, status: 'skip', detail: 'skipped' });
    return;
  }
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ id, label, status: 'pass', detail, elapsedMs: Date.now() - started });
  } catch (error) {
    checks.push({
      id,
      label,
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      code: error?.code,
      elapsedMs: Date.now() - started,
    });
  }
}

/**
 * @param {{controller: object, screenshotDir: string, getBrowser?: () => object|null}} deps
 * @param {{browser?: 'skip'|'launch'}} options
 */
export async function runSelfTest(deps, options = {}) {
  const { controller, screenshotDir, trace = null } = deps;
  const checks = [];
  let screenshotPath = null;

  await controller.diagnostics(async (ctx) => {
    const snapshot = ctx.snapshot();
    await runCheck(checks, 'overlay', 'takeover overlay mode', () => {
      const overlay = String(snapshot.overlay ?? 'unknown');
      if (overlay !== 'native' && overlay !== 'web') throw new Error(`unexpected overlay mode: ${overlay}`);
      return { mode: snapshot.mode, overlay };
    });

    await runCheck(checks, 'worker-screenshot', 'automation worker screenshot', async () => {
      await mkdir(screenshotDir, { recursive: true });
      const path = join(screenshotDir, `selftest-${Date.now()}.png`);
      const result = await ctx.request('screenshot', { path, scale: 0.25 }, { timeoutMs: 20_000 });
      const info = await stat(path);
      if (!info.isFile() || info.size < 1024) throw new Error('screenshot file missing or too small');
      screenshotPath = path;
      return { path, bytes: info.size, width: result.width, height: result.height };
    });

    await runCheck(checks, 'screenshot-metadata', 'screenshot scale/source metadata', async () => {
      const path = join(screenshotDir, `selftest-meta-${Date.now()}.png`);
      const result = await ctx.request('screenshot', { path }, { timeoutMs: 20_000 });
      if (!Number.isFinite(result.sourceWidth) || !Number.isFinite(result.sourceHeight) || !Number.isFinite(result.scale)) {
        throw new Error('screenshot result is missing sourceWidth/sourceHeight/scale');
      }
      return { sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight, scale: result.scale };
    });

    await runCheck(checks, 'screen-info', 'monitor enumeration', async () => {
      const info = await ctx.request('screenInfo', {}, { timeoutMs: 15_000 });
      if (!Array.isArray(info.monitors) || info.monitors.length === 0) throw new Error('no monitors reported');
      return { monitors: info.monitors.length };
    });

    await runCheck(checks, 'window-helper', 'window list helper', async () => {
      const listed = await windowTool({ action: 'list' }, { timeoutMs: 15_000 });
      if (!Array.isArray(listed.windows)) throw new Error('window helper returned no windows array');
      return { windows: listed.windows.length };
    });

    await runCheck(
      checks,
      'audit-log',
      'persistent audit log',
      async () => {
        if (trace === null) throw new Error('audit trace is unavailable');
        const health = await trace.health();
        if (!health.enabled) throw new Error('audit log is disabled');
        if (health.error) throw new Error(`audit log error: ${health.error}`);
        return { path: health.path, bytes: health.bytes, backups: health.backups };
      },
      { skip: trace === null },
    );

    await runCheck(checks, 'uia-helper', 'UIA text helper', async () => {
      const found = await findUiaText({ query: 'DSH', maxResults: 5 }, { timeoutMs: 15_000 });
      if (!Array.isArray(found.matches)) throw new Error('UIA helper returned no matches array');
      return { matches: found.matches.length };
    });

    await runCheck(
      checks,
      'ocr-helper',
      'Windows OCR helper',
      async () => {
        if (screenshotPath === null) throw new Error('screenshot from worker check is unavailable');
        const ocr = await ocrImage(screenshotPath, { timeoutMs: 25_000 });
        if (!Array.isArray(ocr.words)) throw new Error('OCR helper returned no words array');
        return { engine: ocr.engine, language: ocr.language, words: ocr.words.length, elapsedMs: ocr.elapsedMs };
      },
      { skip: screenshotPath === null },
    );

    await runCheck(
      checks,
      'browser-module',
      'browser module (Edge CDP)',
      async () => {
        const module = await import('./browser/page.js');
        const Session = module.BrowserSession ?? module.default;
        if (typeof Session !== 'function') throw new Error('BrowserSession export not found');
        if (options.browser !== 'launch') return { imported: true, launched: false };
        const session = await Session.launch({ url: 'about:blank' });
        try {
          const url = await session.url();
          return { imported: true, launched: true, url };
        } finally {
          await session.close();
        }
      },
      { skip: false },
    );
  });

  const failed = checks.filter((check) => check.status === 'fail').length;
  return {
    ok: failed === 0,
    summary: { total: checks.length, pass: checks.filter((c) => c.status === 'pass').length, fail: failed, skip: checks.filter((c) => c.status === 'skip').length },
    checks,
  };
}
