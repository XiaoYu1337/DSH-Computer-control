/**
 * 轻量操作 trace：环形缓冲 + 可选持久化审计日志。
 * 只存摘要（不存页面全文/输入值）；审计日志按大小轮转，默认保留 3 份。
 */
import { appendFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ActionTrace {
  #entries = [];
  #limit;
  #seq = 0;
  #run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  #auditPath;
  #maxAuditBytes;
  #auditBackups;
  #auditChain = Promise.resolve();
  #auditError = null;

  constructor({ limit = 120, auditPath = null, maxAuditBytes = 1_048_576, auditBackups = 3 } = {}) {
    this.#limit = Math.max(10, Math.min(500, limit));
    this.#auditPath = typeof auditPath === 'string' && auditPath.length > 0 ? auditPath : null;
    this.#maxAuditBytes = Math.max(4_096, Number(maxAuditBytes) || 1_048_576);
    this.#auditBackups = Math.max(1, Math.min(9, Number(auditBackups) || 3));
  }

  record(entry) {
    this.#seq += 1;
    const record = { run: this.#run, seq: this.#seq, at: new Date().toISOString(), ...entry };
    this.#entries.push(record);
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit);
    this.#enqueueAudit(record);
  }

  read({ limit = 50 } = {}) {
    const count = Math.max(1, Math.min(this.#limit, limit));
    return this.#entries.slice(-count);
  }

  clear() {
    this.#entries = [];
    return { cleared: true };
  }

  /** 等待所有排队中的审计写入完成。 */
  async flush() {
    await this.#auditChain;
  }

  /** 审计日志健康状况（不写业务记录）。 */
  async health() {
    if (this.#auditPath === null) {
      return { enabled: false, path: null, bytes: 0, backups: 0, error: null };
    }
    try {
      await mkdir(dirname(this.#auditPath), { recursive: true });
      let bytes = 0;
      try {
        const info = await stat(this.#auditPath);
        bytes = info.size;
      } catch {
        bytes = 0;
      }
      return {
        enabled: true,
        path: this.#auditPath,
        bytes,
        backups: this.#auditBackups,
        maxBytes: this.#maxAuditBytes,
        error: this.#auditError,
      };
    } catch (error) {
      return {
        enabled: true,
        path: this.#auditPath,
        bytes: 0,
        backups: this.#auditBackups,
        maxBytes: this.#maxAuditBytes,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async exportTo(path) {
    await this.flush();
    await mkdir(dirname(path), { recursive: true });
    const lines = this.#entries.map((entry) => JSON.stringify(entry));
    await writeFile(path, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');
    return { path, count: this.#entries.length, auditPath: this.#auditPath };
  }

  get size() {
    return this.#entries.length;
  }

  #enqueueAudit(record) {
    if (this.#auditPath === null) return;
    const line = `${JSON.stringify(record)}\n`;
    this.#auditChain = this.#auditChain
      .then(() => this.#appendAudit(line))
      .catch((error) => {
        this.#auditError = error instanceof Error ? error.message : String(error);
      });
  }

  async #appendAudit(line) {
    if (this.#auditPath === null) return;
    await mkdir(dirname(this.#auditPath), { recursive: true });
    await appendFile(this.#auditPath, line, 'utf8');
    const info = await stat(this.#auditPath);
    if (info.size > this.#maxAuditBytes) await this.#rotateAudit();
  }

  async #rotateAudit() {
    if (this.#auditPath === null) return;
    for (let index = this.#auditBackups; index >= 1; index -= 1) {
      const target = `${this.#auditPath}.${index}`;
      const previous = index === 1 ? this.#auditPath : `${this.#auditPath}.${index - 1}`;
      try {
        if (index === this.#auditBackups) await unlink(target).catch(() => {});
        await rename(previous, target);
      } catch {
        // 目标不存在或正被占用：保留当前日志，下一轮再试。
      }
    }
    // 轮转后立即创建一个空 current，保证路径始终可读。
    try {
      await writeFile(this.#auditPath, '', 'utf8');
    } catch {
      // 下一轮 append 仍会尝试创建。
    }
  }
}

/** 参数脱敏：去掉 undefined、截断长文本、隐藏填充值。 */
export function redactArgs(args) {
  if (args === null || typeof args !== 'object') return args;
  const sensitive = args.sensitive === true;
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (sensitive && (key === 'text' || key === 'keys' || key === 'value')) {
      const length = typeof value === 'string' ? value.length : 0;
      output[key] = `<redacted:${length}>`;
      continue;
    }
    if (key === 'value' && typeof value === 'string') {
      output.value = `<redacted:${value.length}>`;
      continue;
    }
    if (key === 'from_screenshot' && value !== null && typeof value === 'object') {
      output.from_screenshot = { path: String(value.path ?? ''), x: value.x, y: value.y };
      continue;
    }
    if (typeof value === 'string') {
      output[key] = value.length > 140 ? `${value.slice(0, 140)}…` : value;
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.slice(0, 8).map((item) => (typeof item === 'string' && item.length > 80 ? `${item.slice(0, 80)}…` : item));
      continue;
    }
    output[key] = value;
  }
  return output;
}

/** 结果摘要：只保留可读的关键字段，避免 trace 变成第二份大 JSON。 */
export function summarizeResult(value) {
  if (value === null || typeof value !== 'object') return value;
  const keys = [
    'action',
    'ok',
    'mode',
    'url',
    'title',
    'changed',
    'matched',
    'source',
    'clicked',
    'filled',
    'pressed',
    'closed',
    'owned',
    'kind',
    'target',
    'text',
    'path',
    'elapsedMs',
    'count',
    'summary',
  ];
  const summary = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (key === 'text' && typeof value.text === 'string') {
      summary.text = `${value.text.slice(0, 80)}${value.text.length > 80 ? '…' : ''}`;
      continue;
    }
    summary[key] = value[key];
  }
  if (Array.isArray(value.matches)) summary.matches = value.matches.length;
  if (Array.isArray(value.windows)) summary.windows = value.windows.length;
  if (Array.isArray(value.checks)) {
    summary.checks = value.checks.length;
    summary.failed = value.checks.filter((check) => check.status === 'fail').length;
  }
  return summary;
}
