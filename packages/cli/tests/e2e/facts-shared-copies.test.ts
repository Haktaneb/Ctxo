import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identical copies (PR 4, #156, Q15): the shared fact rules live in packages/lang-csharp/src/facts (the
 * masters) and are copied byte for byte into every official language plugin, because a plugin may import
 * only @ctxo/plugin-api. This test fails as soon as one copy drifts from the master.
 */
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(here, '../../..');

const MASTER = 'lang-csharp';
const COPIES = ['lang-typescript', 'lang-java', 'lang-go'] as const;
const SHARED_FILES = ['fact-options.ts', 'fact-rules.ts', 'fact-types.ts', 'finish-facts.ts'] as const;

/** Every `<package>/src/facts/<file>` whose bytes differ from the master's, or that is missing. */
function differingCopies(packagesDir: string): string[] {
  const differing: string[] = [];
  for (const file of SHARED_FILES) {
    const master = readFileSync(join(packagesDir, MASTER, 'src', 'facts', file));
    for (const copy of COPIES) {
      const label = `${copy}/src/facts/${file}`;
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(packagesDir, copy, 'src', 'facts', file));
      } catch {
        differing.push(`${label} (missing)`);
        continue;
      }
      if (!bytes.equals(master)) differing.push(label);
    }
  }
  return differing;
}

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** The master and every copy's shared files, in a temp packages folder. */
function copyShared(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctxo-facts-copies-'));
  temps.push(dir);
  for (const pkg of [MASTER, ...COPIES]) {
    for (const file of SHARED_FILES) {
      cpSync(join(PACKAGES, pkg, 'src', 'facts', file), join(dir, pkg, 'src', 'facts', file));
    }
  }
  return dir;
}

describe('shared fact rules are identical in every plugin', () => {
  it('fact-options.ts, fact-rules.ts, fact-types.ts and finish-facts.ts match the lang-csharp masters byte for byte', () => {
    expect(differingCopies(PACKAGES)).toEqual([]);
  });

  it('a copy that differs by one byte is reported', () => {
    const dir = copyShared();
    const target = join(dir, 'lang-go', 'src', 'facts', 'finish-facts.ts');
    writeFileSync(target, `${readFileSync(target, 'utf8')} `);
    expect(differingCopies(dir)).toEqual(['lang-go/src/facts/finish-facts.ts']);
  });

  it('a missing copy is reported', () => {
    const dir = copyShared();
    rmSync(join(dir, 'lang-java', 'src', 'facts', 'fact-types.ts'));
    expect(differingCopies(dir)).toEqual(['lang-java/src/facts/fact-types.ts (missing)']);
  });
});
