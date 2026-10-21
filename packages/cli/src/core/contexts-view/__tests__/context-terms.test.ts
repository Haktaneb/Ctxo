import { describe, it, expect } from 'vitest';
import { findTermCollisions, harvestTopTerms } from '../context-terms.js';
import { DEFAULT_TECHNICAL_TERMS } from '../../config/config-schema.js';
import type { SymbolKind, SymbolNode } from '../../types.js';

function sym(file: string, name: string, kind: SymbolKind): SymbolNode {
  return { symbolId: `${file}::${name}::${kind}`, name, kind, startLine: 1, endLine: 2 };
}

function byFile(entries: Record<string, SymbolNode[]>): Map<string, readonly SymbolNode[]> {
  return new Map(Object.entries(entries));
}

describe('harvestTopTerms', () => {
  it('ranks type-name tokens by number of files', () => {
    const symbols = byFile({
      'f1.ts': [sym('f1.ts', 'LoanPolicy', 'class')],
      'f2.ts': [sym('f2.ts', 'LoanLimit', 'type')],
      'f3.ts': [sym('f3.ts', 'MemberAccount', 'interface')],
    });
    expect(harvestTopTerms(['f1.ts', 'f2.ts', 'f3.ts'], symbols, DEFAULT_TECHNICAL_TERMS)).toEqual([
      { term: 'loan', files: 2 },
      { term: 'account', files: 1 },
      { term: 'limit', files: 1 },
      { term: 'member', files: 1 },
      { term: 'policy', files: 1 },
    ]);
  });

  it('drops stop words, technical words, the interface I prefix and short or numeric tokens', () => {
    const symbols = byFile({
      'f1.ts': [sym('f1.ts', 'ILoanRepository', 'interface'), sym('f1.ts', 'LoanService', 'class')],
      'f2.ts': [sym('f2.ts', 'GetHandler2', 'class')],
    });
    expect(harvestTopTerms(['f1.ts', 'f2.ts'], symbols, DEFAULT_TECHNICAL_TERMS)).toEqual([
      { term: 'loan', files: 1 },
    ]);
  });

  it('includes enum members of type symbols', () => {
    const symbols = byFile({
      'f1.cs': [sym('f1.cs', 'Ns.LoanStatus', 'type'), sym('f1.cs', 'Ns.LoanStatus.Overdue', 'variable')],
    });
    expect(harvestTopTerms(['f1.cs'], symbols, DEFAULT_TECHNICAL_TERMS)).toEqual([
      { term: 'loan', files: 1 },
      { term: 'overdue', files: 1 },
      { term: 'status', files: 1 },
    ]);
  });

  it('keeps the top 10 with code point tie-breaks', () => {
    const names = ['Kilo', 'Juliet', 'India', 'Hotel', 'Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha', 'Zulu'];
    const symbols = byFile({ 'f1.ts': names.map((n) => sym('f1.ts', n, 'class')) });
    const terms = harvestTopTerms(['f1.ts'], symbols, DEFAULT_TECHNICAL_TERMS);
    expect(terms.map((t) => t.term)).toEqual([
      'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
    ]);
    expect(harvestTopTerms(['f1.ts'], symbols, DEFAULT_TECHNICAL_TERMS, 3)).toHaveLength(3);
  });

  it('takes terms from type names and enum members only, not class members', () => {
    const symbols = byFile({
      'f1.cs': [
        sym('f1.cs', 'Ns.Account', 'class'),
        sym('f1.cs', 'Ns.Account.Borrow', 'method'),
        sym('f1.cs', 'Ns.Account.MemberId', 'variable'),
      ],
    });
    expect(harvestTopTerms(['f1.cs'], symbols, DEFAULT_TECHNICAL_TERMS)).toEqual([
      { term: 'account', files: 1 },
    ]);
  });

  it('counts a term that appears twice in one file once', () => {
    const symbols = byFile({
      'f1.ts': [sym('f1.ts', 'LoanPolicy', 'class'), sym('f1.ts', 'LoanLimit', 'type')],
    });
    const terms = harvestTopTerms(['f1.ts'], symbols, DEFAULT_TECHNICAL_TERMS);
    expect(terms.find((t) => t.term === 'loan')).toEqual({ term: 'loan', files: 1 });
  });

  it('uses the supplied technical term list instead of the default', () => {
    const symbols = byFile({ 'f1.ts': [sym('f1.ts', 'LoanService', 'class')] });
    expect(harvestTopTerms(['f1.ts'], symbols, ['Loan']).map((t) => t.term)).toEqual(['service']);
  });
});

describe('findTermCollisions', () => {
  it('reports a name whose shapes differ across candidates', () => {
    const symbols = byFile({
      'a.cs': [
        sym('a.cs', 'Lending.Account', 'class'),
        sym('a.cs', 'Lending.Account.MemberId', 'variable'),
        sym('a.cs', 'Lending.Account.Borrow', 'method'),
        sym('a.cs', 'Lending.Account.Limit', 'variable'),
      ],
      'b.cs': [
        sym('b.cs', 'Billing.Account', 'class'),
        sym('b.cs', 'Billing.Account.PayerId', 'variable'),
        sym('b.cs', 'Billing.Account.Charge', 'method'),
        sym('b.cs', 'Billing.Account.Limit', 'variable'),
      ],
    });
    const result = findTermCollisions(
      [{ id: 1, files: ['a.cs'] }, { id: 2, files: ['b.cs'] }],
      symbols,
    );
    expect(result).toEqual([
      {
        name: 'account',
        minJaccard: 0.2,
        occurrences: [
          { candidate: 1, file: 'a.cs', symbolId: 'a.cs::Lending.Account::class', members: ['Borrow', 'Limit', 'MemberId'] },
          { candidate: 2, file: 'b.cs', symbolId: 'b.cs::Billing.Account::class', members: ['Charge', 'Limit', 'PayerId'] },
        ],
      },
    ]);
  });

  it('ignores Jaccard >= 0.5, names inside a single candidate and two empty member sets', () => {
    const symbols = byFile({
      'a.ts': [sym('a.ts', 'Same', 'class'), sym('a.ts', 'Same.x', 'method'), sym('a.ts', 'Same.y', 'method'),
        sym('a.ts', 'Empty', 'class'), sym('a.ts', 'Lone', 'class')],
      'b.ts': [sym('b.ts', 'Same', 'class'), sym('b.ts', 'Same.x', 'method'), sym('b.ts', 'Same.y', 'method'),
        sym('b.ts', 'Same.z', 'method'), sym('b.ts', 'Empty', 'class')],
    });
    // Same: 2/3 >= 0.5; Empty: two empty sets are identical; Lone: present in candidate 1 only.
    expect(findTermCollisions([{ id: 1, files: ['a.ts'] }, { id: 2, files: ['b.ts'] }], symbols)).toEqual([]);
    // Everything inside a single candidate is never a collision, even with different shapes.
    const single = byFile({
      'a.ts': [sym('a.ts', 'Dup', 'class'), sym('a.ts', 'Dup.x', 'method')],
      'b.ts': [sym('b.ts', 'Dup', 'class'), sym('b.ts', 'Dup.y', 'method')],
    });
    expect(findTermCollisions([{ id: 1, files: ['a.ts', 'b.ts'] }], single)).toEqual([]);
  });

  it('collapses arity-suffixed overloads so they match Roslyn-style member names', () => {
    const symbols = byFile({
      'a.cs': [
        sym('a.cs', 'Lending.Account', 'class'),
        sym('a.cs', 'Lending.Account.Borrow(1)', 'method'),
        sym('a.cs', 'Lending.Account.Borrow(2)', 'method'),
      ],
      'b.cs': [sym('b.cs', 'Billing.Account', 'class'), sym('b.cs', 'Billing.Account.Borrow', 'method')],
    });
    expect(findTermCollisions([{ id: 1, files: ['a.cs'] }, { id: 2, files: ['b.cs'] }], symbols)).toEqual([]);
    const withMembers = byFile({
      'a.cs': [
        sym('a.cs', 'Lending.Account', 'class'),
        sym('a.cs', 'Lending.Account.Borrow(1)', 'method'),
        sym('a.cs', 'Lending.Account.Borrow(2)', 'method'),
        sym('a.cs', 'Lending.Account.Pay(0)', 'method'),
      ],
      'b.cs': [sym('b.cs', 'Billing.Account', 'class')],
    });
    const result = findTermCollisions([{ id: 1, files: ['a.cs'] }, { id: 2, files: ['b.cs'] }], withMembers);
    expect(result[0]!.occurrences[0]!.members).toEqual(['Borrow', 'Pay']);
  });

  it('excludes deeper names from member sets', () => {
    const symbols = byFile({
      'a.ts': [sym('a.ts', 'Acct', 'class'), sym('a.ts', 'Acct.Inner.x', 'variable'), sym('a.ts', 'Acct.y', 'method')],
      'b.ts': [sym('b.ts', 'Acct', 'class'), sym('b.ts', 'Acct.z', 'method')],
    });
    const result = findTermCollisions([{ id: 1, files: ['a.ts'] }, { id: 2, files: ['b.ts'] }], symbols);
    expect(result[0]!.occurrences[0]!.members).toEqual(['y']);
  });

  it('rounds minJaccard to 3 decimals', () => {
    const symbols = byFile({
      'a.ts': [sym('a.ts', 'Acct', 'class'), sym('a.ts', 'Acct.a', 'method'), sym('a.ts', 'Acct.b', 'method')],
      'b.ts': [sym('b.ts', 'Acct', 'class'), sym('b.ts', 'Acct.b', 'method'), sym('b.ts', 'Acct.c', 'method')],
    });
    const result = findTermCollisions([{ id: 1, files: ['a.ts'] }, { id: 2, files: ['b.ts'] }], symbols);
    expect(result[0]!.minJaccard).toBe(0.333);
  });

  /** `count` files each declaring `Order`, spread over four candidates; `members(i)` names the members of file i. */
  function orderGroup(count: number, members: (i: number) => string[]) {
    const entries: Record<string, SymbolNode[]> = {};
    const files: string[][] = [[], [], [], []];
    for (let i = 0; i < count; i++) {
      const file = `f${String(i).padStart(3, '0')}.ts`;
      entries[file] = [
        sym(file, 'Order', 'class'),
        ...members(i).map((member) => sym(file, `Order.${member}`, 'method')),
      ];
      files[i % 4]!.push(file);
    }
    return { symbols: byFile(entries), candidates: files.map((list, i) => ({ id: i + 1, files: list })) };
  }

  it('a large same-name group still gives minJaccard 0 when only its last occurrence shares no member', () => {
    // Every pair of the first 199 shares `id` and differs in one member (Jaccard 1/3); the last one shares nothing.
    const { symbols, candidates } = orderGroup(200, (i) => (i === 199 ? ['weight'] : ['id', `m${i}`]));

    const result = findTermCollisions(candidates, symbols);

    expect(result).toHaveLength(1);
    expect(result[0]!.minJaccard).toBe(0);
    expect(result[0]!.occurrences).toHaveLength(200);
  });

  it('stops comparing a group once a pair of occurrences shares no member', () => {
    const { symbols, candidates } = orderGroup(200, (i) => [`m${i}`]);
    let compared = 0;
    const disjoint = (): number => {
      compared++;
      return 0;
    };

    const result = findTermCollisions(candidates, symbols, disjoint);

    expect(result[0]!.minJaccard).toBe(0);
    expect(compared).toBe(1);
  });

  it('matches names case-insensitively', () => {
    const symbols = byFile({
      'a.ts': [sym('a.ts', 'Account', 'class'), sym('a.ts', 'Account.one', 'method')],
      'b.ts': [sym('b.ts', 'ACCOUNT', 'class'), sym('b.ts', 'ACCOUNT.two', 'method')],
    });
    const result = findTermCollisions([{ id: 1, files: ['a.ts'] }, { id: 2, files: ['b.ts'] }], symbols);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('account');
    expect(result[0]!.minJaccard).toBe(0);
  });
});
