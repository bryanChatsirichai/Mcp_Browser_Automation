// Entry point: an MCP server over Streamable HTTP (JSON-RPC 2.0) on 127.0.0.1, bridged to the
// browser extension over a WebSocket on the same port. Importing this file starts the server (main()).
// Run with `npm run relay`, i.e. `node relay/relay.ts` (Node 22.18+ strips the types itself).
//
// Flow of one tool call, by file. Every log line about a call starts with `call <shortId> <tool>`,
// and the extension's service-worker console logs the same short id:
//
//   relay.ts           POST /mcp → route: local-only gate → handleMcp
//   mcp/server.ts      handleMcp → McpServer validates args (mcp/tools.ts) → runToolCall
//   browser/socket.ts  requireExtension (browser/launch.ts starts the browser if needed)
//   browser/calls.ts   sendCall → WebSocket {type:'call', id} → extension background.ts
//   browser/socket.ts  {type:'result', id} frame → browser/calls.ts settleFromResult
//   mcp/server.ts      runToolCall → fence (relay-lib.ts) → MCP response
//
// Folders: mcp/ is what the MCP client sees; browser/ is the link to the extension.

// main() starts
//   → log "starting"
//   → build the server, register the 3 server rules
//   → ask Windows to open the port (doesn't wait)
//   → register the Ctrl+C rule
// main() ends
//   → port opens  → log "listening" and "browser auto-start"
//   → relay waits

// later:
//   Claude Code request  → handleRequest
//   extension connects   → handleUpgrade
//   port busy            → handleServerError → exit(1)
//   Ctrl+C               → shutdown → exit(0)

// Claude Code ──── MCP over HTTP ────► relay ◄──── WebSocket ──── Chrome extension
//            POST /mcp                         ws://…/ext
//            handleRequest                     handleUpgrade
//            mcp/server.ts                     browser/socket.ts




import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { BROWSER_LAUNCH } from './browser/launch.ts';
import { acceptExtension } from './browser/socket.ts';
import { handleMcp, VERSION } from './mcp/server.ts';
import { isLocal } from './relay-lib.ts';
import { log } from './log.ts';

const HOST = '127.0.0.1'; // never 0.0.0.0: remote access goes through a token and a tunnel (step 12)
const PORT = Number(process.env.PORT ?? 8787);

/** Handles the WebSocket side of the shared port; it never listens on a port of its own. */
const sockets = new WebSocketServer({ noServer: true });

main();

/** Startup: the only code that runs when the relay starts. Every handler below runs later, on an event. */
function main(): void {
  log(`relay v${VERSION} starting on http://${HOST}:${PORT}/mcp (local-only mode)`);
  const httpServer = http.createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);
  httpServer.on('error', handleServerError);
  httpServer.listen(PORT, HOST, () => {
    log(`relay v${VERSION} listening on http://${HOST}:${PORT}/mcp (local-only mode)`);
    log(BROWSER_LAUNCH ? `browser auto-start: ${BROWSER_LAUNCH}` : 'browser auto-start: off');
  });
  // A SIGINT/SIGTERM listener replaces Node's default exit, so it must exit itself. Closing the
  // servers is not enough: close() waits for open connections to end, and the extension's
  // WebSocket never ends on its own. Nothing needs saving first: pending calls exist only in
  // memory, and the extension reconnects when the relay is back.
  const shutdown = () => {
    log('shutting down relay');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Runs for every HTTP request. Turns anything route() throws into a 500. */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  log(`handleRequest: ${req.method} ${pathOf(req)}`);
  route(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`handleRequest failed: ${req.method} ${pathOf(req)} - ${message}`);
    if (res.headersSent) {
      res.destroy();
    } else {
      json(res, 500, { error: message });
    }
  });
}

/**
 * Runs when a client asks to switch the connection to WebSocket (the extension, on /ext).
 * Only the extension gets here. Node sends a request with an `Upgrade`
 * header to this 'upgrade' event instead of to handleRequest, so it never reaches route().
 */
function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  log(`handleUpgrade: ${req.method} ${pathOf(req)}`);
  if (pathOf(req) !== '/ext' || !isLocal(req)) {
    log(`refused WebSocket upgrade: ${pathOf(req)}`);
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, acceptExtension);
}

/** Runs if the server cannot start or fails later, most often because the port is taken. */
function handleServerError(error: NodeJS.ErrnoException): void {
  if (error.code === 'EADDRINUSE') {
    log(`port ${PORT} is already in use; set PORT to use another one`);
  } else {
    log(`server error: ${error.message}`);
  }
  process.exit(1);
}

// The route() function is the only one that runs for every HTTP request. 
// It is called by handleRequest()
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Every route passes the gate first.
  if (!isLocal(req)) {
    log(`refused non-local request: ${req.method} ${pathOf(req)}`);
    json(res, 403, {
      error: 'Forbidden: only local requests are accepted (from 127.0.0.1, with a local Host, no proxy headers and no web Origin).',
    });
    return;
  }
  // local-only gate passed: route the request to the right handler. 
  // The only valid path is /mcp.
  const path = pathOf(req);
  if (path !== '/mcp') {
    json(res, 404, { error: `Not found: ${path}` });
  } else if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed: use POST /mcp.' }, { allow: 'POST' });
  } else {
    // Only MCP requests from the client (Claude Code) get here. 
    log(`route: POST /mcp → handleMcp`);
    await handleMcp(req, res);
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** The URL path without the query string; logs use it so they never record query strings. */
function pathOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0];
}
