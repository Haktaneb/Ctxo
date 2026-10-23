import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@ctxo/cli/internal';
import type { CardRuleRefs } from '../domain-graph.js';
import { resolveRuleRefs, scanRuleComments, type RuleLinks, type ScanOptions } from '../rule-id-scan.js';
import { ruleSymbolLinks } from '../rule-symbol-links.js';
import type { RefLookup } from '../rule-test-links.js';

const CARD = 'docs/domain/lending/domain.md';
const POLICY = 'src/Lending/LoanPolicy.cs';
const CAN_BORROW = `${POLICY}::LoanPolicy.CanBorrow::method`;

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

const NO_CODE_REFS: RuleLinks = { links: new Map(), unknown: [] };

function card(over: Partial<CardRuleRefs> = {}): CardRuleRefs {
  return { ruleId: 'LEND-03', card: CARD, tests: [], testsLine: 9, code: [], codeLine: 10, ...over };
}

function policyIndex(): FileIndex {
  return {
    file: POLICY,
    lastModified: 1,
    symbols: [
      { symbolId: `${POLICY}::LoanPolicy::class`, name: 'LoanPolicy', kind: 'class', startLine: 0, endLine: 20 },
      { symbolId: CAN_BORROW, name: 'LoanPolicy.CanBorrow', kind: 'method', startLine: 5, endLine: 9 },
    ],
    edges: [],
    intent: [],
    antiPatterns: [],
  };
}

describe('rule-symbol-links', () => {
  it('a Code: path links the rule to the file and a Code: symbol ID to the symbol', () => {
    const { links, unresolved } = ruleSymbolLinks({
      cardRefs: [card({ code: [POLICY, CAN_BORROW] })],
      codeRefs: NO_CODE_REFS,
      lookup: lookup({ [CAN_BORROW]: 'LoanPolicy.CanBorrow' }, [POLICY]),
    });
    expect(unresolved).toEqual([]);
    expect(links).toEqual([
      { kind: 'rule-symbol', from: 'rule:LEND-03', to: { file: POLICY }, source: 'card-code', at: { file: CARD, line: 10 } },
      { kind: 'rule-symbol', from: 'rule:LEND-03', to: { file: POLICY, symbolId: CAN_BORROW }, source: 'card-code', at: { file: CARD, line: 10 } },
    ]);
  });

  it('a Code: symbol ID missing from the index falls back to its file', () => {
    const indexed = `${POLICY}::LibraryLending.Lending.LoanPolicy.CanBorrow(1)::method`;
    const value = `${POLICY}::LoanPolicy.CanBorrow::method`;
    const { links, unresolved } = ruleSymbolLinks({
      cardRefs: [card({ code: [value] })],
      codeRefs: NO_CODE_REFS,
      lookup: lookup({ [indexed]: 'LoanPolicy.CanBorrow' }, [POLICY]),
    });
    expect(links).toEqual([
      { kind: 'rule-symbol', from: 'rule:LEND-03', to: { file: POLICY }, source: 'card-code', at: { file: CARD, line: 10 }, fallback: true },
    ]);
    expect(unresolved).toEqual([{ rule: 'LEND-03', field: 'Code', value, at: { file: CARD, line: 10 }, reason: 'not-a-symbol' }]);
  });

  it('a Code: path that does not exist links nothing and is recorded as missing-file, once per normalised value', () => {
    const { links, unresolved } = ruleSymbolLinks({
      cardRefs: [card({ code: ['src/Nope.cs', './src/Nope.cs', 'src\\Nope.cs'] })],
      codeRefs: NO_CODE_REFS,
      lookup: lookup({}, [POLICY]),
    });
    expect(links).toEqual([]);
    expect(unresolved).toEqual([{ rule: 'LEND-03', field: 'Code', value: 'src/Nope.cs', at: { file: CARD, line: 10 }, reason: 'missing-file' }]);
  });

  it('a rule: comment above a method links to the method', () => {
    const text = ['public class LoanPolicy', '{', '    // rule: LEND-03', '', '', '    public bool CanBorrow() {', '    }', '}'].join('\n');
    const o = options();
    const refs = scanRuleComments(POLICY, text, policyIndex(), o);
    const { links, unresolved } = ruleSymbolLinks({ cardRefs: [], codeRefs: resolveRuleRefs(refs, o), lookup: lookup() });
    expect(unresolved).toEqual([]);
    expect(links).toEqual([
      { kind: 'rule-symbol', from: 'rule:LEND-03', to: { file: POLICY, symbolId: CAN_BORROW }, source: 'rule-comment', at: { file: POLICY, line: 3 } },
    ]);
  });

  it('an unknown ID in a production rule: comment links nothing', () => {
    const o = options();
    const refs = scanRuleComments(POLICY, '// rule: LEND-99\n', policyIndex(), o);
    const codeRefs = resolveRuleRefs(refs, o);
    expect(codeRefs.unknown.map((r) => r.id)).toEqual(['LEND-99']);
    expect(ruleSymbolLinks({ cardRefs: [], codeRefs, lookup: lookup() }).links).toEqual([]);
  });

  it('the same evidence links once', () => {
    const o = options();
    const refs = scanRuleComments(POLICY, '// rule: LEND-03\n', undefined, o);
    const { links } = ruleSymbolLinks({
      cardRefs: [card({ code: [POLICY, `./${POLICY}`] }), card({ code: [POLICY] })],
      codeRefs: resolveRuleRefs([...refs, ...refs], o),
      lookup: lookup({}, [POLICY]),
    });
    expect(links.map((l) => l.source)).toEqual(['rule-comment', 'card-code']);
  });
});
