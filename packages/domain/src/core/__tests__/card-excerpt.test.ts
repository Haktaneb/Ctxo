import { describe, expect, it } from 'vitest';
import {
  buildCardExcerpt,
  EXCERPT_CONTRACTS_TEXT_MAX,
  EXCERPT_DEFINITION_MAX,
  EXCERPT_RULE_TEXT_MAX,
  targetExcerptTokens,
} from '../card-excerpt.js';
import { estimateTokens } from '../token-estimate.js';
import {
  CHARGE,
  FINES,
  LENDING_CARD,
  LENDING_FIXTURE,
  LENDING_TEXT,
  LOOSE,
  RENEW,
  ROOT,
  SEND,
  fixtureSnapshot,
  type FixtureInput,
} from './lending-graph.fixture.js';

const SNAPSHOT = fixtureSnapshot();

describe('buildCardExcerpt', () => {
  it('exports the caps', () => {
    expect([EXCERPT_RULE_TEXT_MAX, EXCERPT_DEFINITION_MAX, EXCERPT_CONTRACTS_TEXT_MAX]).toEqual([600, 200, 400]);
  });

  it("the excerpt holds the target's rules, terms and contracts and stays within the budget", () => {
    const excerpt = buildCardExcerpt(SNAPSHOT, ROOT, [], 2000);
    expect(excerpt.context).toBe('lending');
    expect(excerpt.card).toBe(LENDING_CARD);
    expect(excerpt.rules).toEqual([
      { ruleId: 'LEND-03', title: 'A member holds at most five loans', linkedTo: 'target', text: expect.stringContaining('Five is the limit.') },
    ]);
    expect(excerpt.terms.map((t) => t.term)).toEqual(['Loan', 'Member account', 'Fine']);
    expect(excerpt.terms[0]).toEqual({ term: 'Loan', definition: 'a book lent to a member' });
    expect(excerpt.contracts).toEqual({
      outbound: [{ target: 'billing', files: ['src/Billing/Api/**'] }],
      text: 'Lending calls Billing only through `src/Billing/Api/`.',
    });
    expect(excerpt.omitted).toBe(0);

    // tokens is the wrapper plus each entry, and never more than the budget.
    const wrapper = estimateTokens({ context: 'lending', card: LENDING_CARD, rules: [], terms: [], tokens: 0, omitted: 0 });
    const entries = [...excerpt.rules, ...excerpt.terms, excerpt.contracts].reduce((sum, e) => sum + estimateTokens(e), 0);
    expect(excerpt.tokens).toBe(wrapper + entries);
    expect(excerpt.tokens).toBeLessThanOrEqual(2000);
  });

  it('neighbour rules follow the target rules without text', () => {
    const excerpt = buildCardExcerpt(SNAPSHOT, ROOT, [RENEW, CHARGE, ROOT], 2000);
    expect(excerpt.rules).toEqual([
      { ruleId: 'LEND-03', title: 'A member holds at most five loans', linkedTo: 'target', text: expect.any(String) },
      { ruleId: 'LEND-04', title: 'A member with an unpaid fine cannot borrow', linkedTo: 'neighbour' },
      { ruleId: 'LEND-05', title: 'A loan can be renewed twice', linkedTo: 'neighbour' },
    ]);
  });

  it('terms linked to the target or a neighbour come first, then card order', () => {
    const excerpt = buildCardExcerpt(SNAPSHOT, ROOT, [FINES], 2000);
    expect(excerpt.terms.map((t) => t.term)).toEqual(['Fine', 'Loan', 'Member account']);
  });

  it('entries that do not fit are counted in omitted', () => {
    const excerpt = buildCardExcerpt(SNAPSHOT, ROOT, [RENEW], 60);
    expect(excerpt.tokens).toBeLessThanOrEqual(60);
    const kept = excerpt.rules.length + excerpt.terms.length + (excerpt.contracts === undefined ? 0 : 1);
    // 2 rules, 3 terms and the contracts were candidates.
    expect(kept + excerpt.omitted).toBe(6);
    expect(excerpt.omitted).toBeGreaterThan(0);
    // Greedy: a later, smaller entry still fits after a larger one was skipped.
    const unlimited = buildCardExcerpt(SNAPSHOT, ROOT, [RENEW], Number.POSITIVE_INFINITY);
    expect(unlimited.omitted).toBe(0);
    expect(unlimited.tokens).toBeGreaterThan(60);
  });

  it('a wrapper larger than the budget keeps nothing and reports every entry as omitted', () => {
    const excerpt = buildCardExcerpt(SNAPSHOT, ROOT, [], 5);
    expect(excerpt.rules).toEqual([]);
    expect(excerpt.terms).toEqual([]);
    expect(excerpt.contracts).toBeUndefined();
    expect(excerpt.omitted).toBe(5);
  });

  it('a target outside every context gets rules only through links', () => {
    const fixture: FixtureInput = {
      ...LENDING_FIXTURE,
      cards: { ...LENDING_FIXTURE.cards, [LENDING_CARD]: LENDING_TEXT.replace(`Code: \`${'src/Lending/Fines.cs'}\``, `Code: \`${LOOSE}\``) },
      indices: [
        ...LENDING_FIXTURE.indices!,
        { file: 'src/Loose.cs', lastModified: 1, symbols: [{ symbolId: LOOSE, name: 'Loose', kind: 'class', startLine: 0, endLine: 3 }], edges: [], intent: [], antiPatterns: [] },
      ],
    };
    const excerpt = buildCardExcerpt(fixtureSnapshot(fixture), LOOSE, [], 2000);
    expect(excerpt).not.toHaveProperty('context');
    expect(excerpt).not.toHaveProperty('card');
    expect(excerpt.rules.map((r) => [r.ruleId, r.linkedTo])).toEqual([['LEND-04', 'target']]);
    expect(excerpt.terms).toEqual([]);
    expect(excerpt.contracts).toBeUndefined();
  });

  it('cuts long texts with ... at their caps', () => {
    const long = 'x'.repeat(700);
    const fixture: FixtureInput = {
      ...LENDING_FIXTURE,
      cards: {
        ...LENDING_FIXTURE.cards,
        [LENDING_CARD]: LENDING_TEXT.replace('Five is the limit.', long)
          .replace('a book lent to a member', 'y'.repeat(300))
          .replace('Lending calls Billing only through `src/Billing/Api/`.', 'z'.repeat(500)),
      },
    };
    const excerpt = buildCardExcerpt(fixtureSnapshot(fixture), ROOT, [], 10_000);
    const text = excerpt.rules[0]!.text!;
    expect(text).toHaveLength(EXCERPT_RULE_TEXT_MAX);
    expect(text.endsWith('...')).toBe(true);
    expect(excerpt.terms[0]!.definition).toHaveLength(EXCERPT_DEFINITION_MAX);
    expect(excerpt.terms[0]!.definition.endsWith('...')).toBe(true);
    expect(excerpt.contracts!.text).toHaveLength(EXCERPT_CONTRACTS_TEXT_MAX);
    expect(excerpt.contracts!.text!.endsWith('...')).toBe(true);
  });

  it('joins several definitions of a term with " / "', () => {
    const fixture: FixtureInput = {
      ...LENDING_FIXTURE,
      cards: { ...LENDING_FIXTURE.cards, [LENDING_CARD]: LENDING_TEXT.replace('## Rules', '- **Fine**: a late fee\n\n## Rules') },
    };
    const excerpt = buildCardExcerpt(fixtureSnapshot(fixture), ROOT, [], 10_000);
    expect(excerpt.terms.find((t) => t.term === 'Fine')?.definition).toBe('a late fee / money owed for a late return');
  });

  it('targetExcerptTokens equals the unlimited excerpt for the target alone', () => {
    expect(targetExcerptTokens(SNAPSHOT, ROOT)).toBe(buildCardExcerpt(SNAPSHOT, ROOT, [], Number.POSITIVE_INFINITY).tokens);
    expect(targetExcerptTokens(SNAPSHOT, SEND)).toBe(buildCardExcerpt(SNAPSHOT, SEND, [], Number.POSITIVE_INFINITY).tokens);
    expect(targetExcerptTokens(SNAPSHOT, ROOT)).toBeGreaterThan(0);
  });
});
