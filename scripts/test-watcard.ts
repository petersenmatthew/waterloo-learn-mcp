#!/usr/bin/env tsx
/**
 * Quick test script to verify WatCard integration works.
 * Run with: npx tsx scripts/test-watcard.ts
 */

import { getWatCardBalances, getWatCardTransactions } from '../src/watcard.js';
import { closeBrowser } from '../src/session.js';
import { loadEnvLocal } from '../src/env.js';

loadEnvLocal();

async function testWatCard() {
  console.log('Testing WatCard integration...\n');

  try {
    console.log('📊 Fetching WatCard balances...');
    const balances = await getWatCardBalances();
    console.log('✅ Balances retrieved:');
    console.log(JSON.stringify(balances, null, 2));
    console.log('');

    console.log('💳 Fetching recent transactions...');
    const transactions = await getWatCardTransactions(undefined, undefined, 5);
    console.log('✅ Recent transactions (last 5):');
    console.log(JSON.stringify(transactions, null, 2));
    console.log('');

    console.log('✅ All tests passed! WatCard integration is working.');
  } catch (error) {
    console.error('❌ Test failed:');
    console.error(error);
    process.exit(1);
  } finally {
    await closeBrowser();
  }
}

testWatCard();
