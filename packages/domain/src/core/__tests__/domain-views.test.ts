import { describe, it, expect } from 'vitest';
import { createModuleHost, type FileIndex } from '@ctxo/cli/internal';
import { parseCard, parseGlossary } from '../card-parser.js';
import { DEFAULT_DOMAIN_CONFIG } from '../domain-config.js';
import { buildDomainGraph, type CardInput } from '../domain-graph.js';
import { indexGraph, type DomainSnapshot } from '../domain-graph-query.js';
import { contextForPath, contextsOverview, contextView, ruleView, VIEW_CAPS } from '../domain-views.js';
import { createOwnership } from '../ownership.js';
import type { DomainContext, DomainRegistry } from '../registry.js';
import type { RuleLinks, RuleRef } from '../rule-id-scan.js';

const host = createModuleHost({ cliVersion: '0.0.0', mode: 'cli', projectRoot: process.cwd() });
const { splitIdentifier: split, dataResourceKinds, makeGlobMatcher } = host.services;

const LENDING_CARD = 'docs/domain/lending/domain.md';
const BILLING_CARD = 'docs/domain/billing/domain.md';
const POLICY_FILE = 'src/lending/LoanPolicy.cs';
const CAN_BORROW = `${POLICY_FILE}::LoanPolicy.CanBorrow::method`;
const RENEW = `${POLICY_FILE}::LoanPolicy.Renew::method`;
const FINES_FILE = 'src/lending/Fines.cs';
const TEST_FILE = 'tests/Lending.Tests/LoanLimitTests.cs';
const TEST_METHOD = `${TEST_FILE}::LoanLimitTests.RejectsTheSixthLoan::method`;

/** The spec 11.1 card, with the Task 9 fixture's names. */
const LENDING_TEXT = [
  '# Lending',
  '',
  'Lending lends books to members.',
  '',
  '## Language',
  '- **Loan**: a book lent to a member',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  `Tests: \`${TEST_FILE}\``,
  `Code: \`${POLICY_FILE}\`, \`${CAN_BORROW}\``,
  '',
  'Free text written by people.',
  '',
  '### LEND-04 A member with an unpaid fine cannot borrow',
  `Code: \`${FINES_FILE}\``,
  'Untested: covered by manual QA until the scheduler migration lands',
  '',
  '### LEND-05 A loan can be renewed twice',
  'Tests: `tests/Lending.Tests/Missing.cs`',
  '',
  '## Boundary contracts',
  'Lending charges fines through `src/billing/ChargeService.cs`.',
  '',
  '## Decisions',
  '- 2026-09-12: LEND-03: loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
  '- 2026-04-01: Unpaid fines block borrowing (LEND-04).',
  '- 2026-10-01: LEND-03 stays at five. #123',
  '',
  '## Open questions',
  '- Should a renewal count as a new loan?',
  '',
].join('\n');

const BILLING_TEXT = ['# Billing', '', '## Rules and invariants', '### BILL-01 An invoice is sent once', ''].join('\n');

function context(id: string, extra: Partial<DomainContext> = {}): DomainContext {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), paths: [`src/${id}/**`], rung: 'pinned', contracts: {}, ...extra };
}

const LENDING = context('lending', { card: LENDING_CARD, rulePrefix: 'LEND', rung: 'bounded', contracts: { billing: ['src/billing/ChargeService.cs'] } });
const BILLING = context('billing', { card: BILLING_CARD, rulePrefix: 'BILL', contracts: { lending: ['src/lending/LoanApi.cs'] } });
// Shares the Lending card: its rules belong to lending, the first by id.
const LOANS = context('loans', { card: LENDING_CARD });
// Overlaps lending: a file under src/lending/Old/ has two owners.
const ARCHIVE = context('archive', { paths: ['src/lending/Old/**'], rung: 'fear' });
const REGISTRY: DomainRegistry = {
  version: 1,
  contexts: [LENDING, BILLING, LOANS, ARCHIVE],
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

interface Build {
  readonly lending?: string;
  readonly indices?: readonly FileIndex[];
  readonly testRefs?: readonly RuleRef[];
  readonly fileExists?: (path: string) => boolean;
}

function snapshot(build: Build = {}): DomainSnapshot {
  const lending = parseCard(build.lending ?? LENDING_TEXT);
  const cards: CardInput[] = [
    { context: LENDING, path: LENDING_CARD, card: lending },
    { context: BILLING, path: BILLING_CARD, card: parseCard(BILLING_TEXT) },
    { context: LOANS, path: LENDING_CARD, card: lending },
  ];
  const ownership = createOwnership(REGISTRY, makeGlobMatcher);
  const graph = buildDomainGraph({
    registry: REGISTRY,
    registryHash: '0123456789abcdef',
    config: DEFAULT_DOMAIN_CONFIG,
    cards,
    glossary: { path: 'docs/domain/glossary.md', items: parseGlossary('- **Fine** (context: lending): money owed\n- **Member**: a patron\n') },
    cardsHash: 'fedcba9876543210',
    indices: [...(build.indices ?? INDICES)],
    isTestFile: (path) => path.endsWith('Tests.cs'),
    ownership,
    testRefs: links(
      build.testRefs ?? [
        ref({ id: 'LEND-03', file: TEST_FILE, line: 14, kind: 'mention', symbolId: TEST_METHOD }),
        ref({ id: 'LEND-03', file: TEST_FILE, line: 11, kind: 'annotation', symbolId: TEST_METHOD, annotation: 'Trait' }),
      ],
    ),
    codeRefs: links([ref({ id: 'LEND-05', file: POLICY_FILE, line: 19, kind: 'rule-comment', symbolId: RENEW })]),
    fileExists: build.fileExists ?? ((path) => FILES.has(path)),
    split,
    dataResourceKinds,
    warn: () => undefined,
  });
  return {
    registry: REGISTRY,
    registryPath: 'docs/domain/contexts.yaml',
    config: DEFAULT_DOMAIN_CONFIG,
    ownership,
    graph,
    index: indexGraph(graph),
    staleCards: false,
    generation: 1,
  };
}

const SNAPSHOT = snapshot();

type Obj = Record<string, unknown>;
const list = (value: unknown): Obj[] => value as Obj[];

describe('domain views', () => {
  it('contextView returns the context, terms, rules with tests and code, contracts, decisions and open questions', () => {
    const view = contextView(SNAPSHOT, 'lending');

    expect(Object.keys(view)).toEqual(['context', 'terms', 'rules', 'contracts', 'decisions', 'openQuestions']);
    expect(view['context']).toEqual({ id: 'lending', name: 'Lending', rung: 'bounded', card: LENDING_CARD, rulePrefix: 'LEND', paths: ['src/lending/**'] });

    const terms = list(view['terms']);
    expect(terms.map((t) => t['term'])).toEqual(['Loan', 'Fine']);
    expect(terms[0]).toMatchObject({
      key: 'loan',
      definitions: [{ text: 'a book lent to a member', file: LENDING_CARD, line: 6, origin: 'card' }],
    });
    expect(terms[1]!['definitions']).toEqual([{ text: 'money owed', file: 'docs/domain/glossary.md', line: 1, origin: 'glossary' }]);
    expect(terms[0]!['identifierCount']).toBe((terms[0]!['identifiers'] as unknown[]).length);

    const rules = list(view['rules']);
    expect(rules.map((r) => r['ruleId'])).toEqual(['LEND-03', 'LEND-04', 'LEND-05']);
    expect(rules[0]).toEqual({
      ruleId: 'LEND-03',
      title: 'A member holds at most five loans',
      line: 9,
      tests: [
        {
          file: TEST_FILE,
          sources: [{ source: 'card-tests', file: LENDING_CARD, line: 10 }],
        },
        {
          file: TEST_FILE,
          symbolId: TEST_METHOD,
          testName: 'LoanLimitTests.RejectsTheSixthLoan',
          sources: [
            { source: 'annotation', annotation: 'Trait', file: TEST_FILE, line: 11 },
            { source: 'mention', file: TEST_FILE, line: 14 },
          ],
        },
      ],
      testCount: 2,
      code: [
        { file: POLICY_FILE, sources: [{ source: 'card-code', file: LENDING_CARD, line: 11 }] },
        { file: POLICY_FILE, symbolId: CAN_BORROW, sources: [{ source: 'card-code', file: LENDING_CARD, line: 11 }] },
      ],
      codeCount: 2,
    });
    expect(rules[1]).toMatchObject({ ruleId: 'LEND-04', untested: 'covered by manual QA until the scheduler migration lands', testCount: 0, codeCount: 1 });

    const decisions = list(view['decisions']);
    expect(decisions.map((d) => d['date'])).toEqual(['2026-10-01', '2026-09-12', '2026-04-01']);
    expect(decisions[1]).toMatchObject({ id: 'decision:lending/2026-09-12-1', rules: ['LEND-03'], card: LENDING_CARD });
    expect(view['decisionsTotal']).toBeUndefined();
    expect(view['openQuestions']).toEqual([{ text: 'Should a renewal count as a new loan?', line: 31 }]);
  });

  it('terms list at most 15 identifiers with the count', () => {
    const many = fileIndex(
      'src/lending/Generated.cs',
      Array.from({ length: 20 }, (_, i) => [`Loan${String.fromCharCode(65 + i)}x`, 'class'] as [string, string]),
    );
    const view = contextView(snapshot({ indices: [...INDICES, many] }), 'lending');
    const loan = list(view['terms']).find((t) => t['term'] === 'Loan')!;

    expect(VIEW_CAPS.identifiers).toBe(15);
    expect((loan['identifiers'] as unknown[]).length).toBe(15);
    expect(loan['identifierCount']).toBeGreaterThan(15);
  });

  it('rules list at most 10 tests and 10 code links with their counts', () => {
    const tests = Array.from({ length: 12 }, (_, i) => `\`tests/T${String(i).padStart(2, '0')}Tests.cs\``).join(', ');
    const code = Array.from({ length: 12 }, (_, i) => `\`src/lending/C${String(i).padStart(2, '0')}.cs\``).join(', ');
    const text = LENDING_TEXT.replace(`Tests: \`${TEST_FILE}\``, `Tests: ${tests}`).replace(`Code: \`${POLICY_FILE}\`, \`${CAN_BORROW}\``, `Code: ${code}`);
    const view = contextView(snapshot({ lending: text, testRefs: [], fileExists: () => true }), 'lending');
    const rule = list(view['rules'])[0]!;

    expect(VIEW_CAPS).toEqual({ identifiers: 15, testsPerRule: 10, codePerRule: 10 });
    expect((rule['tests'] as Obj[]).map((t) => t['file'])).toEqual(Array.from({ length: 10 }, (_, i) => `tests/T${String(i).padStart(2, '0')}Tests.cs`));
    expect(rule['testCount']).toBe(12);
    expect((rule['code'] as unknown[]).length).toBe(10);
    expect(rule['codeCount']).toBe(12);
  });

  it('decisions are capped at 50 with decisionsTotal', () => {
    const sixty = Array.from({ length: 60 }, (_, i) => `- 2026-01-01: LEND-03 note ${i + 1}.`).join('\n');
    const text = LENDING_TEXT.replace('## Decisions\n', `## Decisions\n${sixty}\n`);
    const snap = snapshot({ lending: text });

    const view = contextView(snap, 'lending');
    expect(list(view['decisions'])).toHaveLength(50);
    expect(view['decisionsTotal']).toBe(63);

    const rule = ruleView(snap, 'LEND-03');
    expect(list(rule['decisions'])).toHaveLength(50);
    expect(rule['decisionsTotal']).toBe(62);

    // Fewer than the cap: no total field.
    expect(ruleView(SNAPSHOT, 'LEND-03')['decisionsTotal']).toBeUndefined();
  });

  it('contracts list outbound and inbound registry contracts with the card text and references', () => {
    expect(contextView(SNAPSHOT, 'lending')['contracts']).toEqual({
      outbound: [{ target: 'billing', files: ['src/billing/ChargeService.cs'] }],
      inbound: [{ from: 'billing', files: ['src/lending/LoanApi.cs'] }],
      text: 'Lending charges fines through `src/billing/ChargeService.cs`.',
      references: ['src/billing/ChargeService.cs'],
    });
    // A card without the section: registry contracts only.
    expect(contextView(SNAPSHOT, 'billing')['contracts']).toEqual({
      outbound: [{ target: 'lending', files: ['src/lending/LoanApi.cs'] }],
      inbound: [{ from: 'lending', files: ['src/billing/ChargeService.cs'] }],
      references: [],
    });
  });

  it('a context sharing a card gets no rules and a hint naming the owner', () => {
    const view = contextView(SNAPSHOT, 'loans');

    expect(view['rules']).toEqual([]);
    expect(view['hint']).toBe(
      `The rules of ${LENDING_CARD} belong to context lending, which shares the card; use get_domain_context with path ${LENDING_CARD} for them.`,
    );
    expect(contextView(SNAPSHOT, 'lending')['hint']).toBeUndefined();
  });

  it('contextForPath resolves an owned file, a card path, an unowned file and a multiply owned file', () => {
    expect(contextForPath(SNAPSHOT, POLICY_FILE)).toEqual({ context: 'lending' });
    expect(contextForPath(SNAPSHOT, BILLING_CARD)).toEqual({ context: 'billing' });
    // The shared card selects the context that owns its rules.
    expect(contextForPath(SNAPSHOT, LENDING_CARD)).toEqual({ context: 'lending' });
    expect(contextForPath(SNAPSHOT, 'README.md')).toEqual({ hint: 'No named context owns README.md.' });
    expect(contextForPath(SNAPSHOT, 'src/lending/Old/Legacy.cs')).toEqual({
      hint: 'src/lending/Old/Legacy.cs belongs to 2 contexts (lending, archive); fix the registry, see "ctxo verify-domain".',
    });
  });

  it('contextsOverview counts rules, tested rules, terms and decisions per context', () => {
    expect(contextsOverview(SNAPSHOT)).toEqual({
      contexts: [
        { id: 'lending', name: 'Lending', rung: 'bounded', card: LENDING_CARD, ruleCount: 3, rulesWithTests: 1, termCount: 2, decisionCount: 3 },
        { id: 'billing', name: 'Billing', rung: 'pinned', card: BILLING_CARD, ruleCount: 1, rulesWithTests: 0, termCount: 0, decisionCount: 0 },
        { id: 'loans', name: 'Loans', rung: 'pinned', card: LENDING_CARD, ruleCount: 0, rulesWithTests: 0, termCount: 1, decisionCount: 3 },
        { id: 'archive', name: 'Archive', rung: 'fear', ruleCount: 0, rulesWithTests: 0, termCount: 0, decisionCount: 0 },
      ],
    });
  });

  it('ruleView returns text, context, tests with sources, symbols, decisions, provenance and unresolved references', () => {
    const view = ruleView(SNAPSHOT, 'LEND-03');

    expect(view['rule']).toEqual({
      ruleId: 'LEND-03',
      title: 'A member holds at most five loans',
      text: 'Free text written by people.',
      line: 9,
      context: { id: 'lending', name: 'Lending', rung: 'bounded' },
      card: LENDING_CARD,
    });
    expect(list(view['tests']).map((t) => (t['sources'] as Obj[]).map((s) => s['source']))).toEqual([['card-tests'], ['annotation', 'mention']]);
    expect(list(view['symbols']).map((s) => s['symbolId'] ?? s['file'])).toEqual([POLICY_FILE, CAN_BORROW]);
    expect(list(view['decisions']).map((d) => d['id'])).toEqual(['decision:lending/2026-10-01-1', 'decision:lending/2026-09-12-1']);
    // Unique by path or value: #123 appears in both decisions and is listed once, under the newest.
    expect(view['provenance']).toEqual([
      { kind: 'external', value: '#123', decision: 'decision:lending/2026-10-01-1' },
      { kind: 'file', path: 'docs/specs/loan-limit.md', exists: true, label: 'spec', decision: 'decision:lending/2026-09-12-1' },
      { kind: 'file', path: 'docs/adr/adr-007-loan-limit.md', exists: false, label: 'ADR-007', decision: 'decision:lending/2026-09-12-1' },
    ]);
    expect(view['unresolved']).toBeUndefined();

    const lend05 = ruleView(SNAPSHOT, 'LEND-05');
    expect(lend05['unresolved']).toEqual([
      { field: 'Tests', value: 'tests/Lending.Tests/Missing.cs', file: LENDING_CARD, line: 20, reason: 'missing-file' },
    ]);
    expect(list(lend05['symbols'])).toEqual([
      { file: POLICY_FILE, symbolId: RENEW, sources: [{ source: 'rule-comment', file: POLICY_FILE, line: 19 }] },
    ]);
    expect(ruleView(SNAPSHOT, 'LEND-99')).toEqual({ found: false, hint: 'No rule LEND-99 in any card.' });
  });

  it('lists sit at the top level so the envelope can truncate them', () => {
    const truncatable = ['contexts', 'terms', 'rules', 'openQuestions', 'tests', 'symbols', 'provenance', 'unresolved'];
    const arrays = (payload: Obj) => Object.keys(payload).filter((key) => Array.isArray(payload[key]));

    expect(arrays(contextView(SNAPSHOT, 'lending')).filter((key) => key !== 'decisions').every((key) => truncatable.includes(key))).toBe(true);
    expect(arrays(contextView(SNAPSHOT, 'lending'))).toEqual(['terms', 'rules', 'decisions', 'openQuestions']);
    expect(arrays(contextsOverview(SNAPSHOT))).toEqual(['contexts']);
    expect(arrays(ruleView(SNAPSHOT, 'LEND-05'))).toEqual(['tests', 'symbols', 'decisions', 'provenance', 'unresolved']);
  });
});
