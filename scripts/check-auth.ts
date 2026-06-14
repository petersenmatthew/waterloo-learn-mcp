#!/usr/bin/env tsx
import { PROJECT_ROOT } from '../src/config.js';
import { apiGet, apiVersion, AuthError, closeBrowser } from '../src/session.js';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

try {
  const lp = await apiVersion('lp');
  await apiGet(`/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3&pageSize=1`);
  console.log('LEARN session looks valid.');
} catch (err) {
  if (err instanceof AuthError) {
    console.error(message(err));
  } else {
    console.error(`Could not verify the LEARN session: ${message(err)}`);
    console.error(`If your network is fine, run \`npm run login\` in ${PROJECT_ROOT} to refresh auth.json.`);
  }
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
