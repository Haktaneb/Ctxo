import { describe, it, expect } from 'vitest';
import { createModuleHost, type CoChangeEntry, type CodeFact, type FileIndex, type GraphEdge, type SymbolNode } from '@ctxo/cli/internal';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import { COCHANGE_TOP, CROSS_CONTEXT_COCHANGE_MIN, UNREACHED_CAP, buildMaturityFacts, type ContextMaturityFacts } from '../maturity.js';
import { createOwnership } from '../ownership.js';
import { buildReachGraph } from '../reachability.js';
import { parseRegistry } from '../registry.js';
import type { TestTitle } from '../rule-id-scan.js';
import { classifyTests } from '../test-conventions.js';

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
const makeMatcher = host.services.makeGlobMatcher;
const isTestFile = (p: string): boolean => p.startsWith('tests/') || p.includes('/tests/');

const REGISTRY = `version: 1
contexts:
  - id: lending
    name: Lending
    paths: ["src/Lending/**"]
    rung: named
    contracts:
      billing: ["src/Billing/Api/**"]
  - id: billing
    name: Billing
    paths: ["src/Billing/**"]
    rung: named
`;

function sym(file: string, name: string, kind: SymbolNode['kind'], startLine: number, endLine: number): SymbolNode {
  return { symbolId: `${file}::${name}::${kind}`, name, kind, startLine, endLine };
}

function fileIndex(file: string, symbols: SymbolNode[], edges: GraphEdge[] = []): FileIndex {
  return { file, lastModified: 1, symbols, edges, intent: [], antiPatterns: [] };
}

function endpoint(file: string, symbolId: string, line = 1): CodeFact {
  return { kind: 'endpoint', symbolId, line, text: 'POST /charges' };
}

interface Fixture {
  readonly indices: FileIndex[];
  readonly facts: [string, CodeFact[]][];
  readonly titles?: TestTitle[];
  readonly coChange?: CoChangeEntry[];
}

function run(fixture: Fixture): ContextMaturityFacts[] {
  const { registry, problems } = parseRegistry(REGISTRY);
  expect(problems).toEqual([]);
  const tests = classifyTests({
    indices: fixture.indices,
    isTestFile,
    titles: fixture.titles ?? [],
    characterization: DEFAULT_DOMAIN_CONFIG.tests.characterization,
    contract: DEFAULT_DOMAIN_CONFIG.tests.contract,
    makeMatcher,
  });
  return buildMaturityFacts({
    registry: registry!,
    ownership: createOwnership(registry!, makeMatcher),
    isTestFile,
    indices: fixture.indices,
    facts: new Map(fixture.facts),
    reach: buildReachGraph(host.services.buildGraph(fixture.indices), fixture.indices),
    tests,
    makeMatcher,
    ...(fixture.coChange === undefined ? {} : { coChange: fixture.coChange }),
  });
}

const API = 'src/Billing/Api/ChargeApi.cs';
const CHARGE = `${API}::ChargeApi.Charge::method`;
const REFUND = `${API}::ChargeApi.Refund::method`;
const API_CLASS = `${API}::ChargeApi::class`;
const WEB = 'src/Billing/Web/Endpoints.cs';
const POST = `${WEB}::Endpoints.Post::method`;
const LOANS = 'src/Lending/Api/LoanEndpoints.cs';
const LOANS_GET = `${LOANS}::Loans.Get::method`;
const FLOW = 'tests/Billing.Tests/Characterization/ChargeFlow.cs';
const FLOW_RUN = `${FLOW}::ChargeFlow.Run::method`;
const SHAPE_FILE = 'tests/Contracts.Tests/ChargeContract.cs';
const SHAPE = `${SHAPE_FILE}::ChargeContract.Shape::method`;
const OWNED_TEST = 'src/Lending/tests/Characterization/LoanFlow.cs';

function sampleFixture(): Fixture {
  return {
    indices: [
      fileIndex(API, [sym(API, 'ChargeApi', 'class', 0, 20), sym(API, 'ChargeApi.Charge', 'method', 2, 6), sym(API, 'ChargeApi.Refund', 'method', 8, 12)]),
      fileIndex(WEB, [sym(WEB, 'Endpoints', 'class', 0, 20), sym(WEB, 'Endpoints.Post', 'method', 2, 6)]),
      fileIndex(LOANS, [sym(LOANS, 'Loans', 'class', 0, 20), sym(LOANS, 'Loans.Get', 'method', 2, 6)]),
      fileIndex(FLOW, [sym(FLOW, 'ChargeFlow', 'class', 0, 20), sym(FLOW, 'ChargeFlow.Run', 'method', 2, 6)], [
        { from: FLOW_RUN, to: CHARGE, kind: 'calls' },
      ]),
      fileIndex(SHAPE_FILE, [sym(SHAPE_FILE, 'ChargeContract', 'class', 0, 20), sym(SHAPE_FILE, 'ChargeContract.Shape', 'method', 2, 6)], [
        { from: SHAPE, to: API_CLASS, kind: 'uses' },
      ]),
      fileIndex(OWNED_TEST, [sym(OWNED_TEST, 'LoanFlow', 'class', 0, 20), sym(OWNED_TEST, 'LoanFlow.Run', 'method', 2, 6)]),
    ],
    facts: [
      [WEB, [endpoint(WEB, POST, 3), endpoint(WEB, POST, 4), { kind: 'literal-comparison', symbolId: POST, line: 5, text: 'x > 5' }]],
      [LOANS, [endpoint(LOANS, LOANS_GET)]],
      [FLOW, [endpoint(FLOW, FLOW_RUN)]],
    ],
  };
}

describe('buildMaturityFacts', () => {
  it('main paths are endpoint symbols and contract symbols other contexts may use', () => {
    expect(run(sampleFixture())).toEqual([
      {
        context: 'lending',
        tests: { characterization: 1, contract: 0 },
        mainPaths: { total: 1, reached: 0, unreached: [LOANS_GET] },
        contractSymbols: { total: 0, reached: 0, unreached: [] },
        coChange: { pairs: 0, top: [] },
      },
      {
        context: 'billing',
        tests: { characterization: 1, contract: 1 },
        mainPaths: { total: 3, reached: 1, unreached: [REFUND, POST] },
        contractSymbols: { total: 2, reached: 2, unreached: [] },
        coChange: { pairs: 0, top: [] },
      },
    ]);
  });

  it('contract symbols are the leaves of contract files', () => {
    const fixture = sampleFixture();
    const nested = 'src/Billing/Api/Nested.cs';
    const facts = run({
      ...fixture,
      indices: [
        ...fixture.indices,
        fileIndex(nested, [
          sym(nested, 'Outer', 'class', 0, 30),
          sym(nested, 'Outer.Inner', 'class', 2, 20),
          sym(nested, 'Outer.Inner.Leaf', 'method', 4, 8),
          sym(nested, 'Outer.Field', 'variable', 22, 22),
        ]),
        // A test file under the contract glob adds nothing.
        fileIndex('src/Billing/Api/tests/ApiTests.cs', [sym('src/Billing/Api/tests/ApiTests.cs', 'ApiTests.Case', 'method', 0, 3)]),
      ],
    });
    const billing = facts.find((f) => f.context === 'billing')!;
    // Outer contains Inner, Inner contains Leaf: the leaves are Leaf and Field. The contract test reaches ChargeApi only.
    expect(billing.contractSymbols).toEqual({
      total: 4,
      reached: 2,
      unreached: [`${nested}::Outer.Field::variable`, `${nested}::Outer.Inner.Leaf::method`],
    });
    const noShape = run({ ...fixture, indices: fixture.indices.filter((i) => i.file !== SHAPE_FILE) });
    expect(noShape.find((f) => f.context === 'billing')!.contractSymbols).toEqual({ total: 2, reached: 0, unreached: [CHARGE, REFUND] });
  });

  it('cross-context co-change counts pairs at 0.5 or more and keeps the top ten', () => {
    expect(CROSS_CONTEXT_COCHANGE_MIN).toBe(0.5);
    expect(COCHANGE_TOP).toBe(10);
    const coChange: CoChangeEntry[] = [];
    for (let i = 0; i < 12; i++) {
      const n = String(i).padStart(2, '0');
      coChange.push({ file1: `src/Billing/B${n}.cs`, file2: `src/Lending/L${n}.cs`, frequency: 0.5 + i / 100, sharedCommits: 3 });
    }
    coChange.push({ file1: 'src/Billing/Low.cs', file2: 'src/Lending/Low.cs', frequency: 0.49, sharedCommits: 9 });
    coChange.push({ file1: 'src/Billing/X.cs', file2: 'tests/Lending/XTests.cs', frequency: 0.9, sharedCommits: 9 });
    coChange.push({ file1: 'src/Billing/X.cs', file2: 'src/Billing/Y.cs', frequency: 0.9, sharedCommits: 9 });
    coChange.push({ file1: 'src/Billing/X.cs', file2: 'docs/x.md', frequency: 0.9, sharedCommits: 9 });
    // A tie on frequency: more shared commits first.
    coChange.push({ file1: 'src/Lending/Tie.cs', file2: 'src/Billing/Tie.cs', frequency: 0.61, sharedCommits: 7 });
    const facts = run({ ...sampleFixture(), coChange });
    const lending = facts.find((f) => f.context === 'lending')!;
    const billing = facts.find((f) => f.context === 'billing')!;
    expect(lending.coChange.pairs).toBe(13);
    expect(billing.coChange.pairs).toBe(13);
    expect(lending.coChange.top).toHaveLength(10);
    expect(lending.coChange.top[0]).toEqual({ file: 'src/Lending/Tie.cs', otherFile: 'src/Billing/Tie.cs', otherContext: 'billing', frequency: 0.61, sharedCommits: 7 });
    expect(lending.coChange.top.slice(0, 3).map((e) => e.file)).toEqual(['src/Lending/Tie.cs', 'src/Lending/L11.cs', 'src/Lending/L10.cs']);
    expect(lending.coChange.top[9]!.file).toBe('src/Lending/L03.cs');
    expect(billing.coChange.top[0]).toEqual({ file: 'src/Billing/Tie.cs', otherFile: 'src/Lending/Tie.cs', otherContext: 'lending', frequency: 0.61, sharedCommits: 7 });
    expect(lending.coChange.top.some((e) => e.file === 'src/Lending/Low.cs')).toBe(false);

    const twelve = run({ ...sampleFixture(), coChange: coChange.slice(0, 13) });
    expect(twelve.find((f) => f.context === 'lending')!.coChange.pairs).toBe(12);
    expect(twelve.find((f) => f.context === 'lending')!.coChange.top).toHaveLength(10);
  });

  it('unreached lists are sorted and capped at 20', () => {
    expect(UNREACHED_CAP).toBe(20);
    const file = 'src/Billing/Web/Many.cs';
    const symbols: SymbolNode[] = [];
    const facts: CodeFact[] = [];
    for (let i = 24; i >= 0; i--) {
      const name = `Many.E${String(i).padStart(2, '0')}`;
      symbols.push(sym(file, name, 'method', i * 2, i * 2 + 1));
      facts.push(endpoint(file, `${file}::${name}::method`, i * 2));
    }
    const fixture = sampleFixture();
    const result = run({ ...fixture, indices: [...fixture.indices, fileIndex(file, symbols)], facts: [...fixture.facts, [file, facts]] });
    const billing = result.find((f) => f.context === 'billing')!;
    expect(billing.mainPaths.total).toBe(28);
    expect(billing.mainPaths.reached).toBe(1);
    expect(billing.mainPaths.unreached).toHaveLength(20);
    expect(billing.mainPaths.unreached).toEqual([...billing.mainPaths.unreached].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // 27 unreached: Refund, Post, then E00..E24; the cap keeps E00..E17.
    expect(billing.mainPaths.unreached.slice(0, 3)).toEqual([REFUND, POST, `${file}::Many.E00::method`]);
    expect(billing.mainPaths.unreached[19]).toBe(`${file}::Many.E17::method`);
  });

  it('shuffled input gives deep-equal output', () => {
    const coChange: CoChangeEntry[] = [
      { file1: 'src/Billing/A.cs', file2: 'src/Lending/A.cs', frequency: 0.7, sharedCommits: 4 },
      { file1: 'src/Lending/B.cs', file2: 'src/Billing/B.cs', frequency: 0.7, sharedCommits: 4 },
      { file1: 'src/Billing/C.cs', file2: 'src/Lending/C.cs', frequency: 0.8, sharedCommits: 2 },
    ];
    const fixture = { ...sampleFixture(), coChange, titles: [{ file: FLOW, line: 3, title: '[characterization] charge' }] };
    const shuffled: Fixture = {
      indices: [...fixture.indices].reverse().map((i) => ({ ...i, symbols: [...i.symbols].reverse() })),
      facts: [...fixture.facts].reverse().map(([f, list]) => [f, [...list].reverse()] as [string, CodeFact[]]),
      titles: [...fixture.titles].reverse(),
      coChange: [...coChange].reverse(),
    };
    expect(run(shuffled)).toEqual(run(fixture));
  });
});
