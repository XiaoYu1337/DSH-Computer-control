/**
 * computer_browser 工具：封装 lib/browser/page.js 的 BrowserSession。
 * 采用惰性 import：浏览器内核尚未安装时不会影响插件其它工具加载。
 */
import { clickBestMatch, rankMatches } from './matching.js';

function objectOutput(schema, render) {
  return { schema, render: (_args, value) => [{ type: 'text', text: render(value) }] };
}

function browserError(code, message) {
  const error = new Error(`computer-control ${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * @param {{controller: object, screenshotDir?: string}} deps
 */
export function createBrowserTool(deps) {
  const { controller } = deps;
  let session = null;
  let owned = false;
  let modulePromise = null;

  async function loadSessionClass() {
    if (modulePromise === null) {
      modulePromise = import('./browser/page.js').then((module) => {
        const Session = module.BrowserSession ?? module.default;
        if (typeof Session !== 'function') throw browserError('browser_module_missing', 'BrowserSession export not found');
        return Session;
      });
      modulePromise.catch(() => {
        modulePromise = null;
      });
    }
    return await modulePromise;
  }

  async function requireSession() {
    if (session === null) throw browserError('browser_not_attached', 'call computer_browser launch or attach first');
    return session;
  }

  async function pageState() {
    if (session === null) return null;
    try {
      const [url, title, hash] = await Promise.all([
        typeof session.url === 'function' ? session.url() : undefined,
        typeof session.title === 'function' ? session.title() : undefined,
        typeof session.screenshotHash === 'function' ? session.screenshotHash() : undefined,
      ]);
      return { url, title, hash };
    } catch {
      return null;
    }
  }

  async function closeSession() {
    if (session === null) return { closed: false, owned: false };
    const wasOwned = owned;
    const target = session;
    session = null;
    owned = false;
    try {
      if (typeof target.close === 'function') await target.close();
    } catch {
      // 关闭失败不掩盖主流程
    }
    return { closed: true, owned: wasOwned };
  }

  const tool = {
    name: 'computer_browser',
    description:
      'Semantic browser control through Microsoft Edge (CDP). Prefer this over screenshot coordinates for web tasks. launch opens a DEDICATED Edge instance with a temporary profile (does not touch the user\'s normal Edge); attach connects to an existing loopback debugging port. Actions: launch, attach, status, navigate, read, click (by text or selector), fill, press, wait (text/url/selector), close. Every change returns URL/title and a changed flag; errors are typed (text_not_found, ambiguous_text, timeout, ...).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['launch', 'attach', 'status', 'navigate', 'read', 'find', 'fields', 'frames', 'click', 'fill', 'press', 'wait', 'close'],
        },
        url: { type: 'string', description: 'Launch/navigate URL (http/https).' },
        port: { type: 'integer', minimum: 1024, maximum: 65535, description: 'Attach: loopback DevTools port.' },
        targetId: { type: 'string', description: 'Attach: optional page target id.' },
        text: { type: 'string', description: 'Visible text to click/find/fill.' },
        selector: { type: 'string', description: 'CSS selector (more precise than text when known).' },
        value: { type: 'string', description: 'Fill value, or wait value (text/url substring/selector).' },
        key: { type: 'string', description: 'Key to press (e.g. Enter, ctrl+l).' },
        match: { type: 'string', enum: ['contains', 'exact'], description: 'Text match mode (default contains).' },
        prefer: { type: 'string', enum: ['button', 'link', 'input', 'any'], description: 'For click/find: prefer buttons, links, or inputs (default any).' },
        includeLinks: { type: 'boolean', description: 'Read: include visible links (text + href).' },
        fieldIndex: { type: 'integer', minimum: 0, maximum: 99, description: 'Fill: use fields[fieldIndex] from action=fields (recommended for unlabeled login inputs).' },
        frameIndex: { type: 'integer', minimum: 0, maximum: 19, description: 'Read/click: target iframe by index from action=frames (0-based).' },
        frameId: { type: 'string', description: 'Read/click: target iframe by CDP frame id.' },
        index: { type: 'integer', minimum: 0, maximum: 50, description: 'Match index after ranking (default 0).' },
        submit: { type: 'boolean', description: 'Fill: press Enter after filling.' },
        waitFor: { type: 'string', enum: ['text', 'url', 'selector'], description: 'Wait kind.' },
        timeoutMs: { type: 'integer', minimum: 200, maximum: 60000, description: 'Action timeout (default 15000).' },
        maxChars: { type: 'integer', minimum: 100, maximum: 20000, description: 'Read: max text chars (default 12000).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: objectOutput(
      {
        type: 'object',
        additionalProperties: true,
      },
      (value) => {
        if (value.action === 'close') return `Browser closed (owned=${String(value.owned)}).`;
        if (value.action === 'status') {
          return value.attached
            ? `Browser attached: ${String(value.url ?? '')} "${String(value.title ?? '')}" (owned=${String(value.owned)}).`
            : 'Browser: not attached.';
        }
        if (value.action === 'read') {
          const text = typeof value.text === 'string' ? value.text : '';
          const frameLabel = value.frame ? `[frame #${String(value.frame.frameIndex)} ${String(value.frame.frameId)}] ` : '';
          const lines = [`${frameLabel}${String(value.url ?? '')} · "${String(value.title ?? '')}" · textChars=${String(text.length)}`, text.slice(0, 4000)];
          if (Array.isArray(value.links) && value.links.length > 0) {
            lines.push(
              ...value.links.slice(0, 25).map((link) => `- ${String(link.text ?? '')} -> ${String(link.href ?? link.url ?? '')}`),
            );
          }
          return lines.join('\n');
        }
        if (value.action === 'frames') {
          const frames = Array.isArray(value.frames) ? value.frames : [];
          if (frames.length === 0) return 'No child frames.';
          return frames
            .map((frame) => `#${String(frame.frameIndex)} ${String(frame.frameId)} "${String(frame.name ?? '')}" ${String(frame.url ?? '')}`)
            .join('\n');
        }
        if (value.action === 'fields') {
          const fields = Array.isArray(value.fields) ? value.fields : [];
          const frames = Array.isArray(value.frames) ? value.frames : [];
          const lines = [];
          if (fields.length === 0) lines.push('No visible editable fields in the main frame.');
          lines.push(
            ...fields.map(
              (field) =>
                `#${String(field.index)} ${String(field.tag)}${field.type ? `[type=${String(field.type)}]` : ''} name="${String(field.name ?? '')}" id="${String(field.id ?? '')}" placeholder="${String(field.placeholder ?? '')}" valueLength=${String(field.valueLength ?? 0)} sel=${String(field.selectorHint ?? '')} @(${Math.round(field.x ?? 0)},${Math.round(field.y ?? 0)})`,
            ),
          );
          if (Array.isArray(value.frameTargets) && value.frameTargets.length > 0) {
            lines.push(
              ...value.frameTargets.map(
                (frame) =>
                  `IFRAME ${String(frame.url)} fields=${String(frame.fields)}${frame.error ? ` error=${String(frame.error)}` : ''}`,
              ),
            );
          }
          if (frames.length > 0) {
            lines.push(
              ...frames.map(
                (frame) =>
                  `FRAME src="${String(frame.src ?? '')}" id="${String(frame.id ?? '')}" sameOrigin=${String(frame.sameOrigin)} @(${Math.round(frame.x ?? 0)},${Math.round(frame.y ?? 0)})`,
              ),
            );
          }
          return lines.join('\n');
        }
        if (value.action === 'fill' && value.field !== null && value.field !== undefined) {
          return `Filled field #${String(value.field.index)} ${String(value.field.tag)}${value.field.type ? `[type=${String(value.field.type)}]` : ''} name="${String(value.field.name ?? '')}" (valueLength=${String(value.valueLength)}).`;
        }
        if (value.action === 'find') {
          const matches = Array.isArray(value.matches) ? value.matches : [];
          return `Found ${String(matches.length)}/${String(value.total ?? matches.length)} match(es).\n${matches
            .slice(0, 15)
            .map((m) => `#${String(m.rank)} "${String(m.text)}"@(${Math.round(m.x ?? 0)},${Math.round(m.y ?? 0)}) ${String(m.kind ?? m.tag ?? '')} ${String(m.selectorHint ?? '')}`)
            .join('\n')}`;
        }
        const bits = [];
        if (value.action !== undefined) bits.push(String(value.action));
        if (value.url !== undefined) bits.push(String(value.url));
        if (value.title !== undefined) bits.push(`"${String(value.title)}"`);
        if (value.changed !== undefined) bits.push(`changed=${String(value.changed)}`);
        if (value.matched !== undefined) bits.push(`matched=${String(value.matched)}`);
        if (value.text !== undefined && typeof value.text === 'string') bits.push(`textChars=${String(value.text.length)}`);
        return bits.join(' · ') || JSON.stringify(value);
      },
    ),
    async execute(args, exec) {
      const timeoutMs = Math.min(60_000, Math.max(200, args.timeoutMs ?? 15_000));
      return await controller.runTask(
        async () => {
          switch (args.action) {
            case 'launch': {
              if (session !== null) throw browserError('browser_already_open', 'close the current session first');
              if (typeof args.url !== 'string' || !/^https?:\/\//iu.test(args.url)) {
                throw browserError('invalid-args', 'launch needs an http(s) url');
              }
              const Session = await loadSessionClass();
              session = await Session.launch({ url: args.url });
              owned = true;
              return {
                action: 'launch',
                owned: true,
                port: session.port ?? null,
                url: await session.url(),
                title: await session.title(),
              };
            }
            case 'attach': {
              if (session !== null) throw browserError('browser_already_open', 'close the current session first');
              if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) {
                throw browserError('invalid-args', 'attach needs a loopback port');
              }
              const Session = await loadSessionClass();
              session = await Session.attach({ port: args.port, targetId: args.targetId });
              owned = false;
              return { action: 'attach', owned: false, url: await session.url(), title: await session.title() };
            }
            case 'status': {
              return {
                action: 'status',
                attached: session !== null,
                owned,
                ...(session === null ? {} : await pageState()),
              };
            }
            case 'navigate': {
              const active = await requireSession();
              if (typeof args.url !== 'string' || !/^https?:\/\//iu.test(args.url)) {
                throw browserError('invalid-args', 'navigate needs an http(s) url');
              }
              const started = Date.now();
              await active.navigate(args.url, { waitUntil: 'load', timeoutMs });
              return {
                action: 'navigate',
                url: await active.url(),
                title: await active.title(),
                elapsedMs: Date.now() - started,
              };
            }
            case 'read': {
              const active = await requireSession();
              const result = await active.read({
                maxChars: args.maxChars ?? 12_000,
                includeLinks: args.includeLinks === true,
                frameIndex: Number.isInteger(args.frameIndex) ? args.frameIndex : undefined,
                frameId: typeof args.frameId === 'string' ? args.frameId : undefined,
              });
              return { action: 'read', ...result };
            }
            case 'frames': {
              const active = await requireSession();
              const frames = await active.frames();
              return { action: 'frames', url: await active.url(), frames };
            }
            case 'fields': {
              const active = await requireSession();
              const result = await active.fields();
              return { action: 'fields', ...result };
            }
            case 'find': {
              const active = await requireSession();
              if (typeof args.text !== 'string' && typeof args.selector !== 'string') {
                throw browserError('invalid-args', 'find needs text or selector');
              }
              const found = await active.find({
                text: args.text,
                selector: args.selector,
                match: args.match === 'exact' ? 'exact' : 'contains',
                max: Math.max(1, Math.min(60, (args.index ?? 0) + 20)),
              });
              const ranked = rankMatches(found.matches, {
                query: args.text ?? '',
                match: args.match === 'exact' ? 'exact' : 'contains',
                prefer: args.prefer === 'any' ? undefined : args.prefer,
              });
              return {
                action: 'find',
                url: found.url,
                title: found.title,
                matches: ranked.slice(0, 20).map((entry) => ({ ...entry.match, rank: entry.index, score: entry.score, kind: entry.kind })),
                total: ranked.length,
              };
            }
            case 'click': {
              const active = await requireSession();
              const before = await pageState();
              const started = Date.now();
              const frameOptions = {
                frameIndex: Number.isInteger(args.frameIndex) ? args.frameIndex : undefined,
                frameId: typeof args.frameId === 'string' ? args.frameId : undefined,
              };
              const clicked = frameOptions.frameIndex !== undefined || frameOptions.frameId !== undefined
                ? await active.click({
                    text: args.text,
                    selector: args.selector,
                    match: args.match === 'exact' ? 'exact' : 'contains',
                    index: args.index ?? 0,
                    ...frameOptions,
                  }).then((result) => ({ match: result.match, candidates: 1, rank: 0, frame: result.frame, domClick: result.button === 'dom' }))
                : await clickBestMatch(active, {
                    text: args.text,
                    selector: args.selector,
                    match: args.match === 'exact' ? 'exact' : 'contains',
                    prefer: args.prefer === 'any' ? undefined : args.prefer,
                    index: args.index ?? 0,
                  });
              const after = await pageState();
              const changed = Boolean(
                before === null || after === null || before.url !== after.url || before.title !== after.title || before.hash !== after.hash,
              );
              return {
                action: 'click',
                clicked: true,
                target: clicked.match,
                candidates: clicked.candidates,
                rank: clicked.rank,
                frame: clicked.frame ?? null,
                before,
                after,
                changed,
                elapsedMs: Date.now() - started,
              };
            }
            case 'fill': {
              const active = await requireSession();
              if (typeof args.value !== 'string') throw browserError('invalid-args', 'fill needs value');
              let selector = args.selector;
              let field = null;
              let submitted = false;
              if (Number.isInteger(args.fieldIndex)) {
                const filled = await active.fillField({
                  fieldIndex: args.fieldIndex,
                  value: args.value,
                  submit: args.submit === true,
                });
                field = filled.field;
                submitted = filled.submitted === true;
                selector = field?.selectorHint ?? selector;
              }
              if (typeof args.text !== 'string' && typeof selector !== 'string') {
                throw browserError('invalid-args', 'fill needs text, selector, or fieldIndex');
              }
              const before = await pageState();
              if (!Number.isInteger(args.fieldIndex)) {
                await active.fill({
                  text: args.text,
                  selector,
                  value: args.value,
                  submit: args.submit === true,
                });
                submitted = args.submit === true;
              }
              const after = await pageState();
              return {
                action: 'fill',
                filled: true,
                field,
                submitted,
                valueLength: args.value.length,
                before,
                after,
                changed: Boolean(before === null || after === null || before.hash !== after.hash || before.url !== after.url),
              };
            }
            case 'press': {
              const active = await requireSession();
              if (typeof args.key !== 'string' || args.key.length === 0) throw browserError('invalid-args', 'press needs key');
              await active.press(args.key);
              return { action: 'press', key: args.key, url: await active.url(), title: await active.title() };
            }
            case 'wait': {
              const active = await requireSession();
              const kind = args.waitFor ?? 'text';
              const value = kind === 'text' || kind === 'url' || kind === 'selector' ? args.value : undefined;
              if (typeof value !== 'string' || value.length === 0) throw browserError('invalid-args', 'wait needs value');
              const started = Date.now();
              const result = await active.waitFor({ for: kind, value, timeoutMs });
              return { action: 'wait', matched: true, waitFor: kind, ...result, elapsedMs: Date.now() - started };
            }
            case 'close': {
              return { action: 'close', ...(await closeSession()) };
            }
            default:
              throw browserError('invalid-args', `unknown action ${JSON.stringify(String(args.action))}`);
          }
        },
        { agent: exec?.agent, signal: exec?.signal, timeoutMs: timeoutMs + 20_000 },
      );
    },
  };

  return {
    tool,
    getBrowser: () => session,
    dispose: async () => {
      await closeSession();
    },
  };
}
