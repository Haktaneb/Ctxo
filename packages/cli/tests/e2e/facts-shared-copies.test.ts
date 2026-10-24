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

/** The domain copies (PR 4 Part 2, W4): @ctxo/domain has no @ctxo/plugin-api dependency, so its types come from @ctxo/cli/internal. */
const DOMAIN_FACTS = join('domain', 'src', 'core', 'facts');
const DOMAIN_FILES = ['fact-rules.ts', 'fact-types.ts', 'finish-facts.ts'] as const;

/** The file without its leading `//` header lines, with the type import specifier normalized to @ctxo/plugin-api. */
function comparable(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && lines[start]!.startsWith('//')) start++;
  return lines.slice(start).join('\n').replace(/from '@ctxo\/cli\/internal'/g, "from '@ctxo/plugin-api'");
}

/** Every domain copy whose body (header and import specifier aside) differs from the master's, or that is missing. */
function differingDomainCopies(packagesDir: string): string[] {
  const differing: string[] = [];
  for (const file of DOMAIN_FILES) {
    const master = comparable(readFileSync(join(packagesDir, MASTER, 'src', 'facts', file), 'utf8'));
    const label = `domain/src/core/facts/${file}`;
    let copy: string;
    try {
      copy = readFileSync(join(packagesDir, DOMAIN_FACTS, file), 'utf8');
    } catch {
      differing.push(`${label} (missing)`);
      continue;
    }
    if (comparable(copy) !== master) differing.push(label);
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

describe('the domain copies of the fact rules match the masters (W4)', () => {
  /** The master and the domain copies, in a temp packages folder. */
  function copyDomain(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-facts-domain-'));
    temps.push(dir);
    for (const file of DOMAIN_FILES) {
      cpSync(join(PACKAGES, MASTER, 'src', 'facts', file), join(dir, MASTER, 'src', 'facts', file));
      cpSync(join(PACKAGES, DOMAIN_FACTS, file), join(dir, DOMAIN_FACTS, file));
    }
    return dir;
  }

  it('fact-rules.ts, fact-types.ts and finish-facts.ts match apart from the header and the import specifier', () => {
    expect(differingDomainCopies(PACKAGES)).toEqual([]);
  });

  it('a domain copy whose body differs is reported, a different header is not', () => {
    const dir = copyDomain();
    const rules = join(dir, DOMAIN_FACTS, 'fact-rules.ts');
    writeFileSync(rules, `// another header line\n${readFileSync(rules, 'utf8')}`);
    expect(differingDomainCopies(dir)).toEqual([]);
    const finisher = join(dir, DOMAIN_FACTS, 'finish-facts.ts');
    writeFileSync(finisher, readFileSync(finisher, 'utf8').replace('MAX_FACTS_PER_FILE)', 'MAX_FACTS_PER_FILE - 1)'));
    expect(differingDomainCopies(dir)).toEqual(['domain/src/core/facts/finish-facts.ts']);
  });

  it('a missing domain copy is reported', () => {
    const dir = copyDomain();
    rmSync(join(dir, DOMAIN_FACTS, 'fact-types.ts'));
    expect(differingDomainCopies(dir)).toEqual(['domain/src/core/facts/fact-types.ts (missing)']);
  });
});
