import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What `npm publish` would put in the tarball. Needs `pnpm --filter @ctxo/domain build` first, like the cli's. */
function packedFiles(): string[] {
  const output = execSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf-8' });
  return ((JSON.parse(output) as { files?: { path: string }[] }[])[0]?.files ?? []).map((f) => f.path);
}

describe('@ctxo/domain packaging (M8)', () => {
  it('npm pack --dry-run carries the entry, its types, the bundled skill, the schema and the README', { timeout: 60_000 }, () => {
    const files = packedFiles();
    for (const required of [
      'package.json',
      'README.md',
      'dist/index.js',
      'dist/index.d.ts',
      'skills/ctxo-domain-fold/SKILL.md',
      'schema/contexts.schema.json',
    ]) {
      expect(files, required).toContain(required);
    }
  });

  it('npm pack --dry-run leaves out source, tests, e2e and fixtures', { timeout: 60_000 }, () => {
    const files = packedFiles();
    for (const prefix of ['src/', 'e2e/', 'test-fixtures/']) {
      expect(files.filter((f) => f.startsWith(prefix)), prefix).toEqual([]);
    }
    expect(files.filter((f) => f.includes('__tests__'))).toEqual([]);
  });
});
