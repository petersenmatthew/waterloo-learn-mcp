#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { closeBrowser } from './session.js';
import { loadEnvLocal } from './env.js';

loadEnvLocal();

const PORT = Number(process.env.PORT ?? 8787);
const PATHNAME = process.env.LEARN_MCP_PATH ?? '/mcp';
const OAUTH_SCOPE = 'mcp:tools';
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OAUTH_STATE_FILE = process.env.LEARN_MCP_OAUTH_FILE ?? path.join(ROOT, 'oauth.json');

// This server exposes your live LEARN session, so it MUST NOT be open to the
// public internet without a secret. Require a bearer token. If none is set we
// generate one and print it, rather than running wide open.
let TOKEN = process.env.LEARN_MCP_TOKEN;
if (!TOKEN) {
  TOKEN = randomBytes(24).toString('base64url');
  console.error(`No LEARN_MCP_TOKEN set — generated one for this run:\n  ${TOKEN}`);
  console.error('Set LEARN_MCP_TOKEN to keep it stable across restarts.');
}

type ClientInfo = {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
} & Record<string, unknown>;

type AuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  expiresAt: number;
};

type OAuthToken = {
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: number;
};

const clients = new Map<string, ClientInfo>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, OAuthToken>();
const refreshTokens = new Map<string, OAuthToken>();

type OAuthState = {
  clients?: [string, ClientInfo][];
  accessTokens?: [string, OAuthToken][];
  refreshTokens?: [string, OAuthToken][];
};

function loadOAuthState() {
  if (!fs.existsSync(OAUTH_STATE_FILE)) return;
  try {
    const state = JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, 'utf8')) as OAuthState;
    for (const [id, client] of state.clients ?? []) clients.set(id, client);
    for (const [token, data] of state.accessTokens ?? []) {
      if (data.expiresAt >= Date.now()) accessTokens.set(token, data);
    }
    for (const [token, data] of state.refreshTokens ?? []) {
      if (data.expiresAt >= Date.now()) refreshTokens.set(token, data);
    }
    console.error(
      `Loaded OAuth state from ${OAUTH_STATE_FILE}: ` +
        `${clients.size} clients, ${accessTokens.size} access tokens, ${refreshTokens.size} refresh tokens.`,
    );
  } catch (err) {
    console.error(`Could not load OAuth state from ${OAUTH_STATE_FILE}:`, err);
  }
}

function saveOAuthState() {
  const state: OAuthState = {
    clients: [...clients.entries()],
    accessTokens: [...accessTokens.entries()].filter(([, data]) => data.expiresAt >= Date.now()),
    refreshTokens: [...refreshTokens.entries()].filter(([, data]) => data.expiresAt >= Date.now()),
  };
  const tmp = `${OAUTH_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, OAUTH_STATE_FILE);
  fs.chmodSync(OAUTH_STATE_FILE, 0o600);
}

loadOAuthState();

function publicBaseUrl(req: IncomingMessage) {
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim();
  const host = firstHeader(req.headers['x-forwarded-host']) ?? req.headers.host ?? `localhost:${PORT}`;
  const proto = forwardedProto ?? (host.endsWith('.ts.net') ? 'https' : 'http');
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function oauthProtectedResourceMetadataUrl(req: IncomingMessage) {
  return `${publicBaseUrl(req)}/.well-known/oauth-protected-resource${PATHNAME}`;
}

function unauthorized(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer resource_metadata="${oauthProtectedResourceMetadataUrl(req)}"`,
  });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function readForm(req: IncomingMessage) {
  const raw = await readRawBody(req);
  return new URLSearchParams(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendCorsPreflight(res: ServerResponse) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function oauthMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

function protectedResourceMetadata(req: IncomingMessage) {
  const base = publicBaseUrl(req);
  return {
    resource: `${base}${PATHNAME}`,
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: 'Waterloo Learn MCP',
  };
}

function redactPath(pathname: string) {
  if (!pathname.startsWith(`${PATHNAME}/`)) return pathname;
  return `${PATHNAME}/[redacted]`;
}

function htmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function verifyPkce(verifier: string, challenge: string) {
  const actual = createHash('sha256').update(verifier).digest('base64url');
  return actual === challenge;
}

function redirectWithError(redirectUri: string, error: string, description?: string, state?: string) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return target.toString();
}

function validRedirectUri(requested: string, client: ClientInfo) {
  return client.redirect_uris.includes(requested);
}

async function handleOAuthRegister(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'OPTIONS') return sendCorsPreflight(res);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

  const metadata = (await readJsonBody(req)) as Partial<ClientInfo> | undefined;
  if (!metadata || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
    return sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
  }

  const isPublicClient = metadata.token_endpoint_auth_method === 'none';
  const issuedAt = Math.floor(Date.now() / 1000);
  const client: ClientInfo = {
    ...metadata,
    client_id: randomUUID(),
    client_id_issued_at: issuedAt,
    client_secret: isPublicClient ? undefined : randomBytes(32).toString('base64url'),
    client_secret_expires_at: isPublicClient ? undefined : issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    redirect_uris: metadata.redirect_uris,
    token_endpoint_auth_method: metadata.token_endpoint_auth_method ?? 'client_secret_post',
  };
  clients.set(client.client_id, client);
  saveOAuthState();
  return sendJson(res, 201, client, { 'Access-Control-Allow-Origin': '*' });
}

function renderAuthorizePage(res: ServerResponse, params: URLSearchParams) {
  const hiddenInputs = [...params.entries()]
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join('\n');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Waterloo Learn MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f7f5; color: #1d1d1b; }
    main { width: min(420px, calc(100vw - 32px)); background: white; border: 1px solid #ddd; border-radius: 8px; padding: 24px; box-shadow: 0 10px 40px rgb(0 0 0 / 8%); }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { color: #555; line-height: 1.45; }
    label { display: block; font-weight: 650; margin: 18px 0 8px; }
    input[type="password"] { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #bbb; border-radius: 6px; font: inherit; }
    button { margin-top: 16px; width: 100%; border: 0; border-radius: 6px; background: #111; color: white; padding: 11px 14px; font: inherit; font-weight: 650; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Waterloo Learn MCP</h1>
    <p>Paste your connection code from <code>.env.local</code> to let this chat app use your LEARN MCP server.</p>
    <form method="post" action="/authorize">
      ${hiddenInputs}
      <label for="setup_code">Connection code</label>
      <input id="setup_code" name="setup_code" type="password" autocomplete="one-time-code" autofocus required>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`);
}

async function handleOAuthAuthorize(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

  const params = req.method === 'POST' ? await readForm(req) : url.searchParams;
  const clientId = params.get('client_id') ?? '';
  const client = clients.get(clientId);
  const redirectUri = params.get('redirect_uri') ?? (client?.redirect_uris.length === 1 ? client.redirect_uris[0] : '');

  if (!client) return sendJson(res, 400, { error: 'invalid_client', error_description: 'Unknown client_id' });
  if (!redirectUri || !validRedirectUri(redirectUri, client)) {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'Unregistered redirect_uri' });
  }

  const state = params.get('state') ?? undefined;
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  if (responseType !== 'code' || !codeChallenge || codeChallengeMethod !== 'S256') {
    res.writeHead(302, { Location: redirectWithError(redirectUri, 'invalid_request', 'Authorization code with PKCE S256 is required', state) });
    res.end();
    return;
  }

  if (req.method === 'GET') return renderAuthorizePage(res, params);

  if (params.get('setup_code') !== TOKEN) {
    return renderAuthorizePage(res, params);
  }

  const code = randomUUID();
  authCodes.set(code, {
    clientId: client.client_id,
    redirectUri,
    codeChallenge,
    scope: params.get('scope') || OAUTH_SCOPE,
    resource: params.get('resource') ?? undefined,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

function clientFromTokenRequest(req: IncomingMessage, form: URLSearchParams) {
  const authHeader = firstHeader(req.headers.authorization);
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  }
  return { clientId: form.get('client_id') ?? '', clientSecret: form.get('client_secret') ?? undefined };
}

function verifyTokenClient(req: IncomingMessage, form: URLSearchParams) {
  const { clientId, clientSecret } = clientFromTokenRequest(req, form);
  const client = clients.get(clientId);
  if (!client) return undefined;
  if (client.token_endpoint_auth_method !== 'none' && client.client_secret !== clientSecret) return undefined;
  return client;
}

async function handleOAuthToken(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'OPTIONS') return sendCorsPreflight(res);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

  const form = await readForm(req);
  const client = verifyTokenClient(req, form);
  if (!client) return sendJson(res, 401, { error: 'invalid_client' }, { 'Access-Control-Allow-Origin': '*' });

  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? '';
    const codeVerifier = form.get('code_verifier') ?? '';
    const authCode = authCodes.get(code);
    if (!authCode || authCode.expiresAt < Date.now() || authCode.clientId !== client.client_id) {
      return sendJson(res, 400, { error: 'invalid_grant' }, { 'Access-Control-Allow-Origin': '*' });
    }
    if ((form.get('redirect_uri') ?? authCode.redirectUri) !== authCode.redirectUri) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (!verifyPkce(codeVerifier, authCode.codeChallenge)) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }, { 'Access-Control-Allow-Origin': '*' });
    }

    authCodes.delete(code);
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const tokenData: OAuthToken = {
      clientId: client.client_id,
      scope: authCode.scope,
      resource: authCode.resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    };
    accessTokens.set(accessToken, tokenData);
    refreshTokens.set(refreshToken, tokenData);
    saveOAuthState();
    return sendJson(
      res,
      200,
      {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: authCode.scope,
      },
      { 'Access-Control-Allow-Origin': '*' },
    );
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token') ?? '';
    const tokenData = refreshTokens.get(refreshToken);
    if (!tokenData || tokenData.expiresAt < Date.now() || tokenData.clientId !== client.client_id) {
      return sendJson(res, 400, { error: 'invalid_grant' }, { 'Access-Control-Allow-Origin': '*' });
    }
    const accessToken = randomBytes(32).toString('base64url');
    accessTokens.set(accessToken, { ...tokenData, expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 });
    saveOAuthState();
    return sendJson(
      res,
      200,
      {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: tokenData.scope,
      },
      { 'Access-Control-Allow-Origin': '*' },
    );
  }

  return sendJson(res, 400, { error: 'unsupported_grant_type' }, { 'Access-Control-Allow-Origin': '*' });
}

function validPresentedToken(token: string) {
  if (token === TOKEN) return true;
  const oauthToken = accessTokens.get(token);
  return Boolean(oauthToken && oauthToken.expiresAt >= Date.now());
}

// Remember the clientInfo each token sent in its `initialize` request so later
// stateless requests (which carry no clientInfo) can still be attributed.
const mcpClientByToken = new Map<string, string>();

function clientLabelForToken(token: string) {
  const fromInitialize = mcpClientByToken.get(token);
  if (fromInitialize) return fromInitialize;
  const oauthToken = accessTokens.get(token);
  const registered = oauthToken && clients.get(oauthToken.clientId)?.client_name;
  if (typeof registered === 'string' && registered) return registered;
  return 'unknown';
}

function logMcpMessages(body: unknown, token: string) {
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const { method, params } = msg as { method?: unknown; params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown } } };
    if (typeof method !== 'string') continue;

    if (method === 'initialize') {
      const { name, version } = params?.clientInfo ?? {};
      if (typeof name === 'string') {
        mcpClientByToken.set(token, version ? `${name}/${version}` : name);
      }
    }

    let detail = method;
    if (method === 'tools/call' && typeof params?.name === 'string') detail = `tools/call ${params.name}`;
    console.error(`[mcp] ${new Date().toISOString()} client=${clientLabelForToken(token)} ${detail}`);
  }
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  console.error(
    `[req] ${new Date().toISOString()} ${req.method} ${redactPath(url.pathname)}${url.search} ` +
      `auth=${req.headers.authorization ? 'bearer' : req.headers['x-api-key'] ? 'xapikey' : 'none'} ` +
      `accept=${req.headers.accept ?? ''} ua=${req.headers['user-agent'] ?? ''}`,
  );

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'OPTIONS') {
    sendCorsPreflight(res);
    return;
  }

  if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
    sendJson(res, 200, oauthMetadata(publicBaseUrl(req)), { 'Access-Control-Allow-Origin': '*' });
    return;
  }

  if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === `/.well-known/oauth-protected-resource${PATHNAME}`) {
    sendJson(res, 200, protectedResourceMetadata(req), { 'Access-Control-Allow-Origin': '*' });
    return;
  }

  if (url.pathname === '/register') {
    await handleOAuthRegister(req, res);
    return;
  }

  if (url.pathname === '/authorize') {
    await handleOAuthAuthorize(req, res, url);
    return;
  }

  if (url.pathname === '/token') {
    await handleOAuthToken(req, res);
    return;
  }

  // Accept the current OAuth bearer tokens plus the original personal-token
  // shortcuts, which are useful for curl and clients that cannot do OAuth.
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
  if (!validPresentedToken(presented)) {
    unauthorized(req, res);
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
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    if (body !== undefined) {
      logMcpMessages(body, presented);
    } else if (req.method === 'GET') {
      console.error(`[mcp] ${new Date().toISOString()} client=${clientLabelForToken(presented)} sse-stream`);
    }
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
