import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsMorphAdapter } from '../ts-morph-adapter.js';
import { KNOWN_SQL_APIS, packageOfSpecifier } from '../sql/known-sql-apis.js';

// The corpus lives with the rules in @ctxo/sql-extract; this side runs the cases written in TypeScript.
const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sql-extract', 'corpus');

interface AccessLists { reads: string[]; writes: string[]; executes: string[] }
interface CorpusCase { name: string; mode: string; accesses: AccessLists }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The cases whose mode is `typescript` (their source is `<case>.ts.fixture`). */
function typescriptCases(): CorpusCase[] {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.expected.json'))
    .sort(cmp)
    .map((f) => ({
      ...(JSON.parse(readFileSync(join(corpusDir, f), 'utf8')) as Omit<CorpusCase, 'name'>),
      name: f.slice(0, -'.expected.json'.length),
    }))
    .filter((c) => c.mode === 'typescript');
}

const cases = typescriptCases();
const sourceOf = (c: CorpusCase): string => readFileSync(join(corpusDir, `${c.name}.ts.fixture`), 'utf8');

describe('TypeScript corpus cases', () => {
  it('finds the TypeScript cases', () => {
    expect(cases.map((c) => c.name)).toEqual(['ts-constants', 'ts-node-drivers', 'ts-orm-raw-sql']);
  });

  it.each(cases)('$name: call-site accesses match the corpus', async (c) => {
    const adapter = new TsMorphAdapter({ sqlCallSites: true });
    const edges = await adapter.extractEdges(`src/${c.name}.ts`, sourceOf(c));

    const sets = { reads: new Set<string>(), writes: new Set<string>(), executes: new Set<string>() };
    for (const e of edges) {
      if (e.kind !== 'reads' && e.kind !== 'writes' && e.kind !== 'executes') continue;
      expect(e.to.endsWith(e.kind === 'executes' ? '::procedure' : '::table'), `${c.name}: ${e.kind} ${e.to}`).toBe(true);
      sets[e.kind].add(e.to.split('::')[0]!);
    }
    expect({
      reads: [...sets.reads].sort(cmp),
      writes: [...sets.writes].sort(cmp),
      executes: [...sets.executes].sort(cmp),
    }).toEqual(c.accesses);
  });

  it('the typescript cases name every module of the API table', () => {
    const named = new Set<string>();
    for (const c of cases) {
      for (const m of sourceOf(c).matchAll(/\bfrom\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        named.add(packageOfSpecifier((m[1] ?? m[2])!));
      }
    }
    const modules = [...new Set(KNOWN_SQL_APIS.map((r) => r.module))];
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) expect(named.has(module), module).toBe(true);
  });
});
