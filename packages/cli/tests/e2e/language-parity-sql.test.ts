import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexCommand } from '../../src/cli/index-command.js';
import { loadGraph } from '../../src/cli/graph-loader.js';
import { BlastRadiusCalculator } from '../../src/core/blast-radius/blast-radius-calculator.js';
import { JsonIndexReader } from '../../src/adapters/storage/json-index-reader.js';
import { DATA_EDGE_KINDS } from '../../src/core/data-coupling/data-kinds.js';
import type { FileIndex } from '../../src/core/types.js';
import { isolateGitEnv, type IsolatedGitEnv } from '../../src/cli/__tests__/git-test-env.js';
import { cleanupTempProjects, createProject, type TempProject } from '../../src/cli/__tests__/helpers/temp-project.js';

/**
 * Language parity, end to end: the same `SELECT * FROM dbo.Loans` in a TypeScript, a Java and a Go call
 * site. Without @ctxo/lang-sql no plugin emits a data edge; with it, every call site reaches the one table
 * node that lang-sql indexed from `db/Loans.sql`. Plugins are discovered from the project's package.json
 * and resolved through the CLI's own install.
 *
 * Opt-in: it runs the JDT analyzer and builds the Go analyzer, so it runs only with CTXO_PARITY_E2E=1, and
 * CI runs it in the plugin-tests job only. The Java test needs a JRE and a built analyzer JAR, the Go test
 * a Go toolchain; each skips otherwise. To run it locally after `pnpm -r build`:
 *
 *   bash:        CTXO_PARITY_E2E=1 pnpm --filter @ctxo/cli test:e2e tests/e2e/language-parity-sql.test.ts
 *   PowerShell:  $env:CTXO_PARITY_E2E = '1'; pnpm --filter @ctxo/cli test:e2e tests/e2e/language-parity-sql.test.ts
 */
const ENABLED = process.env['CTXO_PARITY_E2E'] === '1';

const here = dirname(fileURLToPath(import.meta.url));
const JAR_DIR = resolve(here, '../../../lang-java-analyzer/jar');

const HAS_GO = ENABLED && (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The JRE major version `java -version` reports, or undefined when java does not run. */
function javaMajor(): number | undefined {
  // java -version prints to stderr.
  const run = spawnSync('java', ['-version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error || run.status !== 0) return undefined;
  return parseJavaMajor(`${run.stderr}\n${run.stdout}`);
}

function parseJavaMajor(text: string): number | undefined {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return undefined;
  const first = parseInt(match[1]!, 10);
  return first === 1 && match[2] ? parseInt(match[2], 10) : first;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The analyzer JAR this JRE can run (`-17` on 17 or later, which also runs `-11`), each candidate on its own. */
function analyzerJar(): string | undefined {
  const major = javaMajor();
  if (major === undefined) return undefined;
  const variants = major >= 17 ? ['17', '11'] : ['11'];
  for (const variant of variants) {
    const jar = join(JAR_DIR, `ctxo-jdt-analyzer-${variant}.jar`);
    if (isFile(jar)) return jar;
  }
  return undefined;
}

// `java -version` succeeds and a built analyzer JAR exists.
const JDT_JAR = ENABLED ? analyzerJar() : undefined;
const CAN_RUN_JDT = JDT_JAR !== undefined;

const HOOK_TIMEOUT = 300_000;

const TS_FILE = 'src/loans.ts';
const JAVA_FILE = 'src/main/java/lending/LoanDao.java';
const GO_FILE = 'loans/repo.go';
const SQL_FILE = 'db/Loans.sql';

const TS_SYMBOL = `${TS_FILE}::activeLoans::function`;
const JAVA_SYMBOL = `${JAVA_FILE}::load::method`;
const GO_SYMBOL = `${GO_FILE}::Active::function`;
const LOANS_TABLE = `${SQL_FILE}::dbo.loans::table`;

const SOURCES: Record<string, string> = {
  [TS_FILE]: [
    "import { Pool } from 'pg';",
    '',
    'const pool = new Pool();',
    '',
    'export async function activeLoans() {',
    "  return pool.query('SELECT * FROM dbo.Loans');",
    '}',
    '',
  ].join('\n'),
  [JAVA_FILE]: [
    'package lending;',
    '',
    'public class LoanDao {',
    '    public void load(java.sql.Connection c) throws Exception {',
    '        c.prepareStatement("SELECT * FROM dbo.Loans");',
    '    }',
    '}',
    '',
  ].join('\n'),
  'go.mod': ['module parity', '', 'go 1.22', ''].join('\n'),
  [GO_FILE]: [
    'package loans',
    '',
    'import "database/sql"',
    '',
    'func Active(db *sql.DB) {',
    '\tdb.Query("SELECT * FROM dbo.Loans")',
    '}',
    '',
  ].join('\n'),
  [SQL_FILE]: ['CREATE TABLE dbo.Loans (Id INT NOT NULL)', ''].join('\n'),
};

function manifest(withSql: boolean): string {
  const devDependencies: Record<string, string> = {
    '@ctxo/lang-go': '*',
    '@ctxo/lang-java': '*',
    ...(withSql ? { '@ctxo/lang-sql': '*' } : {}),
    '@ctxo/lang-typescript': '*',
  };
  return `${JSON.stringify({ name: 'parity', private: true, devDependencies }, null, 2)}\n`;
}

function makeProject(withSql: boolean): TempProject {
  const project = createProject();
  for (const [file, content] of Object.entries(SOURCES)) project.write(file, content);
  project.write('package.json', manifest(withSql));
  project.commit('add the parity project');
  return project;
}

async function index(dir: string): Promise<void> {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await new IndexCommand(dir).run({ skipHistory: true });
  } finally {
    errorSpy.mockRestore();
  }
}

function readIndex(dir: string): FileIndex[] {
  return new JsonIndexReader(join(dir, '.ctxo')).readAll();
}

function symbolIdsOf(indices: readonly FileIndex[], file: string): string[] {
  return indices.find((entry) => entry.file === file)?.symbols.map((s) => s.symbolId) ?? [];
}

/** Every file's symbols (with annotations) and edges; `lastModified` is left out. */
function comparable(indices: readonly FileIndex[]): Record<string, { symbols: unknown; edges: unknown }> {
  const out: Record<string, { symbols: unknown; edges: unknown }> = {};
  for (const entry of indices) out[entry.file] = { symbols: entry.symbols, edges: entry.edges };
  return out;
}

describe.skipIf(!ENABLED)('SQL call sites in TypeScript, Java and Go reach the lang-sql table', () => {
  let gitEnv: IsolatedGitEnv;
  let withoutSql: TempProject;
  let withSql: TempProject;

  beforeAll(async () => {
    gitEnv = isolateGitEnv();
    if (JDT_JAR) vi.stubEnv('CTXO_JDT_ANALYZER_JAR', JDT_JAR);
    withoutSql = makeProject(false);
    withSql = makeProject(true);
    await index(withoutSql.dir);
    await index(withSql.dir);
  }, HOOK_TIMEOUT);

  afterAll(() => {
    vi.unstubAllEnvs();
    gitEnv?.restore();
    cleanupTempProjects();
  });

  // In CI the toolchains must be there: a broken setup-java or setup-go must fail the job, not skip the Java
  // and Go cases.
  it.runIf(Boolean(process.env['CI']))('the Java and Go toolchains are available in CI', () => {
    expect({ go: HAS_GO, jdt: CAN_RUN_JDT }).toEqual({ go: true, jdt: true });
  });

  it('without @ctxo/lang-sql the call-site files are indexed (positive control)', () => {
    const indices = readIndex(withoutSql.dir);
    expect(symbolIdsOf(indices, TS_FILE)).toContain(TS_SYMBOL);
    if (CAN_RUN_JDT) expect(symbolIdsOf(indices, JAVA_FILE)).toContain(JAVA_SYMBOL);
    if (HAS_GO) expect(symbolIdsOf(indices, GO_FILE)).toContain(GO_SYMBOL);
    expect(indices.some((entry) => entry.file === SQL_FILE)).toBe(false);
  });

  it('without @ctxo/lang-sql no language emits reads, writes or executes edges', () => {
    const dataEdges = readIndex(withoutSql.dir).flatMap((entry) => entry.edges.filter((e) => DATA_EDGE_KINDS.has(e.kind)));
    expect(dataEdges).toEqual([]);
  });

  it('with @ctxo/lang-sql the TypeScript call site reaches the lang-sql table node', () => {
    const { graph } = loadGraph(join(withSql.dir, '.ctxo'));
    expect(graph.getNode('dbo.loans::table')?.symbolId).toBe(LOANS_TABLE);

    const result = new BlastRadiusCalculator().calculate(graph, LOANS_TABLE);
    expect(result.impactedSymbols).toContainEqual(
      expect.objectContaining({ symbolId: TS_SYMBOL, confidence: 'confirmed' }),
    );
  });

  it.skipIf(!CAN_RUN_JDT)('the Java call site reaches the same node', () => {
    const { graph } = loadGraph(join(withSql.dir, '.ctxo'));
    const result = new BlastRadiusCalculator().calculate(graph, LOANS_TABLE);
    expect(result.impactedSymbols).toContainEqual(
      expect.objectContaining({ symbolId: JAVA_SYMBOL, confidence: 'confirmed' }),
    );
  });

  it.skipIf(!HAS_GO)('the Go call site reaches the same node', () => {
    const { graph } = loadGraph(join(withSql.dir, '.ctxo'));
    const result = new BlastRadiusCalculator().calculate(graph, LOANS_TABLE);
    expect(result.impactedSymbols).toContainEqual(
      expect.objectContaining({ symbolId: GO_SYMBOL, confidence: 'confirmed' }),
    );
  });

  it('indexing the same commit twice gives deep-equal symbols, annotations and edges for every file', async () => {
    const first = comparable(readIndex(withSql.dir));
    rmSync(join(withSql.dir, '.ctxo'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await index(withSql.dir);
    const second = comparable(readIndex(withSql.dir));

    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    expect(second).toEqual(first);
  }, HOOK_TIMEOUT);
});
