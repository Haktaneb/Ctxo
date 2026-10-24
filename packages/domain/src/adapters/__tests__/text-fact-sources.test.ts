import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleHost } from '@ctxo/cli/internal';
import type { FileIndex, SymbolNode } from '@ctxo/cli/internal';
import { createOwnership } from '../../core/ownership.js';
import { parseRegistry } from '../../core/registry.js';
import { DEFAULT_DOMAIN_CONFIG } from '../../core/domain-config.js';
import type { FactOptions } from '../../core/facts/fact-types.js';
import { SOURCE_SCAN_MAX_BYTES } from '../repo-files.js';
import { readTextFacts, textScanTargets } from '../text-fact-sources.js';

const REGISTRY = `version: 1
contexts:
  - id: billing
    name: Billing
    paths: ["src/Billing/**", "src/Shared/**"]
    rung: named
  - id: lending
    name: Lending
    paths: ["src/Lending/**", "src/Shared/**"]
    rung: named
`;

const OPTIONS: FactOptions = {
  trivialLiterals: DEFAULT_DOMAIN_CONFIG.facts.trivialLiterals,
  normalizationMethods: DEFAULT_DOMAIN_CONFIG.facts.normalizationMethods,
};

function ownership() {
  const { registry, problems } = parseRegistry(REGISTRY);
  expect(problems).toEqual([]);
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
  return createOwnership(registry!, host.services.makeGlobMatcher);
}

function index(file: string, extra: Partial<FileIndex> = {}): FileIndex {
  const symbol: SymbolNode = { symbolId: `${file}::X::class`, name: 'X', kind: 'class', startLine: 0, endLine: 5 };
  return { file, lastModified: 0, symbols: [symbol], edges: [], intent: [], antiPatterns: [], ...extra } as FileIndex;
}

const isTestFile = (path: string): boolean => /(^|\/)tests\//.test(path) || /_test\.py$/.test(path);

describe('textScanTargets', () => {
  it('targets are owned non-test files without native facts plus unindexed files with a listed extension', () => {
    const withFacts = index('src/Billing/Charge.cs', { facts: [] });
    const withoutFacts = index('src/Billing/Fee.ts');
    const lendingNoFacts = index('src/Lending/Loan.go');
    const testIndex = index('tests/Billing/FeeTests.cs');
    const shared = index('src/Shared/Money.cs');
    const unowned = index('tools/x.ts');
    const targets = textScanTargets({
      indices: [withoutFacts, withFacts, testIndex, shared, unowned, lendingNoFacts],
      tracked: [
        'src/Billing/Charge.cs',
        'src/Billing/Fee.ts',
        'src/Billing/fees.py',
        'src/Billing/fees_test.py',
        'src/Billing/notes.md',
        'src/Billing/Rates.KT',
        'src/Shared/both.py',
        'scripts/x.py',
        'src/Lending/Loan.go',
      ],
      ownership: ownership(),
      isTestFile,
      extensions: ['.py', '.kt'],
    });
    expect(targets).toEqual([
      { file: 'src/Billing/Fee.ts', symbols: withoutFacts.symbols },
      { file: 'src/Billing/Rates.KT', symbols: [] },
      { file: 'src/Billing/fees.py', symbols: [] },
      { file: 'src/Lending/Loan.go', symbols: lendingNoFacts.symbols },
    ]);
  });

  it('backslash paths are normalized and each file is a target once', () => {
    const targets = textScanTargets({
      indices: [index('src\\Billing\\Fee.ts')],
      tracked: ['src\\Billing\\Fee.ts', 'src/Billing/a.py', 'src/Billing/a.py'],
      ownership: ownership(),
      isTestFile,
      extensions: ['.py'],
    });
    expect(targets.map((t) => t.file)).toEqual(['src/Billing/Fee.ts', 'src/Billing/a.py']);
  });
});

describe('readTextFacts', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctxo-domain-text-facts-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const put = (file: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };

  it('readTextFacts skips oversized and binary files', () => {
    put('src/Billing/fees.py', 'MAX_RETRIES = 3\n');
    put('src/Billing/huge.py', `MAX_RETRIES = 3\n${'#'.repeat(SOURCE_SCAN_MAX_BYTES)}`);
    put('src/Billing/blob.py', Buffer.concat([Buffer.from('MAX_RETRIES = 3\n'), Buffer.from([0, 1, 2])]));
    put('src/Billing/plain.py', 'print("hello")\n');
    const facts = readTextFacts(root, [
      { file: 'src/Billing/huge.py', symbols: [] },
      { file: 'src/Billing/fees.py', symbols: [] },
      { file: 'src/Billing/blob.py', symbols: [] },
      { file: 'src/Billing/plain.py', symbols: [] },
      { file: 'src/Billing/missing.py', symbols: [] },
    ], OPTIONS);
    expect([...facts.keys()]).toEqual(['src/Billing/fees.py']);
    expect(facts.get('src/Billing/fees.py')).toEqual([
      {
        kind: 'retry-timeout',
        symbolId: 'src/Billing/fees.py::fees::variable',
        line: 0,
        text: 'MAX_RETRIES = 3',
        detail: { name: 'MAX_RETRIES', value: '3' },
      },
    ]);
  });

  it('a file whose facts cannot be finished is skipped and the other files keep theirs', () => {
    put('src/Billing/a.py', 'if days > 14:\n');
    put('src/Billing/b.py', 'MAX_RETRIES = 3\n');
    // A broken trivial list makes only the comparison file fail in the finisher.
    const broken = { trivialLiterals: null, normalizationMethods: [] } as unknown as FactOptions;
    const facts = readTextFacts(root, [{ file: 'src/Billing/a.py', symbols: [] }, { file: 'src/Billing/b.py', symbols: [] }], broken);
    expect([...facts.keys()]).toEqual(['src/Billing/b.py']);
  });

  it('readTextFacts passes a file whose facts cannot be finished to onError', () => {
    put('src/Billing/a.py', 'if days > 14:\n');
    put('src/Billing/b.py', 'MAX_RETRIES = 3\n');
    const broken = { trivialLiterals: null, normalizationMethods: [] } as unknown as FactOptions;
    const seen: string[] = [];
    const facts = readTextFacts(
      root,
      [{ file: 'src/Billing/a.py', symbols: [] }, { file: 'src/Billing/b.py', symbols: [] }],
      broken,
      (file, error) => seen.push(`${file}: ${(error as Error).constructor.name}`),
    );
    expect(seen).toEqual(['src/Billing/a.py: TypeError']);
    expect(facts.get('src/Billing/b.py')?.map((f) => f.text)).toEqual(['MAX_RETRIES = 3']);
  });

  it('facts attach to the target symbols', () => {
    put('src/Billing/Fee.ts', 'class X {\n  timeout = 30\n}\n');
    const symbol: SymbolNode = { symbolId: 'src/Billing/Fee.ts::X::class', name: 'X', kind: 'class', startLine: 0, endLine: 2 };
    const facts = readTextFacts(root, [{ file: 'src/Billing/Fee.ts', symbols: [symbol] }], OPTIONS);
    expect(facts.get('src/Billing/Fee.ts')?.map((f) => [f.symbolId, f.text])).toEqual([[symbol.symbolId, 'timeout = 30']]);
  });
});
