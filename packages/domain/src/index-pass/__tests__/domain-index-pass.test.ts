import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModuleHost, type CoChangeWindowCommits, type FileIndex, type IndexPassContext } from '@ctxo/cli/internal';
import { domainIndexPass } from '../domain-index-pass.js';

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending.md
    paths: ["src/Lending/**", "domain/**"]
    rung: bounded
    contracts:
      billing: ["src/Billing/Api/**"]
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: named
unowned:
  allow: ["src/Host/Allowed.ts"]
`;

function fileIndex(file: string, symbols: string[], edges: [string, string, string][] = []): FileIndex {
  return {
    file,
    lastModified: 1_700_000_000,
    symbols: symbols.map((name, i) => ({ symbolId: `${file}::${name}::class`, name, kind: 'class', startLine: i, endLine: i + 1 })),
    edges: edges.map(([from, to, kind]) => ({ from, to, kind })) as FileIndex['edges'],
    intent: [],
    antiPatterns: [],
  };
}

const LOAN = 'src/Lending/Loan.ts::Loan::class';
const INVOICE = 'src/Billing/Invoice.ts::Invoice::class';
const CHARGES = 'src/Billing/Api/Charges.ts::Charges::class';
const ORDER = 'domain/Order.ts::Order::class';

const INDICES: FileIndex[] = [
  fileIndex('src/Lending/Loan.ts', ['Loan'], [
    [LOAN, INVOICE, 'calls'],
    [LOAN, CHARGES, 'imports'],
    [LOAN, ORDER, 'uses'],
    [LOAN, 'Missing::class', 'extends'],
  ]),
  fileIndex('domain/Order.ts', ['Order']),
  fileIndex('src/Billing/Invoice.ts', ['Invoice'], [[INVOICE, LOAN, 'calls']]),
  fileIndex('src/Billing/Api/Charges.ts', ['Charges']),
  fileIndex('src/Lending/Loan.test.ts', ['LoanTests'], [['src/Lending/Loan.test.ts::LoanTests::class', INVOICE, 'calls']]),
  fileIndex('src/Host/Program.ts', ['Program'], [['src/Host/Program.ts::Program::class', LOAN, 'calls']]),
  fileIndex('src/Host/Allowed.ts', ['Allowed']),
];

const HISTORY: CoChangeWindowCommits = {
  head: 'abc1234def',
  headCommittedAt: 1_700_000_500,
  commits: [
    {
      hash: 'abc1234def0000000000000000000000000000000',
      message: 'move fee',
      date: '2026-03-03T10:00:00Z',
      author: 'a',
      committedAt: 1_700_000_500,
      changes: [{ status: 'R', oldPath: 'src/Billing/Fee.ts', path: 'src/Lending/Fee.ts' }],
    },
  ],
};

let root: string;
let ctxoRoot: string;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxo-domain-pass-'));
  ctxoRoot = join(root, '.ctxo');
  for (const index of INDICES) {
    const target = join(ctxoRoot, 'index', `${index.file}.json`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(index, null, 2), 'utf-8');
  }
  writeRegistry(REGISTRY);
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function writeRegistry(text: string): void {
  mkdirSync(join(root, 'docs', 'domain'), { recursive: true });
  writeFileSync(join(root, 'docs', 'domain', 'contexts.yaml'), text, 'utf-8');
}

async function runPass(history?: CoChangeWindowCommits): Promise<void> {
  const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root });
  const { services } = host;
  // Read the index the way the CLI does, so the artifacts from an earlier run must be skipped.
  const indices = services.readIndex(ctxoRoot);
  const config = services.loadConfig(ctxoRoot).config;
  const ctx: IndexPassContext = {
    projectRoot: root,
    ctxoRoot,
    config,
    indices,
    graph: () => services.buildGraph(indices),
    isTestFile: services.createTestFileCheck(config, indices),
    ...(history !== undefined ? { history } : {}),
  };
  await domainIndexPass(host)(ctx);
}

const domainDir = (): string => join(ctxoRoot, 'index', 'domain');
const read = (name: string): string => readFileSync(join(domainDir(), name), 'utf-8');

describe('domainIndexPass', () => {
  it('writes contexts.json and boundaries.json, byte-identical on a second run', async () => {
    await runPass(HISTORY);
    const contexts = read('contexts.json');
    const boundaries = read('boundaries.json');

    const parsedContexts = JSON.parse(contexts);
    expect(parsedContexts.ctxoArtifact).toBe('domain-contexts');
    expect(parsedContexts.contexts).toEqual([
      {
        id: 'lending',
        name: 'Lending',
        rung: 'bounded',
        card: 'docs/domain/lending.md',
        fileCount: 3,
        files: ['domain/Order.ts', 'src/Lending/Loan.test.ts', 'src/Lending/Loan.ts'],
      },
      { id: 'billing', name: 'Billing', rung: 'named', fileCount: 2, files: ['src/Billing/Api/Charges.ts', 'src/Billing/Invoice.ts'] },
    ]);
    expect(parsedContexts.unowned).toEqual({ count: 1, files: ['src/Host/Program.ts'] });
    expect(parsedContexts.multiplyOwned).toEqual([]);
    expect(parsedContexts.movedFiles).toEqual([
      {
        file: 'src/Lending/Fee.ts',
        from: 'src/Billing/Fee.ts',
        fromContext: 'billing',
        toContext: 'lending',
        commit: HISTORY.commits[0]!.hash,
        date: '2026-03-03T10:00:00Z',
      },
    ]);

    const parsedBoundaries = JSON.parse(boundaries);
    expect(parsedBoundaries).toMatchObject({ ctxoArtifact: 'domain-boundaries', mode: 'by-rung', blockingRungs: ['bounded', 'boring'] });
    expect(parsedBoundaries.registryHash).toBe(parsedContexts.registryHash);
    expect(parsedBoundaries.crossEdges).toEqual([
      { from: 'billing', to: 'lending', byKind: { calls: 1 }, allowed: 0, violations: 1 },
      { from: 'lending', to: 'billing', byKind: { calls: 1, imports: 1 }, allowed: 1, violations: 1 },
    ]);
    expect(parsedBoundaries.violations.map((v: { from: { symbolId: string }; severity: string }) => [v.from.symbolId, v.severity])).toEqual([
      [INVOICE, 'error'],
      [LOAN, 'error'],
    ]);

    const historyFiles = readdirSync(join(domainDir(), 'history'));
    expect(historyFiles).toEqual(['1700000500-abc1234.json']);
    const entry = JSON.parse(read(join('history', historyFiles[0]!)));
    expect(entry.contexts).toEqual([
      { id: 'billing', files: 2, internalEdges: 0, crossOut: 1, crossIn: 2, crossShare: 1 },
      { id: 'lending', files: 2, internalEdges: 1, crossOut: 2, crossIn: 1, crossShare: 0.667 },
    ]);

    expect(logs.some((l) => /Domain: 2 contexts, 3 cross-context edges, 2 boundary violations \(\d+ ms\)/.test(l))).toBe(true);

    await runPass(HISTORY);
    expect(read('contexts.json')).toBe(contexts);
    expect(read('boundaries.json')).toBe(boundaries);
    expect(readdirSync(join(domainDir(), 'history'))).toEqual(['1700000500-abc1234.json']);
    // The source folder named domain/ is still indexed beside the artifacts.
    expect(createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root }).services.readIndex(ctxoRoot).map((i) => i.file)).toContain(
      'domain/Order.ts',
    );
  });

  it('keeps movedFiles when the change log is unavailable', async () => {
    await runPass(HISTORY);
    const before = JSON.parse(read('contexts.json')).movedFiles;
    expect(before).toHaveLength(1);

    await runPass(undefined);

    expect(JSON.parse(read('contexts.json')).movedFiles).toEqual(before);
    // No change log, no new history entry.
    expect(readdirSync(join(domainDir(), 'history'))).toEqual(['1700000500-abc1234.json']);
  });

  it('removes the artifacts when the registry is gone', async () => {
    await runPass(HISTORY);
    expect(existsSync(join(domainDir(), 'contexts.json'))).toBe(true);

    rmSync(join(root, 'docs', 'domain', 'contexts.yaml'));
    await runPass(HISTORY);

    expect(existsSync(join(domainDir(), 'contexts.json'))).toBe(false);
    expect(existsSync(join(domainDir(), 'boundaries.json'))).toBe(false);
    expect(existsSync(join(domainDir(), 'history'))).toBe(false);
    expect(existsSync(join(domainDir(), 'Order.ts.json'))).toBe(true);
  });

  it('writes nothing when the registry has problems', async () => {
    writeRegistry(REGISTRY.replace('rung: named', 'rung: unknown'));
    await runPass(HISTORY);
    expect(existsSync(join(domainDir(), 'contexts.json'))).toBe(false);
    expect(existsSync(join(domainDir(), 'history'))).toBe(false);
    expect(logs.some((l) => l.includes('WARN') && l.includes('registry'))).toBe(true);

    // Artifacts from an earlier good run are left as they are.
    writeRegistry(REGISTRY);
    await runPass(HISTORY);
    const contexts = read('contexts.json');
    writeRegistry('version: 1\ncontexts: [');
    await runPass(HISTORY);
    expect(read('contexts.json')).toBe(contexts);
  });
});
