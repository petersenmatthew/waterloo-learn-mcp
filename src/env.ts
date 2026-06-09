import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env.local loader (no dependency). Reads KEY=VALUE lines from the
 * project root's .env.local and sets any that aren't already in the
 * environment. Comments (#…) and blank lines are ignored. This lets the HTTP
 * server pick up LEARN_MCP_TOKEN / PORT written by scripts/chatgpt-setup.sh
 * without the launcher having to export them.
 */
export function loadEnvLocal(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let val = match[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val !== '' && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
