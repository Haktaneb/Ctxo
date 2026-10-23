import { describe, it, expect } from 'vitest';
import { createModuleHost, type FileIndex } from '@ctxo/cli/internal';
import { parseCard, parseGlossary } from '../card-parser.js';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import { buildDomainGraph, type CardInput, type DomainGraph } from '../domain-graph.js';
import {
  canonicalRuleId,
  codeRefs,
  decisionsForContext,
  decisionView,
  indexGraph,
  rulesForSymbols,
  rulesWithoutTests,
  testRefs,
} from '../domain-graph-query.js';
import { ADDITIVE_CAP } from '../limits.js';
import { createOwnership } from '../ownership.js';
import type { DomainContext, DomainRegistry } from '../registry.js';
import type { RuleLinks, RuleRef } from '../rule-id-scan.js';
import { estimateTokens } from '../token-estimate.js';

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
const { splitIdentifier: split, dataResourceKinds, makeGlobMatcher } = host.services;

const LENDING_CARD = 'docs/domain/lending/domain.md';
const BILLING_CARD = 'docs/domain/billing/domain.md';
const POLICY_FILE = 'src/lending/LoanPolicy.cs';
const CAN_BORROW = `${POLICY_FILE}::LoanPolicy.CanBorrow::method`;
const RENEW = `${POLICY_FILE}::LoanPolicy.Renew::method`;
const POLICY_CLASS = `${POLICY_FILE}::LoanPolicy::class`;
const FINES_FILE = 'src/lending/Fines.cs';
const FINES = `${FINES_FILE}::Fines::class`;
const TEST_FILE = 'src/lending/LoanLimitTests.cs';
const TEST_METHOD = `${TEST_FILE}::LoanLimitTests.RejectsTheSixthLoan::method`;

const LENDING_TEXT = [
  '# Lending',
  '',
  '## Language',
  '- **Loan**: a book lent to a member',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  `Tests: \`${TEST_FILE}\``,
  `Code: \`${CAN_BORROW}\``,
  '',
  'Five is the limit.',
  '',
  '### LEND-04 A member with an unpaid fine cannot borrow',
  `Code: \`${FINES_FILE}\``,
  'Untested: covered by manual QA',
  '',
  '### LEND-05 A loan can be renewed twice',
  '',
  '## Decisions',
  '- 2026-09-12: LEND-03: loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
  '- 2026-01-01: First decision.',
  '- 2026-02-01: Second decision.',
  '- 2026-03-01: Third decision.',
  '- 2026-03-01: Third decision, same day.',
  '- 2026-04-01: Unpaid fines block borrowing (LEND-04).',
  '- 2026-05-01: Fifth decision.',
  '',
].join('\n');

const BILLING_TEXT = ['# Billing', '', '## Rules and invariants', '### BILL-01 An invoice is sent once', ''].join('\n');

function context(id: string, extra: Partial<DomainContext> = {}): DomainContext {
  return { id, name: id, paths: [`src/${id}/**`], rung: 'pinned', contracts: {}, ...extra };
}

const LENDING = context('lending', { card: LENDING_CARD, rulePrefix: 'LEND' });
const BILLING = context('billing', { card: BILLING_CARD, rulePrefix: 'BILL' });
// Shares the Lending card: the rules belong to lending, the first by id among the two.
const LOANS = context('loans', { card: LENDING_CARD });
const REGISTRY: DomainRegistry = {
  version: 1,
  contexts: [LENDING, BILLING, LOANS],
  unownedAllow: [],
  glossary: 'docs/domain/glossary.md',
  contextMap: 'docs/domain/context-map.md',
};

function fileIndex(file: string, symbols: [string, string][]): FileIndex {
  return {
    file,
    lastModified: 1,
    symbols: symbols.map(([name, kind], i) => ({
      symbolId: `${file}::${name}::${kind}`,
      name,
      kind,
      startLine: i * 10,
      endLine: i * 10 + 5,
    })) as FileIndex['symbols'],
    edges: [],
    intent: [],
    antiPatterns: [],
  };
}

const INDICES: FileIndex[] = [
  fileIndex(POLICY_FILE, [
    ['LoanPolicy', 'class'],
    ['LoanPolicy.CanBorrow', 'method'],
    ['LoanPolicy.Renew', 'method'],
  ]),
  fileIndex(FINES_FILE, [['Fines', 'class']]),
  fileIndex(TEST_FILE, [
    ['LoanLimitTests', 'class'],
    ['LoanLimitTests.RejectsTheSixthLoan', 'method'],
  ]),
];

const ref = (over: Partial<RuleRef> & Pick<RuleRef, 'file' | 'line' | 'kind' | 'id'>): RuleRef => ({ raw: over.id, ...over });

function links(refs: readonly RuleRef[]): RuleLinks {
  const map = new Map<string, RuleRef[]>();
  for (const r of refs) map.set(r.id, [...(map.get(r.id) ?? []), r]);
  return { links: map, unknown: [] };
}

const FILES = new Set([POLICY_FILE, FINES_FILE, TEST_FILE, 'docs/specs/loan-limit.md']);

function graph(): DomainGraph {
  const cards: CardInput[] = [
    { context: LENDING, path: LENDING_CARD, card: parseCard(LENDING_TEXT) },
    { context: BILLING, path: BILLING_CARD, card: parseCard(BILLING_TEXT) },
    { context: LOANS, path: LENDING_CARD, card: parseCard(LENDING_TEXT) },
  ];
  return buildDomainGraph({
    registry: REGISTRY,
    registryHash: '0123456789abcdef',
    config: DEFAULT_DOMAIN_CONFIG,
    cards,
    glossary: { path: 'docs/domain/glossary.md', items: parseGlossary('- **Fine** (context: lending): money owed\n- **Member**: a patron\n') },
    cardsHash: 'fedcba9876543210',
    indices: INDICES,
    isTestFile: (path) => path.endsWith('Tests.cs'),
    ownership: createOwnership(REGISTRY, makeGlobMatcher),
    testRefs: links([
      ref({ id: 'LEND-03', file: TEST_FILE, line: 14, kind: 'mention', symbolId: TEST_METHOD }),
      ref({ id: 'LEND-03', file: TEST_FILE, line: 11, kind: 'annotation', symbolId: TEST_METHOD, annotation: 'Trait' }),
    ]),
    codeRefs: links([ref({ id: 'LEND-05', file: POLICY_FILE, line: 19, kind: 'rule-comment', symbolId: RENEW })]),
    fileExists: (path) => FILES.has(path),
    split,
    dataResourceKinds,
    warn: () => undefined,
  });
}

const INDEX = indexGraph(graph());

describe('domain graph queries', () => {
  it('estimateTokens is a quarter of the JSON length, rounded up', () => {
    expect(estimateTokens({ a: 1 })).toBe(2);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens(undefined)).toBe(0);
    expect(ADDITIVE_CAP).toBe(50);
  });

  it('indexes rules by context in card line order; a context sharing a card has no rules of its own', () => {
    expect(INDEX.rulesByContext.get('lending')?.map((r) => r.ruleId)).toEqual(['LEND-03', 'LEND-04', 'LEND-05']);
    expect(INDEX.rulesByContext.get('billing')?.map((r) => r.ruleId)).toEqual(['BILL-01']);
    expect(INDEX.rulesByContext.get('loans')).toEqual([]);
    expect(INDEX.ruleContextByCard.get(LENDING_CARD)).toBe('lending');
    expect(INDEX.ruleContextByCard.get(BILLING_CARD)).toBe('billing');
    expect(INDEX.contexts.get('loans')?.card).toBe(LENDING_CARD);
    expect(INDEX.rules.get('LEND-04')?.untested).toBe('covered by manual QA');
  });

  it('indexes terms with card terms before glossary terms, and decisions newest first', () => {
    expect(INDEX.termsByContext.get('lending')?.map((t) => t.term)).toEqual(['Loan', 'Fine']);
    expect(INDEX.termsByContext.get('*')?.map((t) => t.term)).toEqual(['Member']);
    expect(INDEX.decisionsByContext.get('lending')?.map((d) => `${d.date}-${d.n}`)).toEqual([
      '2026-09-12-1',
      '2026-05-01-1',
      '2026-04-01-1',
      '2026-03-01-1',
      '2026-03-01-2',
      '2026-02-01-1',
      '2026-01-01-1',
    ]);
    expect(INDEX.decisionRules.get('decision:lending/2026-04-01-1')).toEqual(['LEND-04']);
  });

  it("rulesForSymbols matches symbol links and file-level links of the symbol's file", () => {
    expect(rulesForSymbols(INDEX, [CAN_BORROW, FINES, TEST_METHOD, CAN_BORROW])).toEqual([
      {
        ruleId: 'LEND-03',
        via: [
          { symbolId: CAN_BORROW, link: 'code' },
          { symbolId: TEST_METHOD, link: 'test' },
        ],
      },
      { ruleId: 'LEND-04', via: [{ symbolId: FINES, link: 'code' }] },
    ]);
  });

  it('a symbol link does not match other symbols of the same file', () => {
    expect(rulesForSymbols(INDEX, [POLICY_CLASS])).toEqual([]);
    expect(rulesForSymbols(INDEX, [RENEW])).toEqual([{ ruleId: 'LEND-05', via: [{ symbolId: RENEW, link: 'code' }] }]);
    // The test file's other symbols still match the file-level card Tests: link.
    expect(rulesForSymbols(INDEX, [`${TEST_FILE}::LoanLimitTests::class`])).toEqual([
      { ruleId: 'LEND-03', via: [{ symbolId: `${TEST_FILE}::LoanLimitTests::class`, link: 'test' }] },
    ]);
  });

  it('canonicalRuleId accepts LEND-03, lend03 and Lend_03 and rejects LEND-030 and LEND-99', () => {
    expect(canonicalRuleId(INDEX, 'LEND-03')).toBe('LEND-03');
    expect(canonicalRuleId(INDEX, ' lend03 ')).toBe('LEND-03');
    expect(canonicalRuleId(INDEX, 'Lend_03')).toBe('LEND-03');
    expect(canonicalRuleId(INDEX, 'LEND-030')).toBeUndefined();
    expect(canonicalRuleId(INDEX, 'LEND-99')).toBeUndefined();
    expect(canonicalRuleId(INDEX, 'loan limit')).toBeUndefined();
  });

  it('canonicalRuleId strips a rule: node-id prefix, so a domain-scope hit id passes as is (I3)', () => {
    expect(canonicalRuleId(INDEX, 'rule:LEND-03')).toBe('LEND-03');
    expect(canonicalRuleId(INDEX, ' Rule: lend03 ')).toBe('LEND-03');
    expect(canonicalRuleId(INDEX, 'RULE:Lend_03')).toBe('LEND-03');
    expect(canonicalRuleId(INDEX, 'rule:LEND-99')).toBeUndefined();
    expect(canonicalRuleId(INDEX, 'term:LEND-03')).toBeUndefined();
    expect(canonicalRuleId(INDEX, 'rule:rule:LEND-03')).toBeUndefined();
  });

  it('decisionsForContext puts decisions about preferred rules first, then newest, and limits to five', () => {
    const ids = (preferred: string[], limit?: number): string[] =>
      decisionsForContext(INDEX, 'lending', new Set(preferred), limit).map((d) => `${d.date}-${d.n}`);
    expect(ids(['LEND-04'])).toEqual(['2026-04-01-1', '2026-09-12-1', '2026-05-01-1', '2026-03-01-1', '2026-03-01-2']);
    expect(ids([])).toEqual(['2026-09-12-1', '2026-05-01-1', '2026-04-01-1', '2026-03-01-1', '2026-03-01-2']);
    expect(ids(['LEND-03', 'LEND-04'], 3)).toEqual(['2026-09-12-1', '2026-04-01-1', '2026-05-01-1']);
    expect(decisionsForContext(INDEX, 'nowhere', new Set())).toEqual([]);
  });

  it('rulesWithoutTests lists rules without a rule-test link with their untested reason', () => {
    const rules = rulesWithoutTests(INDEX, ['lending', 'billing', 'loans']);
    expect(rules.map((r) => [r.ruleId, r.untested])).toEqual([
      ['LEND-04', 'covered by manual QA'],
      ['LEND-05', undefined],
      ['BILL-01', undefined],
    ]);
  });

  it('testRefs groups the Trait and card Tests: links of one test file', () => {
    expect(testRefs(INDEX, 'LEND-03')).toEqual([
      { file: TEST_FILE, sources: [{ source: 'card-tests', file: LENDING_CARD, line: 8 }] },
      {
        file: TEST_FILE,
        symbolId: TEST_METHOD,
        testName: 'LoanLimitTests.RejectsTheSixthLoan',
        sources: [
          { source: 'annotation', annotation: 'Trait', file: TEST_FILE, line: 11 },
          { source: 'mention', file: TEST_FILE, line: 14 },
        ],
      },
    ]);
    expect(testRefs(INDEX, 'LEND-04')).toEqual([]);
    expect(testRefs(INDEX, 'NOPE-1')).toEqual([]);
  });

  it('codeRefs lists card Code: and rule: comment links per target', () => {
    expect(codeRefs(INDEX, 'LEND-03')).toEqual([{ file: POLICY_FILE, symbolId: CAN_BORROW, sources: [{ source: 'card-code', file: LENDING_CARD, line: 9 }] }]);
    expect(codeRefs(INDEX, 'LEND-04')).toEqual([{ file: FINES_FILE, sources: [{ source: 'card-code', file: LENDING_CARD, line: 14 }] }]);
    expect(codeRefs(INDEX, 'LEND-05')).toEqual([{ file: POLICY_FILE, symbolId: RENEW, sources: [{ source: 'rule-comment', file: POLICY_FILE, line: 19 }] }]);
  });

  it('decisionView lists provenance in text order', () => {
    const decision = INDEX.decisionsByContext.get('lending')!.find((d) => d.date === '2026-09-12')!;
    expect(decisionView(INDEX, decision)).toEqual({
      id: 'decision:lending/2026-09-12-1',
      date: '2026-09-12',
      text: decision.text,
      card: LENDING_CARD,
      line: decision.line,
      rules: ['LEND-03'],
      provenance: [
        { kind: 'file', path: 'docs/specs/loan-limit.md', exists: true, label: 'spec' },
        { kind: 'external', value: '#123' },
        { kind: 'file', path: 'docs/adr/adr-007-loan-limit.md', exists: false, label: 'ADR-007' },
      ],
    });
  });

  it('decisionView keeps the text order for a reference inside another, a repeated label and a trimmed label', () => {
    const text = [
      '# Lending',
      '',
      '## Decisions',
      '- 2026-10-01: see #123 and #12',
      '- 2026-10-02: [doc](../../b.md) then [doc](../../a.md)',
      '- 2026-10-03: [ spec ](../../z.md), #9',
      '',
    ].join('\n');
    const reg: DomainRegistry = { ...REGISTRY, contexts: [LENDING] };
    const index = indexGraph(
      buildDomainGraph({
        registry: reg,
        registryHash: '0123456789abcdef',
        config: DEFAULT_DOMAIN_CONFIG,
        cards: [{ context: LENDING, path: LENDING_CARD, card: parseCard(text) }],
        cardsHash: 'fedcba9876543210',
        indices: [],
        isTestFile: () => false,
        ownership: createOwnership(reg, makeGlobMatcher),
        testRefs: { links: new Map(), unknown: [] },
        codeRefs: { links: new Map(), unknown: [] },
        fileExists: () => true,
        split,
        dataResourceKinds,
      }),
    );
    const order = (date: string): string[] => {
      const decision = index.decisionsByContext.get('lending')!.find((d) => d.date === date)!;
      return decisionView(index, decision).provenance.map((p) => (p.kind === 'file' ? p.path : p.value));
    };
    expect(order('2026-10-01')).toEqual(['#123', '#12']);
    expect(order('2026-10-02')).toEqual(['docs/b.md', 'docs/a.md']);
    expect(order('2026-10-03')).toEqual(['docs/z.md', '#9']);
  });
});
