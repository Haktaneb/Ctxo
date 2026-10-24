import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

async function runPass(
  history?: CoChangeWindowCommits,
  wrap: (host: CtxoHost) => CtxoHost = (h) => h,
  wrapCtx: (ctx: IndexPassContext) => IndexPassContext = (c) => c,
): Promise<void> {
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
  await domainIndexPass(host)(wrapCtx(ctx));
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
      logs.some((l) =>
        /Domain: 2 contexts, 0 rules \(0 without tests\), 0 links, 0 shadow-spec candidates \(0 resolved by links or Untested\), 3 cross-context edges, 2 boundary violations \(\d+ ms\)/.test(
          l,
        ),
      ),
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

  it('does not read a card symlinked outside the repository, and keeps its text out of graph.json (I2)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ctxo-domain-outside-'));
    try {
      const secret = join(outside, 'credentials.md');
      writeFileSync(secret, CARD.replace('Free text written by people.', 'TOP-SECRET-TOKEN'), 'utf-8');
      const card = join(root, 'docs', 'domain', 'lending', 'domain.md');
      rmSync(card);
      try {
        symlinkSync(secret, card, 'file');
      } catch {
        return; // Windows without developer mode cannot make the symlink.
      }
      await runPass();
      const text = read('graph.json');
      expect(text).not.toContain('TOP-SECRET-TOKEN');
      const graph = JSON.parse(text) as DomainGraph;
      expect(graph.rules).toEqual([]);
      expect(graph.contexts.find((c) => c.id === 'context:lending')).toMatchObject({ card: 'docs/domain/lending/domain.md' });
      expect(logs.some((l) => l.includes('domain file docs/domain/lending/domain.md is not read: outside the repository'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('skips a card over 1 MiB with a warning, as a missing card (I2)', async () => {
    writeRepo('docs/domain/lending/domain.md', `${CARD}\n${'x'.repeat(1_048_577)}\n`);
    await runPass();
    const graph = JSON.parse(read('graph.json')) as DomainGraph;
    expect(graph.rules).toEqual([]);
    expect(logs.some((l) => l.includes('domain file docs/domain/lending/domain.md is not read: larger than 1048576 bytes'))).toBe(true);
  });

  it('skips an oversize glossary with a warning (I2)', async () => {
    writeRepo('docs/domain/glossary.md', `- **Member**: a registered patron\n${'x'.repeat(1_048_577)}\n`);
    await runPass();
    const graph = JSON.parse(read('graph.json')) as DomainGraph;
    expect(graph.terms.map((t) => t.id)).not.toContain('term:*/member');
    expect(logs.some((l) => l.includes('domain file docs/domain/glossary.md is not read: larger than 1048576 bytes'))).toBe(true);
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
      new RegExp(`Domain: 2 contexts, 2 rules \\(1 without tests\\), ${graph.links.length} links, 1 shadow-spec candidates \\(1 resolved by links or Untested\\), 0 cross-context edges, 0 boundary violations \\(\\d+ ms\\)`),
    );
  });

  describe('shadow-candidates.json and maturity.json', () => {
    const RENEWAL = 'src/Lending/RenewalPolicy.cs';
    const CAN_RENEW = `${RENEWAL}::RenewalPolicy.CanRenew::method`;
    const DUE = 'src/Lending/DueDates.cs';
    const IS_OVERDUE = `${DUE}::DueDates.IsOverdue::method`;
    const FEES = 'src/Billing/Fees.cs';
    const FLOW = 'tests/Lending.Tests/Characterization/RenewalFlowTests.cs';
    const FLOW_METHOD = `${FLOW}::RenewalFlowTests.RenewsTwiceAtMost::method`;
    const CAN_BORROW = `${POLICY}::LoanPolicy.CanBorrow::method`;

    /** A class and one method; lines are 0-based like every index line. */
    const method = (file: string, cls: string, name: string, start: number, end: number): FileIndex['symbols'] => [
      { symbolId: `${file}::${cls}::class`, name: cls, kind: 'class', startLine: start - 2, endLine: end + 1 },
      { symbolId: `${file}::${cls}.${name}::method`, name: `${cls}.${name}`, kind: 'method', startLine: start, endLine: end },
    ];

    const LOOP_INDICES: FileIndex[] = [
      // Native facts: the plugin ran its detectors (0-based lines).
      {
        ...GRAPH_INDICES[0]!,
        facts: [{ kind: 'literal-comparison', symbolId: CAN_BORROW, line: 5, text: 'loans < 5', detail: { operator: '<', literal: '5' } }],
      },
      {
        file: RENEWAL,
        lastModified: 1_700_000_000,
        symbols: method(RENEWAL, 'RenewalPolicy', 'CanRenew', 4, 8),
        edges: [],
        intent: [],
        antiPatterns: [],
        facts: [
          { kind: 'endpoint', symbolId: CAN_RENEW, line: 4, text: '[HttpPost("renew")]', detail: { method: 'POST', route: 'renew' } },
          { kind: 'literal-comparison', symbolId: CAN_RENEW, line: 7, text: 'renewals > 2', detail: { operator: '>', literal: '2' } },
        ],
      },
      // No facts key: a plugin without fact detectors, so the text scan reads this file.
      { file: DUE, lastModified: 1_700_000_000, symbols: method(DUE, 'DueDates', 'IsOverdue', 4, 8), edges: [], intent: [], antiPatterns: [] },
      // facts: [] means the detectors ran and found nothing: no text scan.
      { file: FEES, lastModified: 1_700_000_000, symbols: method(FEES, 'Fees', 'Late', 4, 8), edges: [], intent: [], antiPatterns: [], facts: [] },
      GRAPH_INDICES[1]!,
      {
        file: FLOW,
        lastModified: 1_700_000_000,
        symbols: [
          { symbolId: `${FLOW}::RenewalFlowTests::class`, name: 'RenewalFlowTests', kind: 'class', startLine: 2, endLine: 6 },
          {
            symbolId: FLOW_METHOD,
            name: 'RenewalFlowTests.RenewsTwiceAtMost',
            kind: 'method',
            startLine: 4,
            endLine: 5,
            annotations: [{ name: 'Fact' }],
          },
        ],
        edges: [{ from: FLOW_METHOD, to: CAN_RENEW, kind: 'calls' }],
        intent: [],
        antiPatterns: [],
      },
    ];

    const CO_CHANGES = {
      version: 1,
      timestamp: 1_700_000_000,
      entries: [
        { file1: FEES, file2: RENEWAL, sharedCommits: 3, frequency: 0.6 },
        // Same context, below the floor, or with a test file: never a cross-context pair.
        { file1: DUE, file2: RENEWAL, sharedCommits: 5, frequency: 0.9 },
        { file1: DUE, file2: FEES, sharedCommits: 1, frequency: 0.4 },
        { file1: FEES, file2: FLOW, sharedCommits: 4, frequency: 0.8 },
      ],
    };

    function writeIndex(index: FileIndex): void {
      const target = join(ctxoRoot, 'index', `${index.file}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(index, null, 2), 'utf-8');
    }

    beforeEach(() => {
      rmSync(ctxoRoot, { recursive: true, force: true });
      for (const index of LOOP_INDICES) writeIndex(index);
      writeFileSync(join(ctxoRoot, 'index', 'co-changes.json'), JSON.stringify(CO_CHANGES, null, 2), 'utf-8');
      writeRepo(
        RENEWAL,
        'namespace Lending;\n\npublic class RenewalPolicy\n{\n    [HttpPost("renew")]\n    public bool CanRenew(int renewals)\n    {\n        return renewals > 2 ? false : true;\n    }\n}\n',
      );
      writeRepo(
        DUE,
        'namespace Lending;\n\npublic class DueDates\n{\n    public bool IsOverdue(int days)\n    {\n        if (days > 14) return true;\n        return false;\n    }\n}\n',
      );
      writeRepo(
        FEES,
        'namespace Billing;\n\npublic class Fees\n{\n    public decimal Late(int days)\n    {\n        if (days > 30) return 5m;\n        return 0m;\n    }\n}\n',
      );
      writeRepo(FLOW, 'namespace Lending.Tests.Characterization;\n\npublic class RenewalFlowTests\n{\n    [Fact]\n    public void RenewsTwiceAtMost() { }\n}\n');
    });

    const candidatesFile = (): string => join(domainDir(), 'shadow-candidates.json');
    const maturityFile = (): string => join(domainDir(), 'maturity.json');

    interface Candidate {
      readonly kind: string;
      readonly context: string;
      readonly file: string;
      readonly line: number;
      readonly symbolId?: string;
      readonly text: string;
      readonly source: string;
      readonly resolution?: { readonly by: string };
    }

    it('writes shadow-candidates.json and maturity.json, byte-identical on a second run', async () => {
      await runPass();
      const candidatesText = read('shadow-candidates.json');
      const maturityText = read('maturity.json');
      const graph = JSON.parse(read('graph.json')) as DomainGraph;

      const candidates = JSON.parse(candidatesText);
      expect(candidates).toMatchObject({ ctxoArtifact: 'domain-shadow-candidates', version: 1 });
      expect(candidates.registryHash).toBe(graph.registryHash);
      expect(candidates.cardsHash).toBe(graph.cardsHash);
      expect((candidates.candidates as Candidate[]).map((c) => [c.context, c.kind, c.file, c.line, c.source, c.resolution?.by ?? null])).toEqual([
        ['lending', 'rule-without-tests', 'docs/domain/lending/domain.md', 14, 'card', 'untested'],
        ['lending', 'literal-comparison', DUE, 7, 'text', null],
        ['lending', 'literal-comparison', POLICY, 6, 'native', 'rule-link'],
        ['lending', 'endpoint', RENEWAL, 5, 'native', null],
        ['lending', 'literal-comparison', RENEWAL, 8, 'native', null],
      ]);

      const maturity = JSON.parse(maturityText);
      expect(maturity).toMatchObject({ ctxoArtifact: 'domain-maturity', version: 1, registryHash: graph.registryHash, cardsHash: graph.cardsHash });
      expect(maturity.contexts.map((c: { context: string }) => c.context)).toEqual(['lending', 'billing']);

      expect(
        logs.some((l) =>
          new RegExp(
            `Domain: 2 contexts, 2 rules \\(1 without tests\\), ${graph.links.length} links, ` +
              '5 shadow-spec candidates \\(2 resolved by links or Untested\\), 0 cross-context edges, 0 boundary violations \\(\\d+ ms\\)',
          ).test(l),
        ),
      ).toBe(true);

      const before = [statSync(candidatesFile()).mtimeMs, statSync(maturityFile()).mtimeMs];
      await runPass();
      expect(read('shadow-candidates.json')).toBe(candidatesText);
      expect(read('maturity.json')).toBe(maturityText);
      expect([statSync(candidatesFile()).mtimeMs, statSync(maturityFile()).mtimeMs]).toEqual(before);
    });

    it('the text fallback runs only for files without native facts', async () => {
      await runPass();
      const candidates = JSON.parse(read('shadow-candidates.json')).candidates as Candidate[];
      const text = candidates.filter((c) => c.source === 'text');
      expect(text).toHaveLength(1);
      expect(text[0]).toMatchObject({ file: DUE, line: 7, symbolId: IS_OVERDUE, kind: 'literal-comparison' });
      expect(text[0]!.text).toContain('days > 14');
      // Fees.cs has facts: [] and a comparison in its source: no candidate. RenewalPolicy.cs keeps its native facts only.
      expect(candidates.filter((c) => c.file === FEES)).toEqual([]);
      expect(candidates.filter((c) => c.file === RENEWAL).every((c) => c.source === 'native')).toBe(true);
    });

    it('maturity counts the characterization test and the cross-context pair', async () => {
      await runPass();
      expect(JSON.parse(read('maturity.json')).contexts).toEqual([
        {
          context: 'lending',
          tests: { characterization: 1, contract: 0 },
          mainPaths: { total: 1, reached: 1, unreached: [] },
          contractSymbols: { total: 0, reached: 0, unreached: [] },
          coChange: { pairs: 1, top: [{ file: RENEWAL, otherFile: FEES, otherContext: 'billing', frequency: 0.6, sharedCommits: 3 }] },
        },
        {
          context: 'billing',
          tests: { characterization: 0, contract: 0 },
          mainPaths: { total: 0, reached: 0, unreached: [] },
          contractSymbols: { total: 0, reached: 0, unreached: [] },
          coChange: { pairs: 1, top: [{ file: FEES, otherFile: RENEWAL, otherContext: 'lending', frequency: 0.6, sharedCommits: 3 }] },
        },
      ]);
    });

    it('maturity counts a cross-context pair once', async () => {
      await runPass();
      const contexts = JSON.parse(read('maturity.json')).contexts as { context: string; coChange: { pairs: number; top: unknown[] } }[];
      expect(contexts.map((c) => [c.context, c.coChange.pairs, c.coChange.top.length])).toEqual([
        ['lending', 1, 1],
        ['billing', 1, 1],
      ]);
    });

    it('maturity has no co-change without co-changes.json', async () => {
      rmSync(join(ctxoRoot, 'index', 'co-changes.json'));
      await runPass();
      expect(JSON.parse(read('maturity.json')).contexts.map((c: { coChange: unknown }) => c.coChange)).toEqual([
        { pairs: 0, top: [] },
        { pairs: 0, top: [] },
      ]);
    });

    it('removes both artifacts when the registry is gone', async () => {
      await runPass();
      expect(existsSync(candidatesFile())).toBe(true);
      expect(existsSync(maturityFile())).toBe(true);
      rmSync(join(root, 'docs', 'domain', 'contexts.yaml'));
      await runPass();
      expect(existsSync(candidatesFile())).toBe(false);
      expect(existsSync(maturityFile())).toBe(false);
    });

    it('writes nothing when the registry has problems', async () => {
      writeRegistry(GRAPH_REGISTRY.replace('rung: named', 'rung: unknown'));
      await runPass();
      expect(existsSync(candidatesFile())).toBe(false);
      expect(existsSync(maturityFile())).toBe(false);

      writeRegistry(GRAPH_REGISTRY);
      await runPass();
      const candidates = read('shadow-candidates.json');
      const maturity = read('maturity.json');
      writeRegistry('version: 1\ncontexts: [');
      writeRepo(DUE, 'public class DueDates\n{\n    public bool IsOverdue(int days) => days > 21;\n}\n');
      rmSync(join(ctxoRoot, 'index', 'co-changes.json'));
      await runPass();
      expect(read('shadow-candidates.json')).toBe(candidates);
      expect(read('maturity.json')).toBe(maturity);
    });

    it('a graph build failure leaves both artifacts as they were (W10)', async () => {
      await runPass();
      const candidates = read('shadow-candidates.json');
      const maturity = read('maturity.json');
      writeRepo(DUE, 'public class DueDates\n{\n    public bool IsOverdue(int days) => days > 21;\n}\n');
      rmSync(join(ctxoRoot, 'index', 'co-changes.json'));
      const failing = (host: CtxoHost): CtxoHost => {
        const services = { ...host.services };
        Object.defineProperty(services, 'dataResourceKinds', {
          get() {
            throw new Error('boom');
          },
        });
        return { ...host, services };
      };
      await runPass(undefined, failing);
      expect(logs.some((l) => l.includes('The domain graph could not be built: boom'))).toBe(true);
      expect(read('shadow-candidates.json')).toBe(candidates);
      expect(read('maturity.json')).toBe(maturity);
    });

    // The rule both tests pin: the two loop files are written together or not at all. A failure after the graph keeps
    // both byte-identical to the last good run (so they always share registryHash and cardsHash), while graph.json
    // moves on to the new cardsHash, which is how the loop tools see the pair as stale.
    async function expectLoopPairKept(failingRun: () => Promise<void>, warning: string): Promise<void> {
      await runPass();
      const candidates = read('shadow-candidates.json');
      const maturity = read('maturity.json');
      const oldCardsHash = (JSON.parse(read('graph.json')) as DomainGraph).cardsHash;

      writeRepo('docs/domain/lending/domain.md', CARD.replace('Free text written by people.', 'Edited.'));
      logs.length = 0;
      await failingRun();

      expect(logs.some((l) => l.includes('WARN') && l.includes(warning))).toBe(true);
      const graph = JSON.parse(read('graph.json')) as DomainGraph;
      expect(graph.cardsHash).not.toBe(oldCardsHash);
      expect(read('shadow-candidates.json')).toBe(candidates);
      expect(read('maturity.json')).toBe(maturity);
      const pair = [JSON.parse(candidates), JSON.parse(maturity)].map((a: { registryHash: string; cardsHash: string }) => [a.registryHash, a.cardsHash]);
      expect(pair[0]).toEqual(pair[1]);
      expect(pair[0]).toEqual([graph.registryHash, oldCardsHash]);
      // The log line has no candidate segment for a run that wrote no candidates.
      expect(logs.some((l) => l.includes('Domain: ') && !l.includes('shadow-spec candidates') && l.includes(`${graph.links.length} links, `))).toBe(true);
    }

    it('a maturity failure is a warning, writes graph.json and keeps both loop files as they were', async () => {
      await expectLoopPairKept(
        () =>
          runPass(undefined, (host) => ({
            ...host,
            services: {
              ...host.services,
              readCoChangeEntries: () => {
                throw new Error('matrix unreadable');
              },
            },
          })),
        'The maturity facts could not be built: matrix unreadable; shadow-candidates.json and maturity.json not updated.',
      );
    });

    it('a candidate failure is a warning, writes graph.json and keeps both loop files as they were', async () => {
      // The text scan targets read each index's `facts` key; the graph and the boundaries never do.
      const throwingFacts = (ctx: IndexPassContext): IndexPassContext => {
        const indices = ctx.indices.map((index) =>
          index.file === DUE
            ? Object.defineProperty({ ...index }, 'facts', {
                get() {
                  throw new Error('facts unreadable');
                },
              })
            : index,
        );
        return { ...ctx, indices, graph: () => createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root }).services.buildGraph(indices) };
      };
      await expectLoopPairKept(() => runPass(undefined, (h) => h, throwingFacts), 'The shadow-spec candidates could not be built: facts unreadable.');
    });

    it('the JSON index reader skips both artifacts', async () => {
      const services = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: root }).services;
      const before = services.readIndex(ctxoRoot).length;
      await runPass();
      expect(existsSync(candidatesFile())).toBe(true);
      expect(existsSync(maturityFile())).toBe(true);
      expect(services.readIndex(ctxoRoot)).toHaveLength(before);
    });
  });
});
