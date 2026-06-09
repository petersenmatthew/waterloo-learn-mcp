import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AUTH_FILE, BASE_URL, LOGIN_HELP } from './config.js';

export class AuthError extends Error {}

let browser: Browser | null = null;
let context: BrowserContext | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new AuthError(LOGIN_HELP);
  }
  if (!browser) {
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

/**
 * GET a D2L REST endpoint using the saved session cookies. Brightspace's
 * /d2l/api/* routes accept the d2lSessionVal cookies, so no OAuth token is
 * needed. An expired session shows up as a redirect to the login page.
 */
export async function apiGet<T>(apiPath: string): Promise<T> {
  const ctx = await getContext();
  const res = await ctx.request.get(`${BASE_URL}${apiPath}`, {
    headers: { Accept: 'application/json' },
    maxRedirects: 0,
  });

  if (res.status() >= 300 && res.status() < 400) {
    throw new AuthError(`Session expired (got redirect from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (res.status() === 401) {
    throw new AuthError(`Session rejected (401 from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (!res.ok()) {
    throw new Error(`LEARN API error ${res.status()} for ${apiPath}: ${(await res.text()).slice(0, 300)}`);
  }
  const contentType = res.headers()['content-type'] ?? '';
  if (!contentType.includes('json')) {
    throw new AuthError(`Expected JSON from ${apiPath} but got ${contentType || 'unknown'} — session likely expired. ${LOGIN_HELP}`);
  }
  return (await res.json()) as T;
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
  const ctx = await getContext();
  const res = await ctx.request.get(`${BASE_URL}${apiPath}`, { maxRedirects: 0 });

  if (res.status() >= 300 && res.status() < 400) {
    throw new AuthError(`Session expired (got redirect from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (res.status() === 401) {
    throw new AuthError(`Session rejected (401 from ${apiPath}). ${LOGIN_HELP}`);
  }
  if (!res.ok()) {
    throw new Error(`LEARN file error ${res.status()} for ${apiPath}: ${(await res.text()).slice(0, 300)}`);
  }

  const contentType = res.headers()['content-type'] ?? '';
  // A login page served as HTML means the session is gone, not that the topic
  // is an HTML file — real HTML topics come through the API with a filename.
  const disposition = res.headers()['content-disposition'] ?? '';
  const filenameMatch =
    disposition.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i) ??
    disposition.match(/filename="?([^";]+)"?/i);
  const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : undefined;
  if (contentType.includes('text/html') && !filename) {
    throw new AuthError(`Expected a file from ${apiPath} but got an HTML page — session likely expired. ${LOGIN_HELP}`);
  }

  return { body: await res.body(), contentType, filename };
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
