import { LOGIN_HELP } from './config.js';
import { AuthError, newPage } from './session.js';

const WATCARD_BASE_URL = 'https://secure.touchnet.net/C22566_oneweb';

export interface WatCardBalance {
  name: string;
  type: string;
  amount: number;
  credit: number;
}

export interface WatCardTransaction {
  date: string;
  type: string;
  terminal: string;
  status: string;
  balance: number;
  units: number;
  amount: number;
}

function parseAmount(amountStr: string): number {
  // Remove dollar sign and parse as float
  // Handle negative values like "$-9.48"
  return parseFloat(amountStr.replace(/\$/, '').replace(/,/g, ''));
}

/**
 * Get WatCard account balances (Residence Plan, Flexible dollars, etc.)
 * by scraping the Funds/Balances page.
 */
export async function getWatCardBalances(): Promise<WatCardBalance[]> {
  const page = await newPage();
  try {
    // Navigate directly to the Deposit/Funds page
    await page.goto(`${WATCARD_BASE_URL}/Deposit`, {
      waitUntil: 'domcontentloaded',
    });

    const url = new URL(page.url());
    if (!url.hostname.includes('touchnet')) {
      throw new AuthError(
        `Redirected to ${page.url()} instead of WatCard portal. ${LOGIN_HELP}`,
      );
    }

    // Wait for the balance table to load
    await page.waitForSelector('table.table-base', { timeout: 30_000 });

    const balances = await page.evaluate(() => {
      const rows = document.querySelectorAll('table.table-base tbody tr');
      const results: any[] = [];

      rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          const name = cells[0].textContent?.trim() || '';
          const type = cells[1].textContent?.trim() || '';
          const amount = cells[2].textContent?.trim() || '$0.00';
          const credit = cells[3].textContent?.trim() || '$0.00';

          results.push({
            name,
            type,
            amount,
            credit,
          });
        }
      });

      return results;
    });

    return balances.map((b) => ({
      name: b.name,
      type: b.type,
      amount: parseAmount(b.amount),
      credit: parseAmount(b.credit),
    }));
  } finally {
    await page.close();
  }
}

/**
 * Get WatCard transaction history with optional date filtering.
 * The WatCard system uses POST requests with form data for filtering.
 */
export async function getWatCardTransactions(
  fromDate?: string,
  toDate?: string,
  limit = 50,
): Promise<WatCardTransaction[]> {
  const page = await newPage();
  try {
    // Navigate to dashboard first
    await page.goto(`${WATCARD_BASE_URL}/Account/Dashboard`, {
      waitUntil: 'domcontentloaded',
    });

    const url = new URL(page.url());
    if (!url.hostname.includes('touchnet')) {
      throw new AuthError(
        `Redirected to ${page.url()} instead of WatCard portal. ${LOGIN_HELP}`,
      );
    }

    // Click on Transactions dropdown
    await page.locator('a.dropdown-toggle:has-text("Transactions")').first().click();
    await page.waitForTimeout(300);

    // Click on Transaction History link
    await page.locator('a[href="/C22566_oneweb/TransactionHistory/Transactions"]').first().click();
    await page.waitForLoadState('domcontentloaded');

    // Click "View History" button to load transactions with default dates
    // (Date filtering is disabled for now as the form fields are unreliable)
    await page.click('button:has-text("View History")');

    // Wait for the transaction table to appear
    await page.waitForSelector('#transaction-history-result-table', {
      timeout: 30_000,
    });

    const transactions = await page.evaluate((maxLimit) => {
      const rows = document.querySelectorAll('#transaction-history-result-table tbody tr');
      const results: any[] = [];

      for (let i = 0; i < Math.min(rows.length, maxLimit); i++) {
        const row = rows[i];
        const cells = row.querySelectorAll('td');

        if (cells.length >= 7) {
          results.push({
            date: cells[0].textContent?.trim() || '',
            type: cells[1].textContent?.trim() || '',
            terminal: cells[2].textContent?.trim() || '',
            status: cells[3].textContent?.trim() || '',
            balance: cells[4].textContent?.trim() || '0',
            units: cells[5].textContent?.trim() || '0',
            amount: cells[6].textContent?.trim() || '$0.00',
          });
        }
      }

      return results;
    }, limit);

    return transactions.map((t) => ({
      date: t.date,
      type: t.type,
      terminal: t.terminal,
      status: t.status,
      balance: parseInt(t.balance, 10) || 0,
      units: parseInt(t.units, 10) || 0,
      amount: parseAmount(t.amount),
    }));
  } finally {
    await page.close();
  }
}
