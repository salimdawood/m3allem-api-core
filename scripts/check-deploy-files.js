// Check runtime source imports before generating the platform's Prisma client.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pending = [new URL('../src/server.js', import.meta.url)];
const checked = new Set();
while (pending.length) {
  const url = pending.pop();
  if (checked.has(url.href)) continue;
  let source;
  try { source = await readFile(url, 'utf8'); }
  catch { throw new Error(`Deployment source file is missing: ${fileURLToPath(url)}. Check Git tracking and ignore rules, then commit the missing source.`); }
  checked.add(url.href);
  for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) pending.push(new URL(match[1], url));
}
console.log(`Deployment source check passed: ${checked.size} runtime modules present.`);
