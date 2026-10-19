import { resolve } from 'node:path';

// Explicit allowlist shared by storage import and HTTP seed verification.
export function seedArtifactTarget() {
  const args = process.argv.slice(2).join(' ');
  if (!['', '--target production'].includes(args)) throw new Error('Only the production target exists; the development branch was deleted.');
  return {
    root: resolve('.seed-data/production'), database: 'neondb', branchId: 'br-plain-glade-b50xod5j',
    host: 'ep-orange-bonus-b5ahitkr.c-7.us-east-2.aws.neon.tech'
  };
}
