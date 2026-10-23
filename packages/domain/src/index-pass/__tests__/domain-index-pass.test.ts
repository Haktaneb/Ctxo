import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModuleHost, type CoChangeWindowCommits, type CtxoHost, type FileIndex, type IndexPassContext } from '@ctxo/cli/internal';
import type { DomainGraph } from '../../core/domain-graph.js';
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

async function runPass(history?: CoChangeWindowCommits, wrap: (host: CtxoHost) => CtxoHost = (h) => h): Promise<void> {
  const host = wrap(createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root }));
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

    expect(
      logs.some((l) => /Domain: 2 contexts, 0 rules \(0 without tests\), 0 links, 3 cross-context edges, 2 boundary violations \(\d+ ms\)/.test(l)),
    ).toBe(true);

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

  it('a graph build failure logs a warning and still writes contexts.json and boundaries.json', async () => {
    const failing = (host: CtxoHost): CtxoHost => {
      const services = { ...host.services };
      Object.defineProperty(services, 'dataResourceKinds', {
        get() {
          throw new Error('boom');
        },
      });
      return { ...host, services };
    };
    await runPass(HISTORY, failing);

    expect(JSON.parse(read('contexts.json')).ctxoArtifact).toBe('domain-contexts');
    expect(JSON.parse(read('boundaries.json')).ctxoArtifact).toBe('domain-boundaries');
    expect(existsSync(join(domainDir(), 'graph.json'))).toBe(false);
    expect(readdirSync(join(domainDir(), 'history'))).toEqual(['1700000500-abc1234.json']);
    expect(logs.some((l) => l.includes('The domain graph could not be built: boom; graph.json not updated'))).toBe(true);
    expect(logs.some((l) => l.includes('may serve the previous graph (or report a stale registry if it changed)'))).toBe(true);
    expect(logs.some((l) => /Domain: 2 contexts, 3 cross-context edges, 2 boundary violations \(\d+ ms\)/.test(l))).toBe(true);

    // A later successful run writes graph.json; a failing run after it leaves that file as it was.
    await runPass(HISTORY);
    const graph = read('graph.json');
    await runPass(HISTORY, failing);
    expect(read('graph.json')).toBe(graph);
  });

  it('removes the artifacts when the registry is gone', async () => {
    await runPass(HISTORY);
    expect(existsSync(join(domainDir(), 'contexts.json'))).toBe(true);

    rmSync(join(root, 'docs', 'domain', 'contexts.yaml'));
    await runPass(HISTORY);

    expect(existsSync(join(domainDir(), 'contexts.json'))).toBe(false);
    expect(existsSync(join(domainDir(), 'boundaries.json'))).toBe(false);
    expect(existsSync(join(domainDir(), 'graph.json'))).toBe(false);
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

describe('domainIndexPass graph.json', () => {
  const GRAPH_REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    card: docs/domain/lending/domain.md
    paths: ["src/Lending/**", "tests/Lending.Tests/**"]
    rung: bounded
    rulePrefix: LEND
  - id: billing
    name: Billing
    card: docs/domain/billing/domain.md
    paths: ["src/Billing/**"]
    rung: named
`;

  const CARD = [
    '# Lending',
    '',
    '## Language',
    '- **Loan**: a book lent to a member',
    '- **Hold**: a reserved copy',
    '',
    '## Rules and invariants',
    '### LEND-03 A member holds at most five loans',
    'Tests: `tests/Lending.Tests/LoanLimitTests.cs`',
    'Code: `src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method`',
    '',
    'Free text written by people.',
    '',
    '### LEND-04 A hold expires after seven days',
    'Untested: covered by manual QA until the scheduler migration lands',
    '',
    '## Boundary contracts',
    'Free text; references to contract files.',
    '',
    '## Decisions',
    '- 2026-09-12: Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123',
    '',
    '## Open questions',
    '- Should holds count towards the limit?',
    '',
  ].join('\n');

  const POLICY = 'src/Lending/LoanPolicy.cs';
  const TESTS = 'tests/Lending.Tests/LoanLimitTests.cs';
  const TEST_METHOD = `${TESTS}::LoanLimitTests.MemberHoldsAtMostFiveLoans::method`;

  const GRAPH_INDICES: FileIndex[] = [
    {
      file: POLICY,
      lastModified: 1_700_000_000,
      symbols: [
        { symbolId: `${POLICY}::LoanPolicy::class`, name: 'LoanPolicy', kind: 'class', startLine: 2, endLine: 20 },
        { symbolId: `${POLICY}::LoanPolicy.CanBorrow::method`, name: 'LoanPolicy.CanBorrow', kind: 'method', startLine: 5, endLine: 9 },
      ],
      edges: [],
      intent: [],
      antiPatterns: [],
    },
    {
      file: TESTS,
      lastModified: 1_700_000_000,
      symbols: [
        { symbolId: `${TESTS}::LoanLimitTests::class`, name: 'LoanLimitTests', kind: 'class', startLine: 2, endLine: 14 },
        {
          symbolId: TEST_METHOD,
          name: 'LoanLimitTests.MemberHoldsAtMostFiveLoans',
          kind: 'method',
          startLine: 4,
          endLine: 10,
          annotations: [{ name: 'Fact' }, { name: 'Trait', args: ['Rule', 'LEND-03'] }],
        },
      ],
      edges: [],
      intent: [],
      antiPatterns: [],
    },
  ];

  function writeRepo(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf-8');
  }

  beforeEach(() => {
    rmSync(ctxoRoot, { recursive: true, force: true });
    for (const index of GRAPH_INDICES) {
      const target = join(ctxoRoot, 'index', `${index.file}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(index, null, 2), 'utf-8');
    }
    writeRegistry(GRAPH_REGISTRY);
    writeRepo('docs/domain/lending/domain.md', CARD);
    writeRepo('docs/domain/glossary.md', '- **Member**: a registered patron\n');
    writeRepo('docs/specs/loan-limit.md', '# Loan limit\n');
    writeRepo(POLICY, 'namespace Lending;\n\npublic class LoanPolicy\n{\n    // rule: LEND-03\n    public bool CanBorrow(int loans) => loans < 5;\n}\n');
    writeRepo(
      TESTS,
      'namespace Lending.Tests;\n\npublic class LoanLimitTests\n{\n    [Fact]\n    [Trait("Rule", "LEND-03")]\n    public void MemberHoldsAtMostFiveLoans() { }\n}\n',
    );
  });

  const graphFile = (): string => join(domainDir(), 'graph.json');

  it('writes graph.json with nodes and links, byte-identical on a second run', async () => {
    await runPass();
    const text = read('graph.json');
    const graph = JSON.parse(text) as DomainGraph;

    expect(graph).toMatchObject({ ctxoArtifact: 'domain-graph', version: 1 });
    expect(graph.registryHash).toBe(JSON.parse(read('contexts.json')).registryHash);
    expect(graph.cardsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(graph.contexts.map((c) => c.id)).toEqual(['context:billing', 'context:lending']);
    expect(graph.rules.map((r) => r.id)).toEqual(['rule:LEND-03', 'rule:LEND-04']);
    expect(graph.terms.map((t) => [t.id, t.identifierCount])).toEqual([
      ['term:*/member', 0],
      ['term:lending/hold', 0],
      ['term:lending/loan', 1],
    ]);

    const fromRule = graph.links.filter((l) => l.from === 'rule:LEND-03');
    expect(fromRule).toContainEqual({
      kind: 'rule-test',
      from: 'rule:LEND-03',
      to: { file: TESTS, symbolId: TEST_METHOD },
      source: 'annotation',
      at: { file: TESTS, line: 5 },
      annotation: 'Trait',
      testName: 'LoanLimitTests.MemberHoldsAtMostFiveLoans',
    });
    expect(fromRule.some((l) => l.kind === 'rule-test' && l.source === 'card-tests' && l.to.file === TESTS)).toBe(true);
    expect(fromRule).toContainEqual({
      kind: 'rule-symbol',
      from: 'rule:LEND-03',
      to: { file: POLICY, symbolId: `${POLICY}::LoanPolicy.CanBorrow::method` },
      source: 'card-code',
      at: { file: 'docs/domain/lending/domain.md', line: 10 },
    });
    expect(fromRule.some((l) => l.kind === 'rule-symbol' && l.source === 'rule-comment')).toBe(true);

    const provenance = graph.links.flatMap((l) => (l.kind === 'decision-provenance' ? [l.to] : []));
    expect(provenance).toEqual([
      { kind: 'external', value: '#123' },
      { kind: 'file', path: 'docs/specs/loan-limit.md', exists: true },
    ]);
    expect(graph.unresolved).toEqual([]);

    const before = statSync(graphFile()).mtimeMs;
    await runPass();
    expect(read('graph.json')).toBe(text);
    expect(statSync(graphFile()).mtimeMs).toBe(before);

    // A card edit changes the hash and the file.
    writeRepo('docs/domain/lending/domain.md', CARD.replace('Free text written by people.', 'Edited.'));
    await runPass();
    expect(JSON.parse(read('graph.json')).cardsHash).not.toBe(graph.cardsHash);
  });

  it('the JSON index reader skips graph.json', async () => {
    const services = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root }).services;
    const before = services.readIndex(ctxoRoot).length;
    await runPass();
    expect(existsSync(graphFile())).toBe(true);
    expect(services.readIndex(ctxoRoot)).toHaveLength(before);
  });

  it('removes graph.json when the registry is gone', async () => {
    await runPass();
    expect(existsSync(graphFile())).toBe(true);
    rmSync(join(root, 'docs', 'domain', 'contexts.yaml'));
    await runPass();
    expect(existsSync(graphFile())).toBe(false);
  });

  it('writes nothing when the registry has problems', async () => {
    writeRegistry(GRAPH_REGISTRY.replace('rung: named', 'rung: unknown'));
    await runPass();
    expect(existsSync(graphFile())).toBe(false);

    writeRegistry(GRAPH_REGISTRY);
    await runPass();
    const text = read('graph.json');
    writeRegistry('version: 1\ncontexts: [');
    writeRepo('docs/domain/lending/domain.md', '# Lending\n');
    await runPass();
    expect(read('graph.json')).toBe(text);
  });

  it('a missing card gives a context without rules', async () => {
    rmSync(join(root, 'docs', 'domain', 'lending', 'domain.md'));
    await runPass();
    const graph = JSON.parse(read('graph.json')) as DomainGraph;
    expect(graph.contexts.find((c) => c.id === 'context:lending')).toMatchObject({ card: 'docs/domain/lending/domain.md' });
    expect(graph.rules).toEqual([]);
    expect(graph.decisions).toEqual([]);
    // The rule-free scan still writes the glossary term.
    expect(graph.terms.map((t) => t.id)).toEqual(['term:*/member']);
  });

  it('never fetches external provenance', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no network')));
    writeRepo(
      'docs/domain/lending/domain.md',
      CARD.replace('#123', '#123, https://example.com/adr, [wiki](https://wiki.example.com/loans)'),
    );
    await runPass();
    const graph = JSON.parse(read('graph.json')) as DomainGraph;
    expect(graph.links.filter((l) => l.kind === 'decision-provenance' && l.to.kind === 'external')).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs rules, links and the time', async () => {
    await runPass();
    const graph = JSON.parse(read('graph.json')) as DomainGraph;
    const line = logs.find((l) => l.includes('Domain: '));
    expect(line).toBeDefined();
    expect(line).toContain('rules (');
    expect(line).toMatch(
      new RegExp(`Domain: 2 contexts, 2 rules \\(1 without tests\\), ${graph.links.length} links, 0 cross-context edges, 0 boundary violations \\(\\d+ ms\\)`),
    );
  });
});
