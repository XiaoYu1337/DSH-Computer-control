/**
 * Chrome DevTools Protocol transport for the DSH browser core.
 *
 * Responsibilities:
 *  - HTTP discovery on a loopback DevTools port (`/json/version`, `/json/list`).
 *  - A small CDP client over `WsClient` with command id correlation, event
 *    subscription and flat (`Target.attachToTarget {flatten:true}`) session support.
 *
 * Errors thrown by this module always carry a `.code` from the set used by the
 * browser tools: browser_not_launched, attach_failed, target_not_found,
 * navigation_timeout, text_not_found, ambiguous_text, cdp_error.
 */

import { WsClient } from './ws.js';

export const ERROR_CODES = Object.freeze({
  BROWSER_NOT_LAUNCHED: 'browser_not_launched',
  ATTACH_FAILED: 'attach_failed',
  TARGET_NOT_FOUND: 'target_not_found',
  NAVIGATION_TIMEOUT: 'navigation_timeout',
  TEXT_NOT_FOUND: 'text_not_found',
  AMBIGUOUS_TEXT: 'ambiguous_text',
  CDP_ERROR: 'cdp_error',
});

const VALID_ERROR_CODES = new Set(Object.values(ERROR_CODES));

export class CdpError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'CdpError';
    this.code = VALID_ERROR_CODES.has(code) ? code : ERROR_CODES.CDP_ERROR;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

/**
 * Create an Error with a browser-core `.code`.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {CdpError}
 */
export function cdpError(code, message, extra) {
  return new CdpError(code, message, extra);
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw cdpError(ERROR_CODES.CDP_ERROR, `Invalid DevTools port: ${String(port)}`, { port });
  }
}

async function httpJson(port, requestPath, { timeoutMs = 4000 } = {}) {
  assertPort(port);
  const url = `http://127.0.0.1:${port}${requestPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    const causeCode = error?.cause?.code ?? error?.code ?? '';
    if (causeCode === 'ECONNREFUSED' || causeCode === 'ECONNRESET' || error?.name === 'AbortError') {
      throw cdpError(ERROR_CODES.BROWSER_NOT_LAUNCHED, `No CDP endpoint is listening on 127.0.0.1:${port} (${causeCode || error?.name})`, {
        port,
        cause: error,
      });
    }
    throw cdpError(ERROR_CODES.CDP_ERROR, `GET ${url} failed: ${error?.message ?? String(error)}`, {
      port,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw cdpError(ERROR_CODES.CDP_ERROR, `GET ${url} returned HTTP ${response.status}`, {
      port,
      status: response.status,
    });
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw cdpError(ERROR_CODES.CDP_ERROR, `GET ${url} did not return valid JSON: ${error.message}`, {
      port,
      bodyPreview: text.slice(0, 200),
    });
  }
}

/**
 * GET /json/version for a DevTools port.
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{Browser: string, webSocketDebuggerUrl: string, [key: string]: unknown}>}
 */
export async function getVersion(port, options = {}) {
  const version = await httpJson(port, '/json/version', options);
  if (!version || typeof version !== 'object') {
    throw cdpError(ERROR_CODES.CDP_ERROR, 'GET /json/version returned an unexpected payload', { port });
  }
  if (typeof version.webSocketDebuggerUrl !== 'string' || version.webSocketDebuggerUrl.length === 0) {
    throw cdpError(ERROR_CODES.BROWSER_NOT_LAUNCHED, 'DevTools endpoint did not expose a browser webSocketDebuggerUrl', {
      port,
      version,
    });
  }
  return version;
}

/**
 * GET /json/list for a DevTools port.
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<Array<{id: string, type: string, title: string, url: string, webSocketDebuggerUrl?: string}>>}
 */
export async function listTargets(port, options = {}) {
  const payload = await httpJson(port, '/json/list', options);
  if (!Array.isArray(payload)) {
    throw cdpError(ERROR_CODES.CDP_ERROR, 'GET /json/list did not return an array', { port });
  }
  return payload.map((target) => {
    const raw = target && typeof target === 'object' ? target : {};
    return {
      ...raw,
      id: String(raw.id ?? ''),
      type: String(raw.type ?? ''),
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      webSocketDebuggerUrl: typeof raw.webSocketDebuggerUrl === 'string' ? raw.webSocketDebuggerUrl : undefined,
    };
  });
}

/**
 * Find a page target, optionally by id.
 * @param {number} port
 * @param {{targetId?: string, timeoutMs?: number}} [options]
 */
export async function findPageTarget(port, options = {}) {
  const targets = await listTargets(port, options);
  if (options.targetId) {
    const target = targets.find((entry) => entry.id === options.targetId);
    if (!target) {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `No CDP target with id ${options.targetId}`, {
        port,
        targetId: options.targetId,
        available: targets.map((entry) => ({ id: entry.id, type: entry.type, url: entry.url })),
      });
    }
    if (target.type !== 'page') {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, `Target ${options.targetId} is type "${target.type}", not a page`, {
        port,
        targetId: options.targetId,
        targetType: target.type,
      });
    }
    return target;
  }
  const page = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!page) {
    throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, 'No CDP page target is available on this DevTools port', {
      port,
      available: targets.map((entry) => ({ id: entry.id, type: entry.type, url: entry.url })),
    });
  }
  return page;
}

/**
 * CDP client for one WebSocket endpoint (browser-level or page-level).
 *
 * `send(method, params, sessionId?, {timeoutMs})` attaches `sessionId` at the top level of
 * the protocol envelope so flat target sessions work (`Target.attachToTarget {flatten:true}`).
 * Event subscriptions receive `(params, meta)` where `meta.sessionId` is the emitting
 * session (or `null` for browser-level events).
 */
export class CdpClient {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();
  #closeHandlers = new Set();
  #closed = false;
  #closeEmitted = false;
  #defaultTimeoutMs;
  #transport;

  constructor(ws, options = {}) {
    if (!ws || typeof ws.send !== 'function') throw cdpError(ERROR_CODES.CDP_ERROR, 'CdpClient requires a connected WsClient');
    this.#ws = ws;
    this.#defaultTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
    this.#transport = ws.transport ?? 'unknown';
    ws.onMessage((text) => this.#onMessage(text));
    ws.onClose((info) => this.#handleTransportClose(info));
  }

  /**
   * @param {string} webSocketDebuggerUrl
   * @param {{timeoutMs?: number, transport?: 'auto'|'net'}} [options]
   * @returns {Promise<CdpClient>}
   */
  static async connect(webSocketDebuggerUrl, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10_000;
    let ws;
    try {
      ws = await WsClient.connect(webSocketDebuggerUrl, {
        timeoutMs,
        forceNet: options.transport === 'net',
      });
    } catch (error) {
      throw cdpError(ERROR_CODES.ATTACH_FAILED, `Failed to connect to CDP WebSocket: ${error.message}`, {
        cause: error,
        webSocketDebuggerUrl,
      });
    }
    return new CdpClient(ws, { timeoutMs: Math.max(options.requestTimeoutMs ?? 30_000, 1000) });
  }

  get closed() {
    return this.#closed;
  }

  get transport() {
    return this.#transport;
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<any>} protocol `result`
   */
  send(method, params = {}, sessionId, options = {}) {
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(cdpError(ERROR_CODES.CDP_ERROR, 'CDP method name is required'));
    }
    if (this.#closed) {
      return Promise.reject(cdpError(ERROR_CODES.CDP_ERROR, `CDP client is closed (cannot send ${method})`, { method }));
    }
    const id = (this.#nextId += 1);
    const message = { id, method, params: params ?? {} };
    if (sessionId) message.sessionId = sessionId;

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : this.#defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          cdpError(ERROR_CODES.CDP_ERROR, `CDP command timed out after ${timeoutMs}ms: ${method}`, {
            method,
            sessionId: sessionId ?? null,
          }),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method, sessionId: sessionId ?? null });
      try {
        this.#ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          cdpError(ERROR_CODES.CDP_ERROR, `Failed to send CDP command ${method}: ${error.message}`, {
            cause: error,
            method,
          }),
        );
      }
    });
  }

  /**
   * Subscribe to a CDP event. Use `'*'` to observe every event.
   * @param {string} event
   * @param {(params: any, meta: {sessionId: string|null, method: string}) => void} callback
   * @returns {() => void} unsubscribe
   */
  on(event, callback) {
    if (typeof event !== 'string' || event.length === 0) throw cdpError(ERROR_CODES.CDP_ERROR, 'Event name is required');
    if (typeof callback !== 'function') throw cdpError(ERROR_CODES.CDP_ERROR, 'Event callback must be a function');
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(callback);
    return () => {
      const current = this.#listeners.get(event);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) this.#listeners.delete(event);
    };
  }

  /** Remove one event callback previously registered with `on`. */
  off(event, callback) {
    const set = this.#listeners.get(event);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) this.#listeners.delete(event);
  }

  /**
   * Subscribe to an event emitted by one flat session.
   * @param {string} event
   * @param {string|null} sessionId
   * @param {(params: any, meta: object) => void} callback
   */
  onSession(event, sessionId, callback) {
    return this.on(event, (params, meta) => {
      if ((meta?.sessionId ?? null) === (sessionId ?? null)) callback(params, meta);
    });
  }

  /** Subscribe to transport closure. */
  onClose(callback) {
    if (typeof callback !== 'function') throw cdpError(ERROR_CODES.CDP_ERROR, 'onClose callback must be a function');
    if (this.#closeEmitted) {
      queueMicrotask(() => {
        try {
          callback({ code: 1000, reason: 'client closed' });
        } catch {
          /* ignore */
        }
      });
      return () => {};
    }
    this.#closeHandlers.add(callback);
    return () => this.#closeHandlers.delete(callback);
  }

  /**
   * Attach to a target using a flat session.
   * @param {string} targetId
   * @param {{flatten?: boolean, timeoutMs?: number}} [options]
   * @returns {Promise<string>} sessionId
   */
  async attachToTarget(targetId, options = {}) {
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw cdpError(ERROR_CODES.TARGET_NOT_FOUND, 'attachToTarget requires a target id');
    }
    const result = await this.send(
      'Target.attachToTarget',
      { targetId, flatten: options.flatten !== false },
      undefined,
      { timeoutMs: options.timeoutMs ?? 10_000 },
    );
    if (!result || typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
      throw cdpError(ERROR_CODES.ATTACH_FAILED, `Target.attachToTarget returned no sessionId for ${targetId}`, { targetId });
    }
    return result.sessionId;
  }

  /** Detach a flat session (best-effort; never throws). */
  async detachSession(sessionId) {
    if (!sessionId || this.#closed) return;
    try {
      await this.send('Target.detachFromTarget', { sessionId }, undefined, { timeoutMs: 3000 });
    } catch {
      /* best-effort */
    }
  }

  /** Close the client and reject any in-flight commands. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(
        cdpError(ERROR_CODES.CDP_ERROR, `CDP client closed while waiting for ${pending.method}`, { method: pending.method }),
      );
      this.#pending.delete(id);
    }
    try {
      await this.#ws.close();
    } catch {
      /* ignore */
    }
    this.#notifyClose({ code: 1000, reason: 'client closed', wasClean: true });
  }

  #onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;

    if (message.id !== undefined && message.id !== null) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.message ?? JSON.stringify(message.error);
        pending.reject(
          cdpError(ERROR_CODES.CDP_ERROR, `${pending.method} failed: ${detail}`, {
            cdpError: message.error,
            method: pending.method,
            sessionId: pending.sessionId,
          }),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === 'string') {
      const params = message.params ?? {};
      const meta = {
        method: message.method,
        sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
      };
      this.#dispatch(message.method, params, meta);
      this.#dispatch('*', params, meta);
    }
  }

  #dispatch(event, params, meta) {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    for (const callback of Array.from(set)) {
      try {
        callback(params, meta);
      } catch {
        /* subscriber errors must not break command correlation */
      }
    }
  }

  #handleTransportClose(info) {
    if (this.#closed) {
      this.#notifyClose(info ?? { code: 1000, reason: 'closed' });
      return;
    }
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(
        cdpError(ERROR_CODES.CDP_ERROR, `CDP connection closed while waiting for ${pending.method}`, {
          method: pending.method,
          closeCode: info?.code,
        }),
      );
      this.#pending.delete(id);
    }
    this.#notifyClose(info ?? { code: 1006, reason: 'connection closed' });
  }

  #notifyClose(info) {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    for (const callback of Array.from(this.#closeHandlers)) {
      try {
        callback(info);
      } catch {
        /* ignore */
      }
    }
    this.#closeHandlers.clear();
  }
}

export default CdpClient;
