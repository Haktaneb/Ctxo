import { describe, it, expect } from 'vitest';
import { parseCard, parseGlossary } from '../card-parser.js';
import {
  buildGraphNodes,
  cardsHash,
  contextNodeId,
  decisionNodeId,
  DOMAIN_GRAPH_ARTIFACT,
  REPO_WIDE_CONTEXT,
  ruleNodeId,
  sortGraph,
  termKey,
  termNodeId,
  type CardInput,
  type DomainGraph,
  type DomainLink,
} from '../domain-graph.js';
import type { DomainContext, DomainRegistry } from '../registry.js';

const CARD_PATH = 'docs/domain/lending/domain.md';

const SPEC_CARD = [
  '# Lending',
  '',
  '## Language',
  '- **Loan**: ...',
  '- **Hold**: ...',
  '',
  '## Rules and invariants',
  '### LEND-03 A member holds at most five loans',
  'Tests: `src/Lending.Tests/LoanLimitTests.cs`',
  'Code: `src/Lending/LoanPolicy.cs`, `src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method`',
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
  '- 2026-09-12: Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
  '',
  '## Open questions',
  '- ...',
  '',
].join('\n');

function context(id: string, extra: Partial<DomainContext> = {}): DomainContext {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), paths: [`src/${id}/**`], rung: 'pinned', contracts: {}, ...extra };
}

const LENDING = context('lending', { card: CARD_PATH, rulePrefix: 'LEND' });
const BILLING = context('billing', { card: 'docs/domain/billing/domain.md', rulePrefix: 'BILL' });

function registry(...contexts: DomainContext[]): DomainRegistry {
  return { version: 1, contexts, unownedAllow: [], glossary: 'docs/domain/glossary.md', contextMap: 'docs/domain/context-map.md' };
}

function cardInput(ctx: DomainContext, text: string | undefined, path = ctx.card!): CardInput {
  return text === undefined ? { context: ctx, path } : { context: ctx, path, card: parseCard(text) };
}

function glossary(text: string) {
  return { path: 'docs/domain/glossary.md', items: parseGlossary(text) };
}

describe('domain graph nodes', () => {
  it('node IDs follow the spec formats', () => {
    expect(DOMAIN_GRAPH_ARTIFACT).toBe('domain-graph');
    expect(REPO_WIDE_CONTEXT).toBe('*');
    expect(contextNodeId('lending')).toBe('context:lending');
    expect(ruleNodeId('LEND-03')).toBe('rule:LEND-03');
    expect(termKey('  Member \t  account ')).toBe('member-account');
    expect(termNodeId('lending', 'Member account')).toBe('term:lending/member-account');
    expect(termNodeId(REPO_WIDE_CONTEXT, 'Loan')).toBe('term:*/loan');
    expect(decisionNodeId('lending', '2026-09-12', 2)).toBe('decision:lending/2026-09-12-2');
  });

  it('builds nodes from the spec card and a glossary', () => {
    const nodes = buildGraphNodes({
      registry: registry(LENDING),
      cards: [cardInput(LENDING, SPEC_CARD)],
      glossary: glossary('- **Member**: a registered patron'),
    });
    expect(nodes.contexts).toEqual([
      { id: 'context:lending', context: 'lending', name: 'Lending', rung: 'pinned', card: CARD_PATH, rulePrefix: 'LEND' },
    ]);
    expect(nodes.rules).toEqual([
      {
        id: 'rule:LEND-03',
        ruleId: 'LEND-03',
        context: 'lending',
        card: CARD_PATH,
        title: 'A member holds at most five loans',
        line: 8,
        text: 'Free text written by people.',
      },
      {
        id: 'rule:LEND-04',
        ruleId: 'LEND-04',
        context: 'lending',
        card: CARD_PATH,
        title: 'A hold expires after seven days',
        line: 14,
        text: '',
        untested: 'covered by manual QA until the scheduler migration lands',
      },
    ]);
    expect(nodes.terms.map((t) => t.id)).toEqual(['term:lending/loan', 'term:lending/hold', 'term:*/member']);
    expect(nodes.terms[0]).toEqual({
      id: 'term:lending/loan',
      context: 'lending',
      key: 'loan',
      term: 'Loan',
      definitions: [{ text: '...', at: { file: CARD_PATH, line: 4 }, origin: 'card' }],
      identifierCount: 0,
    });
    expect(nodes.terms[2]).toEqual({
      id: 'term:*/member',
      context: '*',
      key: 'member',
      term: 'Member',
      definitions: [{ text: 'a registered patron', at: { file: 'docs/domain/glossary.md', line: 1 }, origin: 'glossary' }],
      identifierCount: 0,
    });
    expect(nodes.decisions).toEqual([
      {
        id: 'decision:lending/2026-09-12-1',
        context: 'lending',
        card: CARD_PATH,
        date: '2026-09-12',
        n: 1,
        line: 21,
        text: 'Loan limit raised from 3 to 5. [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)',
      },
    ]);
    expect(nodes.parsedDecisions.get('decision:lending/2026-09-12-1')?.externalRefs).toEqual(['#123']);
    expect(nodes.sections).toEqual([
      {
        id: `section:${CARD_PATH}:17`,
        context: 'lending',
        card: CARD_PATH,
        heading: 'Boundary contracts',
        kind: 'contracts',
        line: 17,
        text: 'Free text; references to contract files.',
        references: [],
      },
      {
        id: `section:${CARD_PATH}:23`,
        context: 'lending',
        card: CARD_PATH,
        heading: 'Open questions',
        kind: 'open-questions',
        line: 23,
        text: '- ...',
      },
    ]);
    expect(nodes.openQuestions).toEqual([{ context: 'lending', card: CARD_PATH, line: 24, text: '...' }]);
    expect(nodes.cardRefs[0]).toEqual({
      ruleId: 'LEND-03',
      card: CARD_PATH,
      tests: ['src/Lending.Tests/LoanLimitTests.cs'],
      testsLine: 9,
      code: ['src/Lending/LoanPolicy.cs', 'src/Lending/LoanPolicy.cs::LoanPolicy.CanBorrow::method'],
      codeLine: 10,
    });
    // A rule without rule lines falls back to its heading line.
    expect(nodes.cardRefs[1]).toEqual({ ruleId: 'LEND-04', card: CARD_PATH, tests: [], testsLine: 14, code: [], codeLine: 14 });
  });

  it('builds intro and other sections, with contract references', () => {
    const text = [
      '# Lending',
      'Lending owns loans.',
      '',
      '## Language',
      '## Rules and invariants',
      '## Boundary contracts',
      'See `contracts/loan.json`.',
      '## Decisions',
      '## Open questions',
      '## Glossary notes',
      'Extra text.',
    ].join('\n');
    const nodes = buildGraphNodes({ registry: registry(LENDING), cards: [cardInput(LENDING, text)] });
    expect(nodes.sections.map((s) => [s.id, s.kind, s.heading, s.text, s.references])).toEqual([
      [`section:${CARD_PATH}:1`, 'intro', 'Lending', 'Lending owns loans.', undefined],
      [`section:${CARD_PATH}:6`, 'contracts', 'Boundary contracts', 'See `contracts/loan.json`.', ['contracts/loan.json']],
      [`section:${CARD_PATH}:9`, 'open-questions', 'Open questions', '', undefined],
      [`section:${CARD_PATH}:10`, 'other', 'Glossary notes', 'Extra text.', undefined],
    ]);
  });

  it('decisions on the same date are numbered in document order', () => {
    const text = [
      '# Lending',
      '## Decisions',
      '- 2026-09-12: first',
      '- 2026-10-01: other day',
      '- 2026-09-12: second',
      '- 2026-09-12: third',
    ].join('\n');
    const nodes = buildGraphNodes({ registry: registry(LENDING), cards: [cardInput(LENDING, text)] });
    expect(nodes.decisions.map((d) => [d.id, d.n, d.line, d.text])).toEqual([
      ['decision:lending/2026-09-12-1', 1, 3, 'first'],
      ['decision:lending/2026-10-01-1', 1, 4, 'other day'],
      ['decision:lending/2026-09-12-2', 2, 5, 'second'],
      ['decision:lending/2026-09-12-3', 3, 6, 'third'],
    ]);
    expect([...nodes.parsedDecisions.keys()]).toEqual(nodes.decisions.map((d) => d.id));
    expect(nodes.parsedDecisions.get('decision:lending/2026-09-12-2')?.text).toBe('second');
  });

  it("a glossary item for a context merges into that context's card term", () => {
    const text = ['# Lending', '## Language', '- **Member account**: the card view'].join('\n');
    const nodes = buildGraphNodes({
      registry: registry(LENDING),
      cards: [cardInput(LENDING, text)],
      glossary: glossary('- **member  ACCOUNT** (context: lending): the glossary view'),
    });
    expect(nodes.terms).toEqual([
      {
        id: 'term:lending/member-account',
        context: 'lending',
        key: 'member-account',
        term: 'Member account',
        definitions: [
          { text: 'the card view', at: { file: CARD_PATH, line: 3 }, origin: 'card' },
          { text: 'the glossary view', at: { file: 'docs/domain/glossary.md', line: 1 }, origin: 'glossary' },
        ],
        identifierCount: 0,
      },
    ]);
  });

  it('card definitions come before glossary definitions even when the glossary is read first', () => {
    const text = ['# Lending', '## Language', '- **Loan**: card one', '- **Loan**: card two'].join('\n');
    const nodes = buildGraphNodes({
      registry: registry(LENDING),
      cards: [cardInput(LENDING, text)],
      glossary: glossary('- **loan** (context: lending): glossary one'),
    });
    expect(nodes.terms).toHaveLength(1);
    expect(nodes.terms[0]!.term).toBe('Loan');
    expect(nodes.terms[0]!.definitions.map((d) => [d.text, d.origin])).toEqual([
      ['card one', 'card'],
      ['card two', 'card'],
      ['glossary one', 'glossary'],
    ]);
  });

  it('a glossary item without a context is repo-wide, and an unknown context warns and is repo-wide', () => {
    const warnings: string[] = [];
    const nodes = buildGraphNodes({
      registry: registry(LENDING),
      cards: [],
      glossary: glossary(['- **Patron**: a person', '- **Fine** (context: billing): money owed', '- **patron** (context: nope): again'].join('\n')),
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([
      'docs/domain/glossary.md:2 names unknown context "billing"',
      'docs/domain/glossary.md:3 names unknown context "nope"',
    ]);
    expect(nodes.terms.map((t) => [t.id, t.context, t.term, t.definitions.length])).toEqual([
      ['term:*/patron', '*', 'Patron', 2],
      ['term:*/fine', '*', 'Fine', 1],
    ]);
  });

  it('a duplicate rule ID keeps the first card and warns', () => {
    const lendingText = ['# Lending', '## Rules and invariants', '', '### LEND-03 From lending', 'Body.'].join('\n');
    const billingText = ['# Billing', '## Rules and invariants', '### LEND-03 From billing'].join('\n');
    const warnings: string[] = [];
    // Lending comes first in the input, but docs/domain/billing sorts before docs/domain/lending: the card path decides.
    const nodes = buildGraphNodes({
      registry: registry(LENDING, BILLING),
      cards: [cardInput(LENDING, lendingText), cardInput(BILLING, billingText)],
      warn: (message) => warnings.push(message),
    });
    expect(nodes.rules.map((r) => [r.id, r.context, r.title])).toEqual([['rule:LEND-03', 'billing', 'From billing']]);
    expect(nodes.cardRefs.map((r) => [r.ruleId, r.card])).toEqual([['LEND-03', 'docs/domain/billing/domain.md']]);
    expect(warnings).toEqual(['rule LEND-03 is defined in docs/domain/billing/domain.md and docs/domain/lending/domain.md; keeping the first']);
  });

  it('a duplicate rule ID within one card keeps the first line', () => {
    const text = ['# Lending', '## Rules and invariants', '### LEND-03 First', '### LEND-03 Second'].join('\n');
    const warnings: string[] = [];
    const nodes = buildGraphNodes({ registry: registry(LENDING), cards: [cardInput(LENDING, text)], warn: (m) => warnings.push(m) });
    expect(nodes.rules.map((r) => [r.title, r.line])).toEqual([['First', 3]]);
    expect(warnings).toEqual([`rule LEND-03 is defined in ${CARD_PATH} and ${CARD_PATH}; keeping the first`]);
  });

  it('a context without a card, or whose card file is missing, has no rules', () => {
    const reporting = context('reporting', { rung: 'fear' });
    const nodes = buildGraphNodes({ registry: registry(LENDING, reporting), cards: [cardInput(LENDING, undefined)] });
    expect(nodes.contexts).toEqual([
      { id: 'context:lending', context: 'lending', name: 'Lending', rung: 'pinned', card: CARD_PATH, rulePrefix: 'LEND' },
      { id: 'context:reporting', context: 'reporting', name: 'Reporting', rung: 'fear' },
    ]);
    expect(nodes.rules).toEqual([]);
    expect(nodes.terms).toEqual([]);
    expect(nodes.decisions).toEqual([]);
    expect(nodes.sections).toEqual([]);
    expect(nodes.openQuestions).toEqual([]);
    expect(nodes.cardRefs).toEqual([]);
    expect(nodes.parsedDecisions.size).toBe(0);
  });

  it('contexts keep registry order', () => {
    const nodes = buildGraphNodes({ registry: registry(LENDING, BILLING), cards: [] });
    expect(nodes.contexts.map((c) => c.id)).toEqual(['context:lending', 'context:billing']);
  });

  it('the same input twice gives identical nodes', () => {
    const build = () =>
      buildGraphNodes({
        registry: registry(LENDING),
        cards: [cardInput(LENDING, SPEC_CARD)],
        glossary: glossary('- **Member**: a registered patron'),
      });
    const a = build();
    const b = build();
    const json = (n: ReturnType<typeof build>) => JSON.stringify({ ...n, parsedDecisions: [...n.parsedDecisions] });
    expect(json(a)).toBe(json(b));
  });
});

describe('cardsHash', () => {
  it('cardsHash ignores CRLF and a BOM and changes with any card text', () => {
    const a = { path: 'docs/domain/a.md', text: '# A\nline\n' };
    const b = { path: 'docs/domain/b.md', text: '# B\n' };
    const base = cardsHash([a, b]);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(cardsHash([b, a])).toBe(base);
    expect(cardsHash([{ path: a.path, text: String.fromCharCode(0xfeff) + '# A\r\nline\r\n' }, b])).toBe(base);
    expect(cardsHash([{ path: a.path, text: '# A\nline!\n' }, b])).not.toBe(base);
    expect(cardsHash([a, { path: b.path }])).not.toBe(base);
    expect(cardsHash([a, { path: b.path }])).toBe(cardsHash([a, { path: b.path, text: '<missing>' }]));
    expect(cardsHash([a])).not.toBe(base);
    expect(cardsHash([])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('sortGraph', () => {
  function shuffled<T>(items: readonly T[], seed: number): T[] {
    const out = [...items];
    let state = seed;
    for (let i = out.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const j = state % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  const at = (line: number) => ({ file: CARD_PATH, line });
  const LINKS: DomainLink[] = [
    { kind: 'rule-test', from: 'rule:LEND-03', to: { file: 'src/b.test.ts' }, source: 'card-tests', at: at(9) },
    { kind: 'rule-test', from: 'rule:LEND-03', to: { file: 'src/a.test.ts', symbolId: 'src/a.test.ts::x::function' }, source: 'mention', at: { file: 'src/a.test.ts', line: 4 } },
    { kind: 'rule-test', from: 'rule:LEND-03', to: { file: 'src/a.test.ts', symbolId: 'src/a.test.ts::x::function' }, source: 'mention', at: { file: 'src/a.test.ts', line: 2 } },
    { kind: 'rule-symbol', from: 'rule:LEND-03', to: { file: 'src/Lending/LoanPolicy.cs' }, source: 'card-code', at: at(10) },
    { kind: 'decision-provenance', from: 'decision:lending/2026-09-12-1', to: { kind: 'external', value: '#123' }, source: 'card-text', at: at(21) },
    { kind: 'decision-provenance', from: 'decision:lending/2026-09-12-1', to: { kind: 'file', path: 'specs/loan-limit.md', exists: true }, source: 'card-link', at: at(21), label: 'spec' },
    { kind: 'decision-rule', from: 'decision:lending/2026-09-12-1', to: 'rule:LEND-03', source: 'card-text', at: at(21) },
    { kind: 'term-identifier', from: 'term:lending/loan', to: { file: 'src/Lending/Loan.cs', symbolId: 'src/Lending/Loan.cs::Loan::class' }, source: 'symbol-name', match: 'exact' },
    { kind: 'term-identifier', from: 'term:lending/loan', to: { file: 'src/Lending/LoanPolicy.cs', symbolId: 'src/Lending/LoanPolicy.cs::LoanPolicy::class' }, source: 'symbol-name', match: 'partial' },
  ];

  function graph(seed: number): DomainGraph {
    const nodes = buildGraphNodes({
      registry: registry(LENDING, BILLING),
      cards: [
        cardInput(LENDING, SPEC_CARD),
        cardInput(BILLING, ['# Billing', 'Billing intro.', '## Rules and invariants', '### BILL-01 Fines accrue daily', '## Open questions', '- why?'].join('\n')),
      ],
      glossary: glossary('- **Member**: a registered patron'),
    });
    return {
      ctxoArtifact: 'domain-graph',
      version: 1,
      registryHash: '0123456789abcdef',
      cardsHash: 'fedcba9876543210',
      contexts: shuffled(nodes.contexts, seed),
      rules: shuffled(nodes.rules, seed + 1),
      terms: shuffled(nodes.terms, seed + 2),
      decisions: shuffled(nodes.decisions, seed + 3),
      sections: shuffled(nodes.sections, seed + 4),
      openQuestions: shuffled(nodes.openQuestions, seed + 5),
      links: shuffled(LINKS, seed + 6),
      unresolved: shuffled(
        [
          { rule: 'LEND-03', field: 'Tests', value: 'src/missing.ts', at: at(9), reason: 'missing-file' },
          { rule: 'LEND-03', field: 'Code', value: 'src/x.cs::X::class', at: at(10), reason: 'not-a-symbol' },
          { rule: 'BILL-01', field: 'Code', value: 'src/y.cs', at: at(4), reason: 'missing-file' },
        ] as const,
        seed + 7,
      ),
    };
  }

  it('sortGraph gives identical JSON for shuffled input', () => {
    const first = JSON.stringify(sortGraph(graph(1)));
    for (const seed of [2, 7, 42, 1234]) expect(JSON.stringify(sortGraph(graph(seed)))).toBe(first);
    const sorted = sortGraph(graph(3));
    expect(sorted.contexts.map((c) => c.id)).toEqual(['context:billing', 'context:lending']);
    expect(sorted.rules.map((r) => r.id)).toEqual(['rule:BILL-01', 'rule:LEND-03', 'rule:LEND-04']);
    expect(sorted.terms.map((t) => t.id)).toEqual(['term:*/member', 'term:lending/hold', 'term:lending/loan']);
    expect(sorted.sections.map((s) => s.id)).toEqual([
      'section:docs/domain/billing/domain.md:1',
      'section:docs/domain/billing/domain.md:5',
      `section:${CARD_PATH}:17`,
      `section:${CARD_PATH}:23`,
    ]);
    expect(sorted.openQuestions.map((q) => [q.card, q.line])).toEqual([
      ['docs/domain/billing/domain.md', 6],
      [CARD_PATH, 24],
    ]);
    expect(sorted.links.map((l) => [l.kind, 'source' in l ? l.source : '', 'at' in l ? l.at.line : 0])).toEqual([
      ['decision-provenance', 'card-text', 21],
      ['decision-provenance', 'card-link', 21],
      ['decision-rule', 'card-text', 21],
      ['rule-symbol', 'card-code', 10],
      ['rule-test', 'mention', 2],
      ['rule-test', 'mention', 4],
      ['rule-test', 'card-tests', 9],
      ['term-identifier', 'symbol-name', 0],
      ['term-identifier', 'symbol-name', 0],
    ]);
    expect(sorted.unresolved.map((u) => [u.rule, u.field])).toEqual([
      ['BILL-01', 'Code'],
      ['LEND-03', 'Code'],
      ['LEND-03', 'Tests'],
    ]);
    expect(Object.keys(sorted)).toEqual([
      'ctxoArtifact',
      'version',
      'registryHash',
      'cardsHash',
      'contexts',
      'rules',
      'terms',
      'decisions',
      'sections',
      'openQuestions',
      'links',
      'unresolved',
    ]);
  });

  it('sortGraph does not mutate its input', () => {
    const input = graph(5);
    const before = JSON.stringify(input);
    sortGraph(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
