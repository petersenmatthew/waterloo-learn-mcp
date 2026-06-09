#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { closeBrowser } from './session.js';
import { loadEnvLocal } from './env.js';

loadEnvLocal();

const PORT = Number(process.env.PORT ?? 8787);
const PATHNAME = process.env.LEARN_MCP_PATH ?? '/mcp';

// This server exposes your live LEARN session, so it MUST NOT be open to the
// public internet without a secret. Require a bearer token. If none is set we
// generate one and print it, rather than running wide open.
let TOKEN = process.env.LEARN_MCP_TOKEN;
if (!TOKEN) {
  TOKEN = randomBytes(24).toString('base64url');
  console.error(`No LEARN_MCP_TOKEN set — generated one for this run:\n  ${TOKEN}`);
  console.error('Set LEARN_MCP_TOKEN to keep it stable across restarts.');
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // The token can arrive two ways:
  //   1. In the URL path: /mcp/<token>  — for ChatGPT, whose custom connectors
  //      only offer OAuth / No Auth (no API-key field). With "No Auth" selected,
  //      the secret in the path *is* the credential; the public Funnel URL stays
  //      unguessable without it.
  //   2. In a header: "Authorization: Bearer <token>" or "X-Api-Key: <token>"
  //      — for clients that can send headers (curl, other MCP hosts).
  let pathToken = '';
  if (url.pathname === PATHNAME) {
    // header-based; fall through
  } else if (url.pathname.startsWith(`${PATHNAME}/`)) {
    pathToken = decodeURIComponent(url.pathname.slice(PATHNAME.length + 1));
  } else {
    res.writeHead(404).end();
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const xApiKey = Array.isArray(req.headers['x-api-key'])
    ? req.headers['x-api-key'][0]
    : (req.headers['x-api-key'] ?? '');
  const headerToken = authHeader.replace(/^Bearer\s+/i, '').trim() || xApiKey.trim();
  const presented = pathToken || headerToken;
  if (presented !== TOKEN) {
    unauthorized(res);
    return;
  }

  // Stateless: a fresh server + transport per request keeps things simple and
  // avoids cross-client session leakage. ChatGPT works fine without sessions.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('Request handling error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.error(`waterloo-learn MCP server (HTTP) listening on http://localhost:${PORT}${PATHNAME}`);
  console.error('Expose this over HTTPS with a tunnel, then add the public URL as a ChatGPT custom connector.');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    httpServer.close();
    await closeBrowser();
    process.exit(0);
  });
}
