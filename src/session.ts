import fs from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AUTH_FILE, BASE_URL, LOGIN_HELP } from './config.js';

export class AuthError extends Error {}

// ---------------------------------------------------------------------------
// Cookie jar built from the Playwright storage state in auth.json. All HTTP
// goes through plain fetch with these cookies — no browser launch needed.
// Set-Cookie updates from responses are kept in memory for the process
// lifetime, matching the old BrowserContext behavior (auth.json is never
// rewritten outside `npm run login`).
// ---------------------------------------------------------------------------

interface JarCookie {
  name: string;
  value: string;
  /** Normalized: no leading dot. */
  domain: string;
  /** True when the cookie applies to subdomains (had a leading-dot domain). */
  includeSubdomains: boolean;
  path: string;
  /** Unix seconds; undefined or -1 means session cookie (no expiry). */
  expires?: number;
}

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
}

let jar: JarCookie[] | null = null;

function loadJar(): JarCookie[] {
  if (jar) return jar;
  if (!fs.existsSync(AUTH_FILE)) {
    throw new AuthError(LOGIN_HELP);
  }
  const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as { cookies?: StorageStateCookie[] };
  jar = (state.cookies ?? []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ''),
    includeSubdomains: c.domain.startsWith('.'),
    path: c.path || '/',
    expires: c.expires,
  }));
  return jar;
}

function cookieMatches(cookie: JarCookie, url: URL): boolean {
  if (cookie.expires !== undefined && cookie.expires !== -1 && cookie.expires * 1000 < Date.now()) {
    return false;
  }
  const host = url.hostname;
  const domainOk = cookie.includeSubdomains
    ? host === cookie.domain || host.endsWith(`.${cookie.domain}`)
    : host === cookie.domain;
  if (!domainOk) return false;
  const p = cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`;
  return url.pathname === cookie.path || `${url.pathname}/`.startsWith(p);
}

function cookieHeader(url: URL): string {
  return loadJar()
    .filter((c) => cookieMatches(c, url))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** Merge a Set-Cookie header into the in-memory jar. */
function storeSetCookie(header: string, requestUrl: URL): void {
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();

  let domain = requestUrl.hostname;
  let includeSubdomains = false;
  let path = '/';
  let expires: number | undefined;
  for (const attr of attrs) {
    const [k, v = ''] = attr.split('=');
    switch (k.trim().toLowerCase()) {
      case 'domain':
        domain = v.trim().replace(/^\./, '');
        includeSubdomains = true;
        break;
      case 'path':
        path = v.trim() || '/';
        break;
      case 'expires': {
        const t = Date.parse(v.trim());
        if (!Number.isNaN(t)) expires = t / 1000;
        break;
      }
      case 'max-age': {
        const secs = Number(v.trim());
        if (!Number.isNaN(secs)) expires = Date.now() / 1000 + secs;
        break;
      }
    }
  }

  const cookies = loadJar();
  const existing = cookies.findIndex((c) => c.name === name && c.domain === domain && c.path === path);
  const cookie: JarCookie = { name, value, domain, includeSubdomains, path, expires };
  if (existing >= 0) cookies[existing] = cookie;
  else cookies.push(cookie);
}

export interface SessionResponse {
  status: number;
  /** Final URL after any followed redirects. */
  url: string;
  headers: Headers;
  body: Buffer;
  text: string;
}

/**
 * GET a URL with the saved session cookies. Redirects are followed manually
 * (up to `maxRedirects`, default 0) so callers can treat an unexpected
 * redirect — D2L and outline.uwaterloo.ca both bounce expired sessions to
 * SSO — as an auth failure rather than silently landing on a login page.
 */
export async function sessionGet(
  urlStr: string,
  options: { maxRedirects?: number; headers?: Record<string, string> } = {},
): Promise<SessionResponse> {
  const maxRedirects = options.maxRedirects ?? 0;
  let url = new URL(urlStr);

  for (let hop = 0; ; hop++) {
    const cookie = cookieHeader(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { ...(options.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const sc of res.headers.getSetCookie()) {
      storeSetCookie(sc, url);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
      await res.arrayBuffer().catch(() => undefined); // drain before re-requesting
      url = new URL(location, url);
      continue;
    }

    const body = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      url: url.href,
      headers: res.headers,
      body,
      text: body.toString('utf8'),
    };
  }
}

/**
 * GET a D2L REST endpoint using the saved session cookies. Brightspace's
 * /d2l/api/* routes accept the d2lSessionVal cookies, so no OAuth token is
 * needed. An expired session shows up as a redirect to the login page.
 */
export async function apiGet<T>(apiPath: string): Promise<T> {
  const res = await sessionGet(`${BASE_URL}${apiPath}`, { headers: { Accept: 'application/json' } });

  if (res.status >= 300 && res.status < 400) {
    throw new AuthError(`Session expired (got redirect from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (res.status === 401) {
    throw new AuthError(`Session rejected (401 from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LEARN API error ${res.status} for ${apiPath}: ${res.text.slice(0, 300)}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new AuthError(`Expected JSON from ${apiPath} but got ${contentType || 'unknown'} — session likely expired. ${LOGIN_HELP}`);
  }
  return JSON.parse(res.text) as T;
}

export interface BinaryResponse {
  body: Buffer;
  contentType: string;
  filename?: string;
}

/**
 * GET a D2L endpoint that returns a file (PDF, PPTX, ...) using the saved
 * session cookies. Same auth handling as apiGet, but returns raw bytes.
 */
export async function apiGetBinary(apiPath: string): Promise<BinaryResponse> {
  const res = await sessionGet(`${BASE_URL}${apiPath}`);

  if (res.status >= 300 && res.status < 400) {
    throw new AuthError(`Session expired (got redirect from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (res.status === 401) {
    throw new AuthError(`Session rejected (401 from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LEARN file error ${res.status} for ${apiPath}: ${res.text.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  // A login page served as HTML means the session is gone, not that the topic
  // is an HTML file — real HTML topics come through the API with a filename.
  const disposition = res.headers.get('content-disposition') ?? '';
  const filenameMatch =
    disposition.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i) ??
    disposition.match(/filename="?([^";]+)"?/i);
  const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : undefined;
  if (contentType.includes('text/html') && !filename) {
    throw new AuthError(`Expected a file from ${apiPath} but got an HTML page — session likely expired. ${LOGIN_HELP}`);
  }

  return { body: res.body, contentType, filename };
}

// ---------------------------------------------------------------------------
// Browser support for the scrape fallbacks (homepage course widget, My Grades
// table). Playwright is imported lazily so the common REST path never pays
// for loading it, let alone launching Chromium.
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new AuthError(LOGIN_HELP);
  }
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }
  if (!context) {
    context = await browser.newContext({ storageState: AUTH_FILE });
  }
  return context;
}

export async function newPage(): Promise<Page> {
  const ctx = await getContext();
  return ctx.newPage();
}

export async function closeBrowser(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
}

// D2L exposes its supported API versions at /d2l/api/versions/. Discover them
// once so endpoint paths track whatever the Waterloo instance actually runs.
const FALLBACK_VERSIONS: Record<string, string> = { le: '1.51', lp: '1.31' };
let versionsPromise: Promise<Record<string, string>> | null = null;

interface ProductVersion {
  ProductCode: string;
  LatestVersion: string;
}

export async function apiVersion(product: 'le' | 'lp'): Promise<string> {
  versionsPromise ??= apiGet<ProductVersion[]>('/d2l/api/versions/')
    .then((products) =>
      Object.fromEntries(products.map((p) => [p.ProductCode, p.LatestVersion])),
    )
    .catch((err) => {
      if (err instanceof AuthError) {
        versionsPromise = null; // retry discovery after the user logs in again
        throw err;
      }
      console.error(`Falling back to default D2L API versions: ${err}`);
      return FALLBACK_VERSIONS;
    });
  const versions = await versionsPromise;
  return versions[product] ?? FALLBACK_VERSIONS[product];
}
