// Copies the root llms.txt and llms-full.txt into docs/public so the VitePress
// site serves them at /Ctxo/docs/llms.txt and /Ctxo/docs/llms-full.txt.
// The root files are the only copies in git; the copies are gitignored.
import { copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const publicDir = join(here, '..', 'docs', 'public');

for (const name of ['llms.txt', 'llms-full.txt']) {
  await copyFile(join(root, name), join(publicDir, name));
}
