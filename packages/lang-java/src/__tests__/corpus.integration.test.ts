import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAN_RUN_JDT, LENDING_FIXTURE, testAnalyzerJar } from './helpers/analyzer-jar.js';
import { JavaCompositeAdapter } from '../composite-adapter.js';

// The corpus lives with the rules in @ctxo/sql-extract; this side runs the cases written in Java.
const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sql-extract', 'corpus');

interface AccessLists { reads: string[]; writes: string[]; executes: string[] }
interface CorpusCase { name: string; mode: string; accesses: AccessLists }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The cases whose mode is `java` (their source is `<case>.java.fixture`). */
function javaCases(): CorpusCase[] {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.expected.json'))
    .sort(cmp)
    .map((f) => ({
      ...(JSON.parse(readFileSync(join(corpusDir, f), 'utf8')) as Omit<CorpusCase, 'name'>),
      name: f.slice(0, -'.expected.json'.length),
    }))
    .filter((c) => c.mode === 'java');
}

/** `java-spring-jpa-mybatis` becomes `JavaSpringJpaMybatis`, the public class of the case. */
const className = (name: string): string =>
  name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');

const cases = javaCases();
const fileOf = (c: CorpusCase): string => `src/main/java/corpus/${className(c.name)}.java`;

describe('Java corpus cases', () => {
  it('finds the Java cases', () => {
    expect(cases.map((c) => c.name)).toEqual(['java-constants', 'java-jdbc', 'java-spring-jpa-mybatis']);
  });
});

describe.skipIf(!CAN_RUN_JDT)('Java corpus cases (JDT full tier, real jar)', () => {
  let root = '';
  const composite = new JavaCompositeAdapter({ sqlCallSites: true });

  beforeAll(async () => {
    // One project holds every case plus the lending stubs, so the analyzer runs once.
    root = mkdtempSync(join(tmpdir(), 'ctxo-java-corpus-'));
    cpSync(join(LENDING_FIXTURE, 'src', 'stubs'), join(root, 'src', 'stubs'), { recursive: true });
    mkdirSync(join(root, 'src', 'main', 'java', 'corpus'), { recursive: true });
    for (const c of cases) {
      writeFileSync(join(root, fileOf(c)), readFileSync(join(corpusDir, `${c.name}.java.fixture`), 'utf8'));
    }
    vi.stubEnv('CTXO_JDT_ANALYZER_JAR', testAnalyzerJar()!);
    await composite.initialize(root);
  }, 130_000);

  afterAll(async () => {
    await composite.dispose();
    vi.unstubAllEnvs();
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
  }, 130_000);
});
