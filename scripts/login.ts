/**
 * One-time (per session expiry) login helper.
 *
 * Opens a headed browser at learn.uwaterloo.ca. Sign in with your WatIAM
 * credentials and approve the Duo 2FA push. If WATIAM_USERNAME and
 * WATIAM_PASSWORD are set, the script will fill those credentials for you
 * before waiting for Duo. The script then visits outline.uwaterloo.ca so
 * course outlines work too — approve a second Duo
 * prompt if one appears. Once both are done, the session cookies are saved
 * to auth.json and the MCP server can run headless without touching 2FA
 * again until the session expires.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright';
import { loadEnvLocal } from '../src/env.js';

loadEnvLocal();

const BASE_URL = process.env.LEARN_BASE_URL ?? 'https://learn.uwaterloo.ca';
const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = process.env.LEARN_AUTH_FILE ?? path.resolve(here, '..', 'auth.json');
const WATIAM_USERNAME = process.env.WATIAM_USERNAME;
const WATIAM_PASSWORD = process.env.WATIAM_PASSWORD;
const WATIAM_LOGIN_DOMAIN = process.env.WATIAM_LOGIN_DOMAIN ?? 'uwaterloo.ca';

const USERNAME_SELECTORS = [
  'input[name="j_username"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="loginfmt"]',
  'input[id="username"]',
  'input[id="userNameInput"]',
  'input[id="i0116"]',
  'input[type="email"]',
  'input[type="text"][autocomplete="username"]',
  'input[type="text"][placeholder*="username" i]',
  'input[type="text"][placeholder*="WatIAM" i]',
];

const PASSWORD_SELECTORS = [
  'input[name="j_password"]',
  'input[name="password"]',
  'input[id="password"]',
  'input[id="passwordInput"]',
  'input[id="i0118"]',
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  'button:has-text("Next")',
  'input[value="Sign in"]',
  'input[value="Log in"]',
  'input[value="Login"]',
  'form button',
];

async function visibleLocator(page: Page, selectors: string[], timeout = 750): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout })) {
        return locator;
      }
    } catch {
      // Try the next selector.
    }
  }
  return null;
}

async function clickSubmitOrPressEnter(page: Page, fallback: Locator): Promise<void> {
  const submit = await visibleLocator(page, SUBMIT_SELECTORS);
  if (submit) {
    await submit.click();
    return;
  }
  await fallback.press('Enter');
}

function watIamLoginId(username: string): string {
  if (username.includes('@') || username.includes('\\')) {
    return username;
  }
  return `${username}@${WATIAM_LOGIN_DOMAIN}`;
}

async function autofillWatIamCredentials(page: Page): Promise<void> {
  if (!WATIAM_USERNAME && !WATIAM_PASSWORD) return;
  if (!WATIAM_USERNAME || !WATIAM_PASSWORD) {
    console.warn('Set both WATIAM_USERNAME and WATIAM_PASSWORD to enable login autofill.');
    return;
  }

  console.log('WatIAM credentials found in env; attempting to autofill username/password.');

  try {
    await page.waitForLoadState('domcontentloaded');
    const firstField = await page
      .waitForSelector([...USERNAME_SELECTORS, ...PASSWORD_SELECTORS].join(', '), {
        state: 'visible',
        timeout: 30_000,
      })
      .catch(() => null);
    if (!firstField) {
      console.warn('No login form appeared; continue manually if the browser is waiting for input.');
      return;
    }

    const usernameField = await visibleLocator(page, USERNAME_SELECTORS);
    if (usernameField) {
      await usernameField.fill(watIamLoginId(WATIAM_USERNAME));
    }

    let passwordField = await visibleLocator(page, PASSWORD_SELECTORS);
    if (!passwordField && usernameField) {
      await clickSubmitOrPressEnter(page, usernameField);
      passwordField = await visibleLocator(page, PASSWORD_SELECTORS, 15_000);
    }

    if (!passwordField) {
      console.warn('Could not find a password field; continue manually in the browser.');
      return;
    }

    await passwordField.fill(WATIAM_PASSWORD);
    await clickSubmitOrPressEnter(page, passwordField);
    console.log('Credentials submitted. Approve Duo if prompted.');
  } catch (err) {
    console.warn(`Autofill did not complete (${err}). Continue manually in the browser.`);
  }
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log(`Opening ${BASE_URL} — sign in and approve the Duo push.`);
console.log('Waiting up to 5 minutes for you to reach the LEARN homepage...');

await page.goto(`${BASE_URL}/d2l/home`);
await autofillWatIamCredentials(page);
await page.waitForURL(
  (url) => url.href.startsWith(BASE_URL) && url.pathname.startsWith('/d2l/home'),
  { timeout: 5 * 60 * 1000 },
);

console.log('LEARN session captured.');
console.log('Fetching an outline.uwaterloo.ca viewer session — approve the second Duo prompt if asked.');
try {
  await page.goto('https://outline.uwaterloo.ca/viewer/');
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
