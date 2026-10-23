import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@ctxo/cli/internal';
import type { CardRuleRefs } from '../domain-graph.js';
import { resolveRuleRefs, scanTestText, type RuleLinks, type RuleRef, type ScanOptions } from '../rule-id-scan.js';
import { resolveCardRef, ruleTestLinks, toLocation, type RefLookup } from '../rule-test-links.js';

const CARD = 'docs/domain/lending/domain.md';
const CS_TEST = 'tests/Lending.Tests/LoanLimitTests.cs';
const TS_TEST = 'tests/lending/loan-limit.test.ts';
const TRAIT_SYMBOL = `${CS_TEST}::LoanLimitTests.MemberHoldsAtMostFiveLoans::method`;

function options(over: Partial<ScanOptions> = {}): ScanOptions {
  return {
    rules: { ids: new Set(['LEND-03', 'LEND-04']), prefixes: new Set(['LEND']) },
    idPattern: /^[A-Z][A-Z0-9]*-\d+$/,
    trackerPrefixes: new Set(),
    ruleTraitKeys: new Set(['Rule']),
    ...over,
  };
}

function lookup(symbols: Record<string, string> = {}, files: readonly string[] = []): RefLookup {
  const known = new Set(files);
  return {
    hasSymbol: (id) => id in symbols,
    symbolName: (id) => symbols[id],
    fileExists: (path) => known.has(path),
  };
}

const LOOKUP = lookup({ [TRAIT_SYMBOL]: 'LoanLimitTests.MemberHoldsAtMostFiveLoans' }, [CS_TEST, 'src/Lending.Tests/LoanLimitTests.cs']);

function testRefs(refs: readonly RuleRef[]): RuleLinks {
  const links = new Map<string, RuleRef[]>();
  for (const ref of refs) links.set(ref.id, [...(links.get(ref.id) ?? []), ref]);
  return { links, unknown: [] };
}

function card(over: Partial<CardRuleRefs> = {}): CardRuleRefs {
  return { ruleId: 'LEND-03', card: CARD, tests: [], testsLine: 9, code: [], codeLine: 10, ...over };
}

function csIndex(): FileIndex {
  return {
    file: CS_TEST,
    lastModified: 1,
    symbols: [
      { symbolId: `${CS_TEST}::LoanLimitTests::class`, name: 'LoanLimitTests', kind: 'class', startLine: 0, endLine: 9 },
      {
        symbolId: TRAIT_SYMBOL,
        name: 'LoanLimitTests.MemberHoldsAtMostFiveLoans',
        kind: 'method',
        startLine: 2,
        endLine: 4,
        annotations: [{ name: 'Fact' }, { name: 'Trait', args: ['Rule', 'LEND-03'] }],
      },
    ],
    edges: [],
    intent: [],
    antiPatterns: [],
  };
}

describe('rule-test-links', () => {
  it('annotation, category, title, rule-comment and mention refs become rule-test links with their sources', () => {
    const refs: RuleRef[] = [
      { file: CS_TEST, line: 4, raw: 'LEND-03', id: 'LEND-03', kind: 'annotation', annotation: 'Trait', symbolId: TRAIT_SYMBOL },
      { file: CS_TEST, line: 12, raw: 'LEND-04', id: 'LEND-04', kind: 'category', annotation: 'TestCategory', symbolId: 'cat' },
      { file: TS_TEST, line: 3, raw: 'LEND-03', id: 'LEND-03', kind: 'test-title', testTitle: 'LEND-03 rejects the sixth loan' },
      { file: TS_TEST, line: 7, raw: 'LEND-04', id: 'LEND-04', kind: 'rule-comment', symbolId: 'fn' },
      { file: TS_TEST, line: 20, raw: 'LEND-03', id: 'LEND-03', kind: 'mention' },
    ];
    const { links, unresolved } = ruleTestLinks({ cardRefs: [], testRefs: testRefs(refs), lookup: LOOKUP });
    expect(unresolved).toEqual([]);
    expect(links).toEqual([
      {
        kind: 'rule-test',
        from: 'rule:LEND-03',
        to: { file: CS_TEST, symbolId: TRAIT_SYMBOL },
        source: 'annotation',
        at: { file: CS_TEST, line: 4 },
        annotation: 'Trait',
        testName: 'LoanLimitTests.MemberHoldsAtMostFiveLoans',
      },
      {
        kind: 'rule-test',
        from: 'rule:LEND-03',
        to: { file: TS_TEST },
        source: 'test-title',
        at: { file: TS_TEST, line: 3 },
        testName: 'LEND-03 rejects the sixth loan',
      },
      { kind: 'rule-test', from: 'rule:LEND-03', to: { file: TS_TEST }, source: 'mention', at: { file: TS_TEST, line: 20 } },
      {
        kind: 'rule-test',
        from: 'rule:LEND-04',
        to: { file: CS_TEST, symbolId: 'cat' },
        source: 'category',
        at: { file: CS_TEST, line: 12 },
        annotation: 'TestCategory',
      },
      { kind: 'rule-test', from: 'rule:LEND-04', to: { file: TS_TEST, symbolId: 'fn' }, source: 'rule-comment', at: { file: TS_TEST, line: 7 } },
    ]);
  });

  it('a Trait link names the test by its symbol and a title link by its title', () => {
    const o = options();
    const text = ['public class LoanLimitTests', '{', '    [Fact]', '    [Trait("Rule", "LEND-03")]', '    public void MemberHoldsAtMostFiveLoans() {}', '}'].join('\n');
    const csRefs = scanTestText(CS_TEST, text, csIndex(), o);
    const tsRefs = scanTestText(TS_TEST, `it('LEND-03 rejects the sixth loan', () => {});\n`, undefined, o);
    const { links } = ruleTestLinks({ cardRefs: [], testRefs: resolveRuleRefs([...csRefs, ...tsRefs], o), lookup: LOOKUP });
    const names = links.map((l) => (l.kind === 'rule-test' ? [l.source, l.testName] : []));
    expect(names).toEqual([
      ['annotation', 'LoanLimitTests.MemberHoldsAtMostFiveLoans'],
      ['test-title', 'LEND-03 rejects the sixth loan'],
    ]);
  });

  it('a card Tests: path links the rule to the file with source card-tests', () => {
    const value = 'src/Lending.Tests/LoanLimitTests.cs';
    const { links, unresolved } = ruleTestLinks({ cardRefs: [card({ tests: [value] })], testRefs: testRefs([]), lookup: LOOKUP });
    expect(unresolved).toEqual([]);
    expect(links).toEqual([
      { kind: 'rule-test', from: 'rule:LEND-03', to: { file: value }, source: 'card-tests', at: { file: CARD, line: 9 } },
    ]);
  });

  it('a card Tests: symbol ID in the index links to the symbol', () => {
    const { links } = ruleTestLinks({ cardRefs: [card({ tests: [TRAIT_SYMBOL] })], testRefs: testRefs([]), lookup: LOOKUP });
    expect(links).toEqual([
      {
        kind: 'rule-test',
        from: 'rule:LEND-03',
        to: { file: CS_TEST, symbolId: TRAIT_SYMBOL },
        source: 'card-tests',
        at: { file: CARD, line: 9 },
        testName: 'LoanLimitTests.MemberHoldsAtMostFiveLoans',
      },
    ]);
  });

  it('a Tests: symbol ID missing from the index links to its file and is recorded as not-a-symbol', () => {
    const value = 'tests/Lending.Tests/LoanLimitTests.cs::LoanLimitTests.Gone::method';
    const { links, unresolved } = ruleTestLinks({ cardRefs: [card({ tests: [value] })], testRefs: testRefs([]), lookup: LOOKUP });
    expect(links).toEqual([
      { kind: 'rule-test', from: 'rule:LEND-03', to: { file: CS_TEST }, source: 'card-tests', at: { file: CARD, line: 9 }, fallback: true },
    ]);
    expect(unresolved).toEqual([{ rule: 'LEND-03', field: 'Tests', value, at: { file: CARD, line: 9 }, reason: 'not-a-symbol' }]);
  });

  it('a Tests: path that does not exist links nothing and is recorded as missing-file', () => {
    const values = ['tests/Nope.cs', 'tests/Nope.cs::Nope::method'];
    const { links, unresolved } = ruleTestLinks({ cardRefs: [card({ tests: values })], testRefs: testRefs([]), lookup: LOOKUP });
    expect(links).toEqual([]);
    expect(unresolved).toEqual(
      values.map((value) => ({ rule: 'LEND-03', field: 'Tests', value, at: { file: CARD, line: 9 }, reason: 'missing-file' })),
    );
  });

  it('with LEND as a tracker prefix, a LEND-03 mention does not link but a Trait does', () => {
    const o = options({ trackerPrefixes: new Set(['LEND']) });
    const text = ['public class LoanLimitTests', '{', '    [Fact]', '    [Trait("Rule", "LEND-03")]', '    public void MemberHoldsAtMostFiveLoans() {}', '}', '', '// see LEND-03'].join('\n');
    const refs = scanTestText(CS_TEST, text, csIndex(), o);
    expect(refs.some((r) => r.kind === 'mention')).toBe(true);
    const { links } = ruleTestLinks({ cardRefs: [], testRefs: resolveRuleRefs(refs, o), lookup: LOOKUP });
    expect(links.map((l) => l.source)).toEqual(['annotation']);
  });

  it('links carry 1-based lines: a ref at line 9 keeps at.line 9', () => {
    expect(toLocation(TS_TEST, 9)).toEqual({ file: TS_TEST, line: 9 });
    const ref: RuleRef = { file: TS_TEST, line: 9, raw: 'LEND-03', id: 'LEND-03', kind: 'mention' };
    const { links } = ruleTestLinks({ cardRefs: [], testRefs: testRefs([ref]), lookup: LOOKUP });
    expect(links.map((l) => ('at' in l ? l.at.line : undefined))).toEqual([9]);
  });

  it('the same evidence links once', () => {
    const ref: RuleRef = { file: TS_TEST, line: 9, raw: 'LEND-03', id: 'LEND-03', kind: 'rule-comment', symbolId: 'fn' };
    const value = 'src/Lending.Tests/LoanLimitTests.cs';
    const { links, unresolved } = ruleTestLinks({
      cardRefs: [card({ tests: [value, `./${value}`, value.replace(/\//g, '\\')] })],
      testRefs: testRefs([ref, { ...ref, raw: 'lend_03' }]),
      lookup: LOOKUP,
    });
    expect(unresolved).toEqual([]);
    expect(links.map((l) => l.source)).toEqual(['rule-comment', 'card-tests']);
  });

  it('resolveCardRef normalises separators, drops ./ and ends the file part at :: or # (P5)', () => {
    expect(resolveCardRef('.\\src\\Lending.Tests\\LoanLimitTests.cs', LOOKUP)).toEqual({ target: { file: 'src/Lending.Tests/LoanLimitTests.cs' } });
    expect(resolveCardRef(`${CS_TEST}#MemberHoldsAtMostFiveLoans`, LOOKUP)).toEqual({ target: { file: CS_TEST } });
    expect(resolveCardRef('tests/Nope.cs#X', LOOKUP)).toEqual({ problem: 'missing-file' });
    expect(resolveCardRef(`./${TRAIT_SYMBOL}`, LOOKUP)).toEqual({ target: { file: CS_TEST, symbolId: TRAIT_SYMBOL } });
    expect(resolveCardRef(`${CS_TEST}::Other::method`, LOOKUP)).toEqual({ target: { file: CS_TEST }, problem: 'not-a-symbol' });
  });
});
