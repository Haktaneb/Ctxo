import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoCompositeAdapter } from '../composite-adapter.js';
import { detectGoToolchain } from '../analyzer/toolchain-detect.js';

// The corpus lives with the rules in @ctxo/sql-extract; this side runs the cases written in Go.
const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, '..', '..', '..', 'sql-extract', 'corpus');
const LENDING_FIXTURE = join(here, '..', '..', 'test-fixtures', 'lending-module');

interface AccessLists { reads: string[]; writes: string[]; executes: string[] }
interface CorpusCase { name: string; mode: string; accesses: AccessLists }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The cases whose mode is `go` (their source is `<case>.go.fixture`). */
function goCases(): CorpusCase[] {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.expected.json'))
    .sort(cmp)
    .map((f) => ({
      ...(JSON.parse(readFileSync(join(corpusDir, f), 'utf8')) as Omit<CorpusCase, 'name'>),
      name: f.slice(0, -'.expected.json'.length),
    }))
    .filter((c) => c.mode === 'go');
}

const cases = goCases();
const fileOf = (c: CorpusCase): string => `${c.name}/case.go`;

const GO_MOD = `module corpus

go 1.22

require (
	github.com/jackc/pgx/v5 v5.0.0
	github.com/jmoiron/sqlx v1.0.0
	gorm.io/gorm v1.0.0
)

replace (
	github.com/jmoiron/sqlx => ./stubs/sqlx
	github.com/jackc/pgx/v5 => ./stubs/pgx
	gorm.io/gorm => ./stubs/gorm
)
`;

describe('Go corpus cases', () => {
  it('finds the Go cases', () => {
    expect(cases.map((c) => c.name)).toEqual(['go-constants', 'go-database-sql', 'go-sqlx-pgx-gorm']);
  });
});

describe.skipIf(!detectGoToolchain().available)('Go corpus cases (ctxo-go-analyzer)', () => {
  let root = '';
  const composite = new GoCompositeAdapter({ sqlCallSites: true });

  beforeAll(async () => {
    // One module holds every case plus the lending stubs, so the analyzer runs once.
    root = mkdtempSync(join(tmpdir(), 'ctxo-go-corpus-'));
    cpSync(join(LENDING_FIXTURE, 'stubs'), join(root, 'stubs'), { recursive: true });
    writeFileSync(join(root, 'go.mod'), GO_MOD);
    for (const c of cases) {
      mkdirSync(join(root, c.name), { recursive: true });
      writeFileSync(join(root, fileOf(c)), readFileSync(join(corpusDir, `${c.name}.go.fixture`), 'utf8'));
    }
    await composite.initialize(root);
  }, 180_000);

  afterAll(async () => {
    await composite.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(cases)('$name: call-site accesses match the corpus', async (c) => {
    expect(composite.getTier()).toBe('full');
    const edges = await composite.extractEdges(fileOf(c), '');

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
  }, 180_000);
});
