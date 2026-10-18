/** 三级文本定位：page(DOM) → uia(桌面) → ocr(屏幕)。 */
import { findUiaText } from './uia.js';
import { ocrImage, searchOcr } from './ocr.js';

function cap(value, max) {
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.round(value))) : max;
}

/**
 * @param {{query: string, scope?: 'auto'|'page'|'window'|'screen', match?: 'contains'|'exact', prefer?: 'button'|'link'|'input'|'any', windowTitle?: string, maxResults?: number}} options
 * @param {{browser?: object|null, screenshot?: (() => Promise<{path: string, result: object}>)|null, signal?: AbortSignal}} deps
 */
export async function locateText(options, deps = {}) {
  const query = String(options?.query ?? '').trim();
  if (query.length === 0) throw new Error('computer-control invalid-args: query is required');
  const scope = options?.scope ?? 'auto';
  const prefer = options?.prefer ?? 'any';
  if (!['auto', 'page', 'window', 'screen'].includes(scope)) {
    throw new Error(`computer-control invalid-args: unknown scope ${JSON.stringify(String(scope))}`);
  }
  const match = options?.match === 'exact' ? 'exact' : 'contains';
  const max = cap(options?.maxResults ?? 20, 50);
  const browser = deps.browser ?? null;
  let pageError = null;
  let uiaError = null;

  if ((scope === 'auto' || scope === 'page') && browser !== null) {
    try {
      const found = await browser.find({ text: query, match, max });
      if (Array.isArray(found.matches) && found.matches.length > 0) {
        return {
          source: 'page',
          coordinateSpace: 'page',
          url: found.url,
          title: found.title,
          matches: found.matches.slice(0, max),
        };
      }
      if (scope === 'page') {
        return { source: 'page', coordinateSpace: 'page', url: found.url, title: found.title, matches: [] };
      }
    } catch (error) {
      pageError = error;
      if (scope === 'page') throw error;
    }
  }
  if (scope === 'page' && browser === null) {
    throw new Error('computer-control browser-not-attached: page scope needs an attached browser session');
  }

  if (scope === 'auto' || scope === 'window') {
    try {
      const found = await findUiaText(
        { query, match, windowTitle: options?.windowTitle, maxResults: max },
        { signal: deps.signal, timeoutMs: deps.uiaTimeoutMs ?? 10_000 },
      );
      let bounds = null;
      if (typeof deps.getScreenBounds === 'function') {
        try {
          bounds = await deps.getScreenBounds();
        } catch {
          bounds = null;
        }
      }
      const visible = bounds === null
        ? found.matches
        : found.matches.filter(
            (item) =>
              item.x + item.w > bounds.x &&
              item.y + item.h > bounds.y &&
              item.x < bounds.x + bounds.width &&
              item.y < bounds.y + bounds.height,
          );
      // prefer=button/link/input 时过滤掉说明段落；否则 Canvas 场景会优先命中大段文本。
      const usable = prefer === 'any'
        ? visible
        : visible.filter((item) => {
            const control = String(item.controlType ?? '').toLocaleLowerCase();
            if (prefer === 'button' && (control === 'button' || control === 'hyperlink')) return true;
            if (prefer === 'link' && control === 'hyperlink') return true;
            if (prefer === 'input' && control === 'edit') return true;
            const text = String(item.text ?? '').replace(/\s+/gu, '');
            const needle = query.replace(/\s+/gu, '');
            return text === needle || (text.length > 0 && text.length <= needle.length + 6);
          });
      if (usable.length > 0) {
        return {
          source: 'uia',
          coordinateSpace: 'screen',
          matches: usable.slice(0, max),
          pageError: pageError instanceof Error ? pageError.message : undefined,
        };
      }
    } catch (error) {
      uiaError = error;
      if (scope === 'window') throw error;
    }
  }

  if (scope === 'screen' || scope === 'auto' || scope === 'window') {
    if (typeof deps.screenshot !== 'function') {
      throw new Error('computer-control invalid-args: screen/OCR scope needs screenshot capability');
    }
    const shot = await deps.screenshot();
    const result = shot.result ?? {};
    const scale = Number.isFinite(result.scale) && result.scale > 0
      ? result.scale
      : Number.isFinite(result.sourceWidth) && Number.isFinite(result.width) && result.width > 0
        ? result.sourceWidth / result.width
        : 1;
    const originX = Number.isFinite(result.x) ? result.x : 0;
    const originY = Number.isFinite(result.y) ? result.y : 0;
    const ocr = await ocrImage(shot.path, { signal: deps.signal, timeoutMs: deps.ocrTimeoutMs ?? 20_000 });
    const raw = searchOcr(ocr, query, match);
    const matches = raw.slice(0, max).map((entry) => ({
      ...entry,
      x: originX + entry.x / scale,
      y: originY + entry.y / scale,
      w: entry.w / scale,
      h: entry.h / scale,
    }));
    return {
      source: 'ocr',
      coordinateSpace: 'screen',
      matches,
      ocrLanguage: ocr.language,
      pageError: pageError instanceof Error ? pageError.message : undefined,
      uiaError: uiaError instanceof Error ? uiaError.message : undefined,
    };
  }

  throw new Error('computer-control invalid-args: unsupported locate scope');
}
