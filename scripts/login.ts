/**
 * One-time (per session expiry) login helper.
 *
 * Opens a headed browser at learn.uwaterloo.ca. Sign in with your WatIAM
 * credentials and approve the Duo 2FA push. The script then visits
 * outline.uwaterloo.ca so course outlines work too — approve a second Duo
 * prompt if one appears. Once both are done, the session cookies are saved
 * to auth.json and the MCP server can run headless without touching 2FA
 * again until the session expires.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = process.env.LEARN_BASE_URL ?? 'https://learn.uwaterloo.ca';
const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = process.env.LEARN_AUTH_FILE ?? path.resolve(here, '..', 'auth.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log(`Opening ${BASE_URL} — sign in and approve the Duo push.`);
console.log('Waiting up to 5 minutes for you to reach the LEARN homepage...');

await page.goto(`${BASE_URL}/d2l/home`);
await page.waitForURL(
  (url) => url.href.startsWith(BASE_URL) && url.pathname.startsWith('/d2l/home'),
  { timeout: 5 * 60 * 1000 },
);

console.log('LEARN session captured.');
console.log('Fetching an outline.uwaterloo.ca session — approve the second Duo prompt if asked.');
try {
  await page.goto('https://outline.uwaterloo.ca/');
  await page.waitForURL((url) => url.host === 'outline.uwaterloo.ca', {
    timeout: 5 * 60 * 1000,
  });
  console.log('Outline session captured.');
} catch (err) {
  console.warn(
    `Could not capture an outline.uwaterloo.ca session (${err}). ` +
      'get_course_outline will not work until the next login; all other tools are unaffected.',
  );
}

await context.storageState({ path: AUTH_FILE });
console.log(`Session saved to ${AUTH_FILE}`);
console.log('You can close this message; the MCP server will now work headless.');

await browser.close();
