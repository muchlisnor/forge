// The forge's HTTP transport, hand-rolled over node:net.
//
// Why: Node's http server costs ~0.31 ms of server CPU per request before any
// handler runs, and the read workload is already at that floor. A raw TCP
// server that parses HTTP/1.1 itself drops that floor to the parse cost
// (tens of microseconds). The handlers only use a small surface of the Node
// API, so the facades below implement exactly that surface:
//
//   req: method, url, headers, on('data' | 'end' | 'error'), destroy()
//   res: writeHead(status, headers), end(data?), headersSent, destroy()
//
// Correctness rules (learned the hard way — see forge-speed-chase notes):
// - Request bodies are ALWAYS consumed in full, keep-alive included. The
//   previous req.read() fast path skipped the stream's 'end' and stalled the
//   next request on the same socket. Here the parser reads the whole body
//   (Content-Length or chunked) before dispatch, and the facade replays it
//   to readBody via data/end events.
// - `Expect: 100-continue` is answered as soon as the headers parse.
// - Responses are serialized per connection: request N+1 is dispatched only
//   after request N's handler has returned (i.e. its res.end() was called),
//   so response bytes can never overtake each other on one socket.
// - One response per request: status line + headers + body, written with a
//   single corked write pair. Content-Length is always sent.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';

/** The request surface the handlers use (a subset of IncomingMessage). */
export interface FastReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  on(event: 'data', fn: (chunk: Buffer) => void): void;
  on(event: 'end', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
  destroy(): void;
}

/** The response surface the handlers use (a subset of ServerResponse). */
export interface FastRes {
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): void;
  end(data?: Buffer | string): void;
  destroy(): void;
}

export type RawHandler = (req: FastReq, res: FastRes) => unknown;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const EMPTY = Buffer.alloc(0);

interface ParsedRequest {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
  keepAlive: boolean;
  consumed: number;
}

/** Parse one complete request out of `buf`, or null when more bytes are needed. Throws on malformed input. */
function tryParse(buf: Buffer): ParsedRequest | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    if (buf.length > 65536) throw new Error('headers too large');
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const firstSpace = lines[0].indexOf(' ');
  const secondSpace = lines[0].indexOf(' ', firstSpace + 1);
  if (firstSpace === -1 || secondSpace === -1) throw new Error('bad request line');
  const method = lines[0].slice(0, firstSpace);
  const target = lines[0].slice(firstSpace + 1, secondSpace);
  const versionRaw = lines[0].slice(secondSpace + 1);
  if (!method || !target || !versionRaw.startsWith('HTTP/')) throw new Error('bad request line');
  const version = versionRaw.slice(5);

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
  }

  const conn = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = version === '1.1' ? conn !== 'close' : conn === 'keep-alive';

  let off = headEnd + 4;
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (te.includes('chunked')) {
    // De-chunk: hex size lines, data, CRLF, until a 0-size chunk, then trailers.
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', off);
      if (lineEnd === -1) return null;
      const size = parseInt(buf.subarray(off, lineEnd).toString('latin1').split(';')[0].trim(), 16);
      if (Number.isNaN(size) || size < 0) throw new Error('bad chunk size');
      off = lineEnd + 2;
      if (size === 0) {
        // Trailers: lines until an empty line.
        for (;;) {
          const tEnd = buf.indexOf('\r\n', off);
          if (tEnd === -1) return null;
          if (tEnd === off) {
            off = tEnd + 2;
            break;
          }
          off = tEnd + 2;
        }
        return { method, target, version, headers, body: Buffer.concat(parts, total), keepAlive, consumed: off };
      }
      if (buf.length < off + size + 2) return null;
      parts.push(buf.subarray(off, off + size));
      total += size;
      off += size + 2;
    }
  }

  const lenRaw = headers['content-length'];
  const len = lenRaw === undefined ? 0 : parseInt(lenRaw, 10);
  if (Number.isNaN(len) || len < 0) throw new Error('bad content-length');
  if (buf.length < off + len) return null;
  // A view into buf: buf is never mutated in place, so the view stays valid.
  const body = len === 0 ? EMPTY : buf.subarray(off, off + len);
  return { method, target, version, headers, body, keepAlive, consumed: off + len };
}

/** One TCP connection: parse requests, dispatch them one at a time, write responses. */
class Connection {
  private readonly socket: Socket;
  private readonly handler: RawHandler;
  private buf: Buffer = EMPTY;
  private busy = false;
  private dead = false;
  private halfClosed = false;

  constructor(socket: Socket, handler: RawHandler) {
    this.socket = socket;
    this.handler = handler;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => {
      this.dead = true;
    });
    socket.on('end', () => {
      this.halfClosed = true;
      if (!this.busy) this.destroy();
    });
  }

  private destroy(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.socket.destroy();
    } catch {
      // Already gone.
    }
  }

  private sendRaw(status: number, reason: string, body: string): void {
    try {
      const bytes = Buffer.from(body, 'utf8');
      this.socket.write(
        `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${bytes.length}\r\nconnection: close\r\n\r\n`,
        'latin1',
      );
      if (bytes.length > 0) this.socket.write(bytes);
    } catch {
      // Socket already gone.
    }
    this.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.dead) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.dead) return;
    let parsed: ParsedRequest | null;
    try {
      parsed = tryParse(this.buf);
    } catch {
      this.sendRaw(400, 'Bad Request', 'Bad Request\n');
      return;
    }
    if (parsed === null) return;

    // Answer 100-continue as soon as the headers parse, before the body.
    if ((parsed.headers['expect'] ?? '').toLowerCase().includes('100-continue')) {
      try {
        this.socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
      } catch {
        this.destroy();
        return;
      }
    }

    this.buf = this.buf.subarray(parsed.consumed);
    this.busy = true;
    const req = makeReq(this.socket, parsed);
    const res = makeRes(this.socket, parsed);
    try {
      await this.handler(req, res);
    } catch {
      // The dispatch in app.ts catches its own errors; this is a last resort.
      if (!res.headersSent) {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(Buffer.from('{"message":"Internal Server Error"}\n'));
        } catch {
          // Socket already gone.
        }
      } else {
        res.destroy();
      }
    } finally {
      this.busy = false;
      if (this.dead || this.halfClosed) {
        this.destroy();
        return;
      }
      if (this.socket.destroyed) {
        this.dead = true;
        return;
      }
      if (!parsed.keepAlive) {
        try {
          this.socket.end();
        } catch {
          // Already gone.
        }
        this.dead = true;
        return;
      }
      if (this.buf.length > 0) void this.pump();
    }
  }
}

/** The request facade: replays the pre-buffered body through data/end events. */
function makeReq(socket: Socket, parsed: ParsedRequest): FastReq {
  const dataFns: Array<(chunk: Buffer) => void> = [];
  const endFns: Array<() => void> = [];
  let scheduled = false;
  return {
    method: parsed.method,
    url: parsed.target,
    headers: parsed.headers,
    on(event: 'data' | 'end' | 'error', fn: (arg?: unknown) => void): void {
      if (event === 'data') dataFns.push(fn as (chunk: Buffer) => void);
      else if (event === 'end') endFns.push(fn as () => void);
      // 'error' listeners are accepted and never fire: the body is fully
      // buffered before dispatch, so there is no mid-body stream to fail.
      if (!scheduled) {
        scheduled = true;
        // Deferred so readBody's data/end/error listeners are all attached
        // (it registers them synchronously) before anything is emitted.
        setImmediate(() => {
          if (parsed.body.length > 0) {
            for (const f of dataFns) f(parsed.body);
          }
          for (const f of endFns) f();
        });
      }
    },
    destroy(): void {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    },
  };
}

/** The response facade: accumulates status/headers, writes one corked response on end(). */
function makeRes(socket: Socket, parsed: ParsedRequest): FastRes {
  let status = 200;
  let headers: Record<string, string | number> = {};
  let sent = false;
  const res: FastRes = {
    get headersSent() {
      return sent;
    },
    writeHead(s: number, h: Record<string, string | number>): void {
      status = s;
      headers = h;
    },
    end(data?: Buffer | string): void {
      if (sent) return;
      sent = true;
      const body = data === undefined ? EMPTY : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const reason = REASONS[status] ?? '';
      // The handlers already set content-length on every response; emitting
      // it a second time breaks strict clients (undici rejects the response
      // with a content-length mismatch, git reports a hangup). Only fill in
      // what the handler did not set.
      const lower = new Set(Object.keys(headers).map((n) => n.toLowerCase()));
      let head = `HTTP/1.1 ${status} ${reason}\r\n`;
      for (const name of Object.keys(headers)) head += `${name}: ${headers[name]}\r\n`;
      if (!lower.has('content-length')) head += `content-length: ${body.length}\r\n`;
      if (!lower.has('connection')) head += `connection: ${parsed.keepAlive ? 'keep-alive' : 'close'}\r\n`;
      head += '\r\n';
      try {
        socket.cork();
        socket.write(head, 'latin1');
        // HEAD answers carry the headers (and the length) but no body bytes.
        if (parsed.method !== 'HEAD' && body.length > 0) socket.write(body);
        socket.uncork();
      } catch {
        // Socket already gone.
      }
      if (!parsed.keepAlive) {
        try {
          socket.end();
        } catch {
          // Already gone.
        }
      }
    },
    destroy(): void {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    },
  };
  return res;
}

/**
 * A server with the small surface main.ts and the bench harness use:
 * listen(port[, host][, cb]), address(), close(), once('error', fn).
 * The entry listens on an ephemeral port; the bench listens on a fixed one.
 */
export class RawServer {
  private readonly netServer: NetServer;
  private readonly sockets = new Set<Socket>();

  constructor(handler: RawHandler) {
    this.netServer = createNetServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      new Connection(socket, handler);
    });
  }

  once(event: 'error', fn: (err: Error) => void): this {
    this.netServer.once(event, fn);
    return this;
  }

  listen(port: number, hostOrCb?: string | (() => void), cb?: () => void): this {
    if (typeof hostOrCb === 'function') {
      this.netServer.listen(port, hostOrCb);
    } else {
      this.netServer.listen(port, hostOrCb ?? '0.0.0.0', cb);
    }
    return this;
  }

  address(): { port: number } | null {
    const a = this.netServer.address();
    if (a === null || typeof a === 'string') return null;
    return { port: a.port };
  }

  close(cb?: () => void): void {
    for (const s of this.sockets) s.destroy();
    this.netServer.close(cb);
  }
}

export function createRawServer(handler: RawHandler): RawServer {
  return new RawServer(handler);
}
