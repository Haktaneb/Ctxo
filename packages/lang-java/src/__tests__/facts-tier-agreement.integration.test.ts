import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeFact } from '@ctxo/plugin-api';
import { CAN_RUN_JDT, JDT_FIXTURE, LENDING_FIXTURE, testAnalyzerJar } from './helpers/analyzer-jar.js';
import { JavaCompositeAdapter } from '../composite-adapter.js';
import { JavaAdapter } from '../java-adapter.js';
import { DEFAULT_FACT_OPTIONS } from '../facts/fact-options.js';
import type { FactOptions } from '../facts/fact-types.js';

// Review Focus 2: on the synthetic samples the JDT tier and the tree-sitter tier give the same facts.

const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../plugin-api/conformance/fact-vectors.json');
interface Vector { readonly input: string; readonly expected: boolean }
const JAVA_VECTORS = (JSON.parse(readFileSync(VECTORS_PATH, 'utf-8')) as {
  languageSpecific: { java: { overflowsInt: Vector[]; comparisonGivesEvidence: Vector[] } };
}).languageSpecific.java;

/** Generated sources: every overflowsInt vector as a retry binding, every comparisonGivesEvidence vector as a condition, and the shapes the unit tests cover. */
function generatedSources(): Record<string, string> {
  const overflow = JAVA_VECTORS.overflowsInt
    .filter((v) => !v.input.includes('x'))
    .map((v, i) => `  double retryValue${i} = ${v.input};`);
  const comparisons = JAVA_VECTORS.comparisonGivesEvidence.map((v, i) => `  void c${i}(int x) { if (${v.input}) {} }`);
  return {
    'src/gen/Vectors.java': ['package gen;', 'class Vectors {', ...overflow, ...comparisons, '}', ''].join('\n'),
    'src/gen/Shapes.java': [
      'package gen;',
      'import java.time.Duration;',
      'import java.time.temporal.ChronoUnit;',
      'interface Limits { int RETRY_LIMIT = 4; }',
      'record Range(int a) { Range { if (a == 7) {} } }',
      'enum Tier { GOLD { void q(int x) { if (x == 8) {} } }; }',
      'class Shapes {',
      '  int first = 0, retryDelay = 250;',
      '  static final Duration POLL_DELAY = Duration.ofSeconds(30);',
      '  long cacheTtl = 24 * 60 * 60 * 1000 * 365;',
      '  long cacheTtlMs = 24L * 60 * 60 * 1000 * 365;',
      '  int timeoutMs;',
      '  Duration backoff;',
      '  { int initTimeout = 9; }',
      '  int m(int x, String s, char c, Boolean b, Object o) {',
      '    while (!(x != 2) || s == "a") {}',
      '    do {} while (c == \'z\');',
      '    for (int i = 0; i < 3; i++) {}',
      '    if (b == true && o != null && x == -4 && x == +5 && x == 2 * 3) {}',
    '    if (x == 1 == true || (x == 2) != false || s.isEmpty() == true) {}',
      '    switch (s) { case "p", "q": break; default: break; }',
      '    int w = switch (x) { case 12 -> 1; case 0xFFFFFFFF -> 2; default -> 3; };',
      '    new Object() { void z(int y) { if (y == 10) {} } };',
      '    Runnable r = () -> { if (x == 11) {} };',
      '    int retryCount = 3;',
      '    this.timeoutMs = 500;',
      '    timeoutMs += 5;',
      '    Duration.of(5, ChronoUnit.MINUTES);',
      '    Duration.ofSeconds(1, 500);',
      '    Duration.ofMillis(100000 * 100000);',
      '    backoff = (Duration.ofHours(2));',
      '    String t = s.trim().toUpperCase() + s.trimStart() + this.<String>id(s.toLowerCase());',
      '    if (s == """',
      '        """) return 1;',
      '    if (s == """',
      '        gold""") return 2;',
      '    return w;',
      '  }',
      '  <T> T id(T v) { return v; }',
      '}',
      '',
    ].join('\n'),
  };
}

function javaFiles(dir: string): string[] {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.java') ? [p] : [];
  });
  return walk(dir).map((p) => relative(dir, p).split('\\').join('/')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The default options, and none trivial (so comparisons with trivial literals are compared too). */
const OPTION_SETS: [string, FactOptions][] = [
  ['default', DEFAULT_FACT_OPTIONS],
  ['strict', { trivialLiterals: [], normalizationMethods: DEFAULT_FACT_OPTIONS.normalizationMethods }],
];

/** Facts mapped to `{ kind, line, text, detail, symbolId }` and sorted. */
function shape(facts: readonly CodeFact[]): string[] {
  return facts
    .map((f) => JSON.stringify({ kind: f.kind, line: f.line, text: f.text, detail: f.detail, symbolId: f.symbolId }))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe.skipIf(!CAN_RUN_JDT)('Java fact tier agreement (JDT full tier vs tree-sitter syntax tier)', () => {
  const generated = mkdtempSync(join(tmpdir(), 'ctxo-java-facts-'));
  const roots: [string, string][] = [['lending', LENDING_FIXTURE], ['fixture', JDT_FIXTURE], ['generated', generated]];
  const full = new Map<string, JavaCompositeAdapter>();

  beforeAll(async () => {
    for (const [file, source] of Object.entries(generatedSources())) {
      mkdirSync(join(generated, file, '..'), { recursive: true });
      writeFileSync(join(generated, file), source);
    }
    vi.stubEnv('CTXO_JDT_ANALYZER_JAR', testAnalyzerJar()!);
    for (const [optionsName, options] of OPTION_SETS) {
      for (const [name, dir] of roots) {
        const adapter = new JavaCompositeAdapter({ facts: options });
        await adapter.initialize(dir);
        full.set(`${optionsName}:${name}`, adapter);
      }
    }
  }, 300_000);

  afterAll(async () => {
    for (const adapter of full.values()) await adapter.dispose();
    vi.unstubAllEnvs();
    rmSync(generated, { recursive: true, force: true });
  });

  it('both tiers give the same facts', async () => {
    let total = 0;
    for (const [optionsName, options] of OPTION_SETS) {
      for (const [name, dir] of roots) {
        const jdt = full.get(`${optionsName}:${name}`)!;
        expect(jdt.getTier()).toBe('full');
        for (const file of javaFiles(dir)) {
          const source = readFileSync(join(dir, file), 'utf-8');
          const syntax = new JavaAdapter({ facts: options });
          const expected = shape(await jdt.extractFacts(file, source));
          total += expected.length;
          expect(shape(await syntax.extractFacts(file, source)), `${optionsName} ${name}/${file}`).toEqual(expected);
        }
      }
    }
    // A positive control: the samples do give facts.
    expect(total).toBeGreaterThan(30);
  }, 300_000);
});
