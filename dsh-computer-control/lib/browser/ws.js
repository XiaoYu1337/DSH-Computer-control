/**
 * Minimal RFC 6455 WebSocket client used by the CDP transport.
 *
 * - Uses `globalThis.WebSocket` when the runtime provides one (browser / Node >= 22).
 * - Otherwise (and as a fallback when the native client cannot connect) implements a
 *   small client over `node:net`: HTTP Upgrade handshake with a random
 *   `Sec-WebSocket-Key`, `Sec-WebSocket-Accept` validation, masked client frames,
 *   text/binary fragmentation, ping/pong and close handling.
 *
 * No `permessage-deflate` extension is negotiated. Only `ws://` URLs are supported by
 * the `node:net` transport (`wss://` needs a TLS socket; CDP loops back over `ws://`).
 *
 * Public API:
 *   class WsClient {
 *     static connect(url, {timeoutMs=5000, forceNet=false}) -> Promise<WsClient>
 *     send(text)
 *     onMessage(cb)   // cb(text)                         -> unsubscribe
 *     onClose(cb)     // cb({code, reason, wasClean})     -> unsubscribe
 *     close()         // Promise<void>, idempotent
 *   }
 */

import net from 'node:net';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const CLOSE_GRACE_MS = 500;

function wsError(message, extra) {
  const error = new Error(message);
  error.name = 'WsError';
  error.code = 'cdp_error';
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function encodeClosePayload(code, reason) {
  const text = Buffer.from(String(reason || ''), 'utf8');
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code & 0xffff, 0);
  text.copy(payload, 2);
  return payload;
}

function decodeClosePayload(payload) {
  if (!payload || payload.length < 2) return { code: 1005, reason: '' };
  const code = payload.readUInt16BE(0);
  const reason = payload.subarray(2).toString('utf8');
  return { code, reason };
}

export class WsClient {
  #mode;
  #socket = null;
  #ws = null;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = 0;
  #messageHandlers = new Set();
  #closeHandlers = new Set();
  #closeInfo = null;
  #closeEmitted = false;
  #closed = false;
  #closing = false;
  #closeTimer = null;

  constructor(mode) {
    this.#mode = mode;
  }

  get transport() {
    return this.#mode;
  }

  get isOpen() {
    return !this.#closed && !this.#closing;
  }

  /**
   * Connect to a `ws://` URL. Native `WebSocket` is preferred when available; a failed
   * native attempt transparently falls back to the `node:net` implementation.
   * @param {string} url
   * @param {{timeoutMs?: number, forceNet?: boolean}} [options]
   * @returns {Promise<WsClient>}
   */
  static async connect(url, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
    let nativeError = null;

    if (options.forceNet !== true && typeof globalThis.WebSocket === 'function') {
      const nativeClient = new WsClient('native');
      try {
        await nativeClient.#openNative(url, timeoutMs);
        return nativeClient;
      } catch (error) {
        nativeError = error;
        try {
          nativeClient.#ws?.close();
        } catch {
          /* ignore */
        }
      }
    }

    const client = new WsClient('net');
    try {
      await client.#openNet(url, timeoutMs);
      return client;
    } catch (error) {
      if (nativeError) {
        error.message += ` (native WebSocket also failed: ${nativeError.message})`;
        error.nativeError = nativeError;
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ native */

  async #openNative(url, timeoutMs) {
    const Ctor = globalThis.WebSocket;
    let ws;
    try {
      ws = new Ctor(url);
    } catch (error) {
      throw wsError(`Invalid WebSocket URL: ${error.message}`, { url, phase: 'constructor', cause: error });
    }
    this.#ws = ws;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onEarlyClose);
        fn(value);
      };
      const onOpen = () => finish(resolve);
      const onError = (event) =>
        finish(reject, wsError('WebSocket connection error', { url, phase: 'handshake', cause: event?.error ?? event }));
      const onEarlyClose = (event) =>
        finish(
          reject,
          wsError(`WebSocket closed during handshake (code ${event?.code ?? 'unknown'})`, {
            url,
            phase: 'handshake',
            closeCode: event?.code,
          }),
        );
      const timer = setTimeout(
        () => finish(reject, wsError(`WebSocket handshake timed out after ${timeoutMs}ms`, { url, phase: 'handshake' })),
        timeoutMs,
      );
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onEarlyClose);
    });

    ws.addEventListener('message', (event) => {
      const data = event?.data;
      if (typeof data === 'string') {
        this.#emitMessage(data);
      } else if (data instanceof ArrayBuffer) {
        this.#emitMessage(Buffer.from(data).toString('utf8'));
      } else if (ArrayBuffer.isView(data)) {
        this.#emitMessage(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.arrayBuffer().then(
          (buf) => this.#emitMessage(Buffer.from(buf).toString('utf8')),
          () => {},
        );
      } else if (data !== undefined && data !== null) {
        this.#emitMessage(String(data));
      }
    });
    ws.addEventListener('close', (event) => {
      this.#emitClose({
        code: Number.isInteger(event?.code) ? event.code : 1006,
        reason: typeof event?.reason === 'string' ? event.reason : '',
        wasClean: Boolean(event?.wasClean),
      });
    });
    ws.addEventListener('error', () => {
      /* a close event follows; nothing else to do */
    });
  }

  /* --------------------------------------------------------------- node:net */

  async #openNet(url, timeoutMs) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (error) {
      throw wsError(`Invalid WebSocket URL: ${error.message}`, { url, phase: 'constructor', cause: error });
    }
    if (parsed.protocol !== 'ws:') {
      throw wsError(
        `Unsupported WebSocket scheme "${parsed.protocol}": the node:net transport only supports ws:// (wss:// needs a TLS socket)`,
        { url, phase: 'constructor', scheme: parsed.protocol },
      );
    }

    const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 80;
    const requestPath = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');

    const socket = net.connect({ host, port });
    this.#socket = socket;
    socket.setNoDelay(true);

    let handshakeBuffer = Buffer.alloc(0);

    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('data', onHandshakeData);
        socket.removeListener('error', onHandshakeError);
        socket.removeListener('close', onHandshakeClose);
        if (timer) clearTimeout(timer);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onConnect = () => {
        const lines = [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ];
        socket.write(lines.join('\r\n'));
      };
      const onHandshakeError = (error) =>
        fail(wsError(`TCP connection failed: ${error?.message ?? String(error)}`, { url, phase: 'handshake', cause: error }));
      const onHandshakeClose = () =>
        fail(wsError('Socket closed before the WebSocket handshake completed', { url, phase: 'handshake' }));
      const onHandshakeData = (chunk) => {
        handshakeBuffer = handshakeBuffer.length === 0 ? chunk : Buffer.concat([handshakeBuffer, chunk]);
        if (handshakeBuffer.length > MAX_HANDSHAKE_BYTES) {
          fail(wsError('WebSocket handshake response headers are too large', { url, phase: 'handshake' }));
          return;
        }
        const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const head = handshakeBuffer.subarray(0, headerEnd).toString('latin1');
        const rest = handshakeBuffer.subarray(headerEnd + 4);
        handshakeBuffer = Buffer.alloc(0);

        const lines = head.split('\r\n');
        const statusLine = lines.shift() ?? '';
        const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
        if (!statusMatch || Number(statusMatch[1]) !== 101) {
          fail(wsError(`WebSocket upgrade rejected: ${statusLine || '(empty status)'}`, { url, phase: 'handshake', statusLine }));
          return;
        }
        const headers = Object.create(null);
        for (const line of lines) {
          const colon = line.indexOf(':');
          if (colon <= 0) continue;
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        if (String(headers.upgrade ?? '').toLowerCase() !== 'websocket') {
          fail(wsError('WebSocket upgrade response is missing "Upgrade: websocket"', { url, phase: 'handshake' }));
          return;
        }
        if (headers['sec-websocket-accept'] !== expectedAccept) {
          fail(wsError('WebSocket handshake failed: invalid Sec-WebSocket-Accept', { url, phase: 'handshake' }));
          return;
        }

        succeed();

        socket.on('data', (data) => this.#receive(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        socket.on('error', () => {
          /* a close event follows */
        });
        socket.on('close', () => {
          this.#socket = null;
          if (this.#closing) {
            this.#emitClose({ code: 1000, reason: 'client close', wasClean: true });
          } else {
            this.#emitClose({ code: 1006, reason: 'socket closed', wasClean: false });
          }
        });
        if (rest.length > 0) this.#receive(rest);
      };

      timer = setTimeout(
        () => fail(wsError(`WebSocket handshake timed out after ${timeoutMs}ms`, { url, phase: 'handshake' })),
        timeoutMs,
      );
      socket.once('connect', onConnect);
      socket.on('data', onHandshakeData);
      socket.once('error', onHandshakeError);
      socket.once('close', onHandshakeClose);
    });
  }

  #receive(chunk) {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const buf = this.#buffer;
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) !== 0;
      const rsv = buf[0] & 0x70;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let payloadLength = buf[1] & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.#protocolError('RSV bits are not supported (no extensions were negotiated)');
        return;
      }
      if (payloadLength === 126) {
        if (buf.length < 4) return;
        payloadLength = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          this.#protocolError(`Frame payload of ${big} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
          return;
        }
        payloadLength = Number(big);
        offset = 10;
      }

      const maskLength = masked ? 4 : 0;
      const frameEnd = offset + maskLength + payloadLength;
      if (buf.length < frameEnd) return;

      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      let payload = buf.subarray(offset + maskLength, frameEnd);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      this.#buffer = buf.subarray(frameEnd);

      this.#handleFrame(fin, opcode, payload);
      if (this.#closed) return;
    }
  }

  #handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODES.PING:
        this.#writeFrame(OPCODES.PONG, payload);
        return;
      case OPCODES.PONG:
        return;
      case OPCODES.CLOSE: {
        const info = decodeClosePayload(payload);
        if (!this.#closing) {
          this.#closing = true;
          try {
            this.#writeFrame(OPCODES.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : encodeClosePayload(1000, ''));
          } catch {
            /* ignore */
          }
        }
        try {
          this.#socket?.end();
        } catch {
          /* ignore */
        }
        this.#emitClose({ code: info.code, reason: info.reason, wasClean: true });
        return;
      }
      case OPCODES.TEXT:
      case OPCODES.BINARY: {
        if (this.#fragmentOpcode !== 0) {
          this.#protocolError('Received a new data frame while a fragmented message was in progress');
          return;
        }
        if (fin) {
          this.#deliver(opcode, payload);
        } else {
          this.#fragmentOpcode = opcode;
          this.#fragments = [payload];
        }
        return;
      }
      case OPCODES.CONTINUATION: {
        if (this.#fragmentOpcode === 0) {
          this.#protocolError('Received a continuation frame with no message in progress');
          return;
        }
        this.#fragments.push(payload);
        const total = this.#fragments.reduce((sum, part) => sum + part.length, 0);
        if (total > MAX_FRAME_BYTES) {
          this.#protocolError(`Fragmented message exceeds the ${MAX_FRAME_BYTES} byte limit`);
          return;
        }
        if (fin) {
          const data = Buffer.concat(this.#fragments);
          const op = this.#fragmentOpcode;
          this.#fragmentOpcode = 0;
          this.#fragments = [];
          this.#deliver(op, data);
        }
        return;
      }
      default:
        this.#protocolError(`Unsupported opcode 0x${opcode.toString(16)}`);
    }
  }

  #deliver(opcode, payload) {
    // CDP only ever uses text frames. Binary frames are ignored by this text-only API.
    if (opcode === OPCODES.TEXT) this.#emitMessage(payload.toString('utf8'));
  }

  #protocolError(message) {
    const error = wsError(`WebSocket protocol error: ${message}`, { phase: 'frames' });
    try {
      this.#writeFrame(OPCODES.CLOSE, encodeClosePayload(1002, 'protocol error'));
    } catch {
      /* ignore */
    }
    try {
      this.#socket?.destroy();
    } catch {
      /* ignore */
    }
    this.#emitClose({ code: 1002, reason: error.message, wasClean: false });
  }

  #writeFrame(opcode, payload) {
    if (this.#mode === 'native') {
      throw wsError('Internal error: frame writer used on a native WebSocket', { phase: 'frames' });
    }
    const socket = this.#socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw wsError('WebSocket socket is not writable', { phase: 'frames' });
    }
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
    const length = data.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (length < 126) {
      header = Buffer.allocUnsafe(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | length;
      mask.copy(header, 2);
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.allocUnsafe(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
      mask.copy(header, 10);
    }
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i & 3];
    socket.write(Buffer.concat([header, masked]));
  }

  /* ------------------------------------------------------------------ public */

  /**
   * Send a text frame (or a native WebSocket text message).
   * @param {string} text
   */
  send(text) {
    if (this.#closed || this.#closing) {
      throw wsError('WebSocket is not open', { phase: 'send' });
    }
    const value = String(text);
    if (this.#mode === 'native') {
      if (!this.#ws || this.#ws.readyState !== 1) {
        throw wsError('WebSocket is not open', { phase: 'send', readyState: this.#ws?.readyState });
      }
      this.#ws.send(value);
      return;
    }
    this.#writeFrame(OPCODES.TEXT, Buffer.from(value, 'utf8'));
  }

  /**
   * Register a text-message callback.
   * @param {(text: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onMessage(callback) {
    if (typeof callback !== 'function') throw wsError('onMessage requires a function');
    this.#messageHandlers.add(callback);
    return () => this.#messageHandlers.delete(callback);
  }

  /**
   * Register a close callback.
   * @param {(info: {code: number, reason: string, wasClean: boolean}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onClose(callback) {
    if (typeof callback !== 'function') throw wsError('onClose requires a function');
    if (this.#closeEmitted) {
      queueMicrotask(() => {
        try {
          callback(this.#closeInfo ?? { code: 1005, reason: '', wasClean: true });
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
   * Gracefully close the connection; resolves once closed (bounded by a short grace timer).
   * @returns {Promise<void>}
   */
  close() {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) {
      return new Promise((resolve) => {
        if (this.#closed) {
          resolve();
          return;
        }
        const off = this.onClose(() => {
          off();
          resolve();
        });
      });
    }
    this.#closing = true;

    const done = new Promise((resolve) => {
      const off = this.onClose(() => {
        off();
        resolve();
      });
    });

    if (this.#mode === 'native') {
      try {
        this.#ws?.close(1000, 'client close');
      } catch {
        /* ignore */
      }
      this.#closeTimer = setTimeout(() => {
        this.#emitClose({ code: 1000, reason: 'client close', wasClean: true, forced: true });
      }, CLOSE_GRACE_MS);
      return done;
    }

    try {
      this.#writeFrame(OPCODES.CLOSE, encodeClosePayload(1000, 'client close'));
    } catch {
      /* socket may already be unwritable */
    }
    try {
      this.#socket?.end();
    } catch {
      /* ignore */
    }
    this.#closeTimer = setTimeout(() => {
      try {
        this.#socket?.destroy();
      } catch {
        /* ignore */
      }
      this.#emitClose({ code: 1000, reason: 'client close', wasClean: true, forced: true });
    }, CLOSE_GRACE_MS);
    return done;
  }

  #emitMessage(text) {
    for (const callback of Array.from(this.#messageHandlers)) {
      try {
        callback(text);
      } catch {
        /* user callback errors must not tear the socket down */
      }
    }
  }

  #emitClose(info) {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#closed = true;
    this.#closing = true;
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    this.#closeInfo = info;
    for (const callback of Array.from(this.#closeHandlers)) {
      try {
        callback(info);
      } catch {
        /* ignore */
      }
    }
    this.#closeHandlers.clear();
    this.#messageHandlers.clear();
  }
}

export default WsClient;
