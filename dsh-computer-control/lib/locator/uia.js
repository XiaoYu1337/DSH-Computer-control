/** UIA 文本定位（桌面控件；Edge 页面默认不暴露 UIA）。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShellScript } from '../ps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'uia-find-text.ps1');

export async function findUiaText(options = {}, runOptions = {}) {
  const query = String(options.query ?? '').trim();
  if (query.length === 0) throw new Error('computer-control invalid-args: query is required');
  const args = ['-Query', query, '-MaxResults', String(Math.max(1, Math.min(50, options.maxResults ?? 20)))];
  if (options.match === 'exact') args.push('-Match', 'exact');
  if (typeof options.windowTitle === 'string' && options.windowTitle.length > 0) {
    args.push('-WindowTitle', options.windowTitle);
  }
  const result = await runPowerShellScript(SCRIPT, args, {
    signal: runOptions.signal,
    timeoutMs: runOptions.timeoutMs ?? 10_000,
  });
  const matches = (Array.isArray(result.matches) ? result.matches : [])
    .map((item) => ({
      text: String(item.text ?? item.name ?? '').trim(),
      name: String(item.name ?? item.text ?? '').trim(),
      controlType: item.controlType,
      className: item.className,
      automationId: item.automationId,
      x: Number(item.x ?? 0),
      y: Number(item.y ?? 0),
      w: Number(item.w ?? 0),
      h: Number(item.h ?? 0),
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.text.length > 0 && Number.isFinite(item.x) && Number.isFinite(item.y) && item.w > 0 && item.h > 0);
  return { source: 'uia', matches };
}
