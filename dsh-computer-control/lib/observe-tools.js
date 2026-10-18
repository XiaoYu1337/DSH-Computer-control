/**
 * P1 观测工具：computer_self_test / computer_trace。
 */
import { isAbsolute, join } from 'node:path';
import { runSelfTest } from './self-test.js';

function textOutput(render) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: String(render(args, value)) }],
  };
}

function formatCheck(check) {
  const mark = check.status === 'pass' ? 'PASS' : check.status === 'skip' ? 'SKIP' : 'FAIL';
  const detail = check.detail === undefined ? '' : ` — ${typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}`;
  return `${mark} ${check.label}${detail}`;
}

/**
 * @param {{controller: object, trace: object, screenshotDir: string, traceDir?: string}} deps
 */
export function createObserveTools(deps) {
  const { controller, trace, screenshotDir, traceDir } = deps;

  return [
    {
      name: 'computer_self_test',
      description:
        'Run a quick end-to-end self-test of the computer-control stack: overlay mode, worker screenshot, screenshot metadata, monitor enumeration, window helper, UIA helper, Windows OCR, persistent audit log, and the Edge CDP browser module. browser=launch also opens/closes a dedicated Edge to verify CDP. This does NOT take over the screen (no overlay/banner).',
      parameters: {
        type: 'object',
        properties: {
          browser: { type: 'string', enum: ['skip', 'launch'], description: 'skip = import browser module only; launch = open/close dedicated Edge (default skip).' },
        },
        additionalProperties: false,
      },
      output: textOutput((_args, value) => {
        const checks = Array.isArray(value.checks) ? value.checks : [];
        return [`self-test ${value.ok === true ? 'PASS' : 'FAIL'} (${JSON.stringify(value.summary)})`, ...checks.map(formatCheck)].join('\n');
      }),
      async execute(args, exec) {
        return await runSelfTest(
          { controller, screenshotDir, trace },
          { browser: args.browser === 'launch' ? 'launch' : 'skip', signal: exec?.signal },
        );
      },
    },
    {
      name: 'computer_trace',
      description:
        'Inspect the recent computer-control action trace (tool, args summary, timing, result/error, failure screenshot), clear it, or export it as JSONL. Trace entries never include fill values or full page text. A redacted persistent audit log is also written under the DSH storage trace directory.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'clear', 'export'], description: 'Default read.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Read: number of recent entries (default 30).' },
          path: { type: 'string', description: 'Export: absolute JSONL destination (default under the screenshot dir).' },
        },
        additionalProperties: false,
      },
      output: textOutput((args, value) => {
        if (value.action === 'export') return `Trace exported to ${String(value.path)} (${String(value.count)} entries).`;
        if (value.action === 'clear') return 'Trace cleared.';        const entries = Array.isArray(value.entries) ? value.entries : [];
        const auditLine = value.audit?.path
          ? `Audit log: ${String(value.audit.path)} (${String(value.audit.bytes ?? 0)} bytes)\n`
          : '';
        if (entries.length === 0) return `${auditLine}Trace is empty.`;
        return `${auditLine}${entries
          .map((entry) => {
            const status = entry.ok === false ? `FAIL ${String(entry.error?.code ?? 'error')}` : 'ok';
            const target = entry.result?.url ?? entry.result?.path ?? entry.result?.matches ?? '';
            return `#${String(entry.seq)} ${entry.at} ${String(entry.tool)} ${status} ${String(entry.elapsedMs ?? 0)}ms ${String(target)}${entry.screenshot ? ` shot=${entry.screenshot}` : ''}`;
          })
          .join('\n')}`;
      }),
      async execute(args) {
        const action = args.action ?? 'read';
        if (action === 'clear') {
          const result = trace.clear();
          return { action: 'clear', ...result };
        }
        if (action === 'export') {
          const path = typeof args.path === 'string' && args.path.length > 0
            ? args.path
            : join(traceDir ?? screenshotDir, 'trace.jsonl');
          if (!isAbsolute(path)) throw new Error('computer-control invalid-args: trace export path must be absolute');
          const result = await trace.exportTo(path);
          return { action: 'export', ...result };
        }
        const entries = trace.read({ limit: args.limit ?? 30 });
        const audit = await trace.health();
        return { action: 'read', entries, audit };
      },
    },
  ];
}
