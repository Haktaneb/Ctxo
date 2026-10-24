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

/** Every repo path the composition reads, once per read (cards and the glossary, test, production and scan texts). */
const reads: string[] = [];

vi.mock('../repo-files.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../repo-files.js')>();
  return {
    ...original,
    readCardText: (...args: Parameters<typeof original.readCardText>) => {
      reads.push(args[1]);
      return original.readCardText(...args);
    },
    readRepoTexts: (...args: Parameters<typeof original.readRepoTexts>) => {
      reads.push(...new Set(args[1]));
      return original.readRepoTexts(...args);
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
/** Tracked, not indexed, with a listed extension: a text-scan target only. */
const PY = 'src/Lending/fees.py';

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
  write(TEXT, 'class DueDates\n{\n    bool Late(int days)\n    {\n        if (days > 14) return true; // rule: LEND-99\n        return false;\n    }\n}\n');
  write(TESTS, 'class DueDateTests\n{\n    // rule: LEND-88\n    [Fact]\n    public void LateAfterTwoWeeks() { }\n}\n');
  write(PY, 'def late(days):\n    if days > 30:\n        return True\n    return False\n');
  failingFile = undefined;
  reads.length = 0;
});

/** A host whose git lists every file of the fixture as tracked, the unindexed `fees.py` included. */
function trackedHost(): CtxoHost {
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
  const tracked = ['docs/domain/contexts.yaml', 'docs/domain/lending/domain.md', NATIVE, PY, TEXT, TESTS];
  return { ...host, services: { ...host.services, createGit: () => ({ listTrackedFiles: async () => tracked }) as never } };
}

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

  it('returns the parsed cards and the rule references verify-domain needs (W10)', async () => {
    const host = trackedHost();
    const inputs = await composeLoopInputs(host, request(host, []));

    expect(inputs.cards.map((c) => [c.context.id, c.path, c.card?.rules.map((r) => r.id)])).toEqual([
      ['lending', 'docs/domain/lending/domain.md', ['LEND-01']],
    ]);
    expect([...inputs.parsedCards.keys()]).toEqual(['docs/domain/lending/domain.md']);
    expect(inputs.parsedCards.get('docs/domain/lending/domain.md')).toBe(inputs.cards[0]!.card);
    expect(inputs.testRefs.links.size).toBe(0);
    expect(inputs.testRefs.unknown.map((r) => [r.file, r.id, r.kind])).toEqual([[TESTS, 'LEND-88', 'rule-comment']]);
    expect(inputs.codeRefs.links.size).toBe(0);
    expect(inputs.codeRefs.unknown.map((r) => [r.file, r.id, r.kind])).toEqual([[TEXT, 'LEND-99', 'rule-comment']]);
  });

  it('reads each card, test file and production file once per call', async () => {
    const host = trackedHost();
    const inputs = await composeLoopInputs(host, request(host, []));
    // The unindexed fees.py and the facts-less DueDates.cs are scanned; Renewal.cs keeps its native facts.
    expect([...inputs.candidates!.textFacts.keys()]).toEqual([TEXT, PY]);

    const counts = new Map<string, number>();
    for (const path of reads) counts.set(path, (counts.get(path) ?? 0) + 1);
    expect([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      ['docs/domain/glossary.md', 1],
      ['docs/domain/lending/domain.md', 1],
      [TEXT, 1],
      [NATIVE, 1],
      [PY, 1],
      [TESTS, 1],
    ]);
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
