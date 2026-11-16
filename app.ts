// The forge's HTTP surface: a health probe, git smart HTTP, REST v3, GraphQL v4 and
// the MCP endpoint, served from one process over one in-memory store.
//
// app.ts is the server; main.ts is the entry <-> env lifecycle and stays as it is.
//
// Performance: the request URL is parsed once here and handed to every handler,
// so no handler re-parses it (the old code parsed it up to four times a request).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRawServer, type FastReq, type FastRes, type RawServer } from './src/rawhttp.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body. */
function sendJson(res: FastRes, status: number, body: unknown): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length });
  res.end(buf);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): RawServer {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const ctx = { store, token };

  // The dispatch promise is RETURNED (not voided): the raw server awaits it
  // before dispatching the next request on the same connection, so responses
  // can never overtake each other on one socket.
  return createRawServer((req: FastReq, res: FastRes) => {
    return (async () => {
      try {
        // One parse: a malformed URL throws here and the outer catch answers 500,
        // exactly as the old per-handler parses did.
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The facades implement exactly the Node surface the handlers use;
        // the casts keep the handler signatures untouched.
        const nreq = req as unknown as IncomingMessage;
        const nres = res as unknown as ServerResponse;
        if (await handleGit(ctx, nreq, nres, url)) return;
        if (await handleRest(ctx, nreq, nres, url)) return;
        if (await handleGraphQL(ctx, nreq, nres, url)) return;
        if (await handleMcp(ctx, nreq, nres, url)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: (err as Error).message });
        else res.destroy();
      }
    })();
  });
}
