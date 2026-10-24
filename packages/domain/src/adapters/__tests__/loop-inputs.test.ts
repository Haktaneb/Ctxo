import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModuleHost, type CodeFact, type CtxoHost, type FileIndex } from '@ctxo/cli/internal';
import { DEFAULT_DOMAIN_CONFIG } from '../../core/domain-config.js';
import { createOwnership } from '../../core/ownership.js';
import { registryHash } from '../../core/registry.js';
import { composeLoopInputs, effectiveFacts, type LoopInputsRequest } from '../loop-inputs.js';
import { readRegistry } from '../registry-reader.js';

/** When set, the text scan of this file reports an error through `onError` and gives no facts. */
let failingFile: string | undefined;

vi.mock('../../core/text-facts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/text-facts.js')>();
  return {
    ...original,
    scanTextFacts: (...args: Parameters<typeof original.scanTextFacts>) => {
      const [file, , , , onError] = args;
      if (file === failingFile) {
        onError?.(file, new Error('lexer tripped'));
        return [];
      }
      return original.scanTextFacts(...args);
    },
  };
});

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending/domain.md
    paths: ["src/Lending/**", "tests/Lending.Tests/**"]
    rung: bounded
    rulePrefix: LEND
`;

const CARD = ['# Lending', '', '## Rules and invariants', '### LEND-01 A loan lasts three weeks', 'Untested: manual QA', ''].join('\n');

const NATIVE = 'src/Lending/Renewal.cs';
const TEXT = 'src/Lending/DueDates.cs';
const TESTS = 'tests/Lending.Tests/DueDateTests.cs';

const index = (file: string, name: string, facts?: CodeFact[]): FileIndex => ({
  file,
  lastModified: 1_700_000_000,
  symbols: [{ symbolId: `${file}::${name}::class`, name, kind: 'class', startLine: 0, endLine: 20 }],
  edges: [],
  intent: [],
  antiPatterns: [],
  ...(facts === undefined ? {} : { facts }),
});

const INDICES: FileIndex[] = [
  index(NATIVE, 'Renewal', [{ kind: 'literal-comparison', symbolId: `${NATIVE}::Renewal::class`, line: 3, text: 'renewals > 2' }]),
  index(TEXT, 'DueDates'),
  index(TESTS, 'DueDateTests'),
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-loop-'));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf-8');
  };
  write('docs/domain/contexts.yaml', REGISTRY);
  write('docs/domain/lending/domain.md', CARD);
  write(NATIVE, 'class Renewal\n{\n    bool Ok(int renewals)\n    {\n        if (renewals > 2) return false;\n        return true;\n    }\n}\n');
  write(TEXT, 'class DueDates\n{\n    bool Late(int days)\n    {\n        if (days > 14) return true;\n        return false;\n    }\n}\n');
  write(TESTS, 'class DueDateTests\n{\n    [Fact]\n    public void LateAfterTwoWeeks() { }\n}\n');
  failingFile = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function request(host: CtxoHost, warnings: string[]): LoopInputsRequest {
  const loaded = readRegistry(root, 'docs/domain/contexts.yaml')!;
  const registry = loaded.registry!;
  const isTests = (file: string): boolean => file.startsWith('tests/');
  return {
    projectRoot: root,
    indices: INDICES,
    isTestFile: isTests,
    registry,
    registryHash: registryHash(loaded.text),
    config: DEFAULT_DOMAIN_CONFIG,
    ownership: createOwnership(registry, host.services.makeGlobMatcher),
    files: INDICES.map((i) => i.file).sort(),
    warn: (message) => warnings.push(message),
  };
}

describe('composeLoopInputs', () => {
  it('returns the graph, the test texts and the candidates of one composition (W10)', async () => {
    const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
    const warnings: string[] = [];
    const inputs = await composeLoopInputs(host, request(host, warnings));

    expect(inputs.graph.rules.map((r) => r.id)).toEqual(['rule:LEND-01']);
    expect(inputs.testTexts.map((t) => t.file)).toEqual([TESTS]);
    expect(inputs.candidates?.candidates.map((c) => [c.kind, c.file, c.source, c.resolution?.by ?? null])).toEqual([
      ['rule-without-tests', 'docs/domain/lending/domain.md', 'card', 'untested'],
      ['literal-comparison', TEXT, 'text', null],
      ['literal-comparison', NATIVE, 'native', null],
    ]);
    // The text scan reads only the file without a facts key; the effective map holds both.
    expect([...inputs.candidates!.textFacts.keys()]).toEqual([TEXT]);
    expect([...inputs.candidates!.facts.keys()].sort()).toEqual([TEXT, NATIVE].sort());
    expect(warnings).toEqual([]);
  });

  it('a text scan error is a warning and that file gives no facts', async () => {
    failingFile = TEXT;
    const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
    const warnings: string[] = [];
    const inputs = await composeLoopInputs(host, request(host, warnings));

    expect(warnings).toEqual([`The text scan of ${TEXT} failed: lexer tripped; the file gives no facts.`]);
    expect(inputs.candidates?.textFacts.size).toBe(0);
    expect(inputs.candidates?.candidates.some((c) => c.file === TEXT)).toBe(false);
  });

  it('a graph failure throws; a candidate failure keeps the graph and drops only the candidates', async () => {
    const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
    const services = { ...host.services };
    Object.defineProperty(services, 'dataResourceKinds', {
      get() {
        throw new Error('boom');
      },
    });
    await expect(composeLoopInputs({ ...host, services }, request(host, []))).rejects.toThrow('boom');

    const warnings: string[] = [];
    const req = request(host, warnings);
    const facts = {
      ...DEFAULT_DOMAIN_CONFIG.facts,
      get textScanExtensions(): readonly string[] {
        throw new Error('extensions unreadable');
      },
    };
    const inputs = await composeLoopInputs(host, { ...req, config: { ...DEFAULT_DOMAIN_CONFIG, facts } });
    expect(inputs.graph.rules.map((r) => r.id)).toEqual(['rule:LEND-01']);
    expect(inputs.testTexts.map((t) => t.file)).toEqual([TESTS]);
    expect(inputs.candidates).toBeUndefined();
    expect(warnings).toEqual(['The shadow-spec candidates could not be built: extensions unreadable.']);
  });
});

describe('effectiveFacts', () => {
  it('native facts win, facts: [] keeps a file out, text facts fill files without a facts key', () => {
    const native: CodeFact = { kind: 'endpoint', symbolId: 'a.cs::A::class', line: 1, text: 'GET /a' };
    const text: CodeFact = { kind: 'literal-comparison', symbolId: 'b.py::b::variable', line: 2, text: 'x > 3' };
    const facts = effectiveFacts(
      [index('a.cs', 'A', [native]), index('c.cs', 'C', []), index('b.py', 'b')],
      new Map([
        ['a.cs', [text]],
        ['c.cs', [text]],
        ['b.py', [text]],
        ['d.kt', [text]],
      ]),
    );
    expect([...facts]).toEqual([
      ['a.cs', [native]],
      ['b.py', [text]],
      ['d.kt', [text]],
    ]);
  });
});
