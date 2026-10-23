import { describe, it, expect } from 'vitest';
import { createModuleHost, type SymbolNode } from '@ctxo/cli/internal';
import { REPO_WIDE_CONTEXT, termNodeId, type TermNode } from '../domain-graph.js';
import {
  TERM_IDENTIFIER_CAP,
  TERM_KIND_ORDER,
  identifierTokens,
  termIdentifierLinks,
  termTokens,
  tokensMatch,
  type TermCandidate,
} from '../term-links.js';

const { splitIdentifier: split, dataResourceKinds } = createModuleHost({
  cliVersion: '0.0.0',
  mode: 'cli',
  projectRoot: process.cwd(),
}).services;

function term(text: string, context = 'lending'): TermNode {
  return { id: termNodeId(context, text), context, key: text.toLowerCase(), term: text, definitions: [], identifierCount: 0 };
}

function candidate(name: string, kind: SymbolNode['kind'] = 'class', options: { file?: string; context?: string | null; isTest?: boolean } = {}): TermCandidate {
  const file = options.file ?? 'src/Lending/Code.cs';
  return {
    symbol: { symbolId: `${file}::${name}::${kind}`, name, kind, startLine: 1, endLine: 2 },
    file,
    ...(options.context === null ? {} : { context: options.context ?? 'lending' }),
    ...(options.isTest ? { isTest: true } : {}),
  };
}

function matchOf(termText: string, name: string, kind: SymbolNode['kind'] = 'class') {
  const { links } = termIdentifierLinks([term(termText)], [candidate(name, kind)], split, dataResourceKinds);
  const [link] = links;
  return link && link.kind === 'term-identifier' ? { match: link.match, source: link.source } : undefined;
}

describe('term tokens', () => {
  it('splits terms on whitespace and identifiers on the core tokenizer', () => {
    expect(termTokens('Member account', split)).toEqual(['member', 'account']);
    expect(termTokens("  Member's  account-id ", split)).toEqual(['members', 'account', 'id']);
    expect(identifierTokens('LibraryLending.Lending.LoanPolicy.CanBorrow(System.Int32)', split)).toEqual(['can', 'borrow']);
    expect(identifierTokens('member_account_id', split)).toEqual(['member', 'account', 'id']);
    expect(identifierTokens('dbo.loans', split)).toEqual(['loans']);
  });

  it('tokensMatch needs a contiguous run and folds plurals', () => {
    expect(tokensMatch(['loan', 'policy'], ['loan'])).toBe('partial');
    expect(tokensMatch(['loans'], ['loan'])).toBe('exact');
    expect(tokensMatch(['boxes'], ['box'])).toBe('exact');
    expect(tokensMatch(['categories'], ['category'])).toBe('exact');
    expect(tokensMatch(['member', 'x', 'account'], ['member', 'account'])).toBeUndefined();
    expect(tokensMatch(['loaner'], ['loan'])).toBeUndefined();
    expect(tokensMatch(['loan'], [])).toBeUndefined();
  });

  it('plural folding runs both ways: a plural term matches a singular identifier', () => {
    expect(tokensMatch(['late', 'fee'], ['late', 'fees'])).toBe('exact');
    expect(tokensMatch(['policy'], ['policies'])).toBe('exact');
    expect(tokensMatch(['box'], ['boxes'])).toBe('exact');
    expect(tokensMatch(['loan', 'policy'], ['loans'])).toBe('partial');
    expect(tokensMatch(['loan'], ['loaners'])).toBeUndefined();
    expect(tokensMatch(['fee'], ['feet'])).toBeUndefined();
  });
});

describe('termIdentifierLinks', () => {
  it.each([
    ['Loan', 'LoanPolicy', 'class', { match: 'partial', source: 'symbol-name' }],
    ['Loan', 'ILoanRepository', 'interface', { match: 'partial', source: 'symbol-name' }],
    ['Loan', 'LoansController', 'class', { match: 'partial', source: 'symbol-name' }],
    ['Loan', 'dbo.loans', 'table', { match: 'exact', source: 'table-name' }],
    ['Loan', 'Loaner', 'class', undefined],
    ['Member account', 'MemberAccount', 'class', { match: 'exact', source: 'symbol-name' }],
    ['Member account', 'member_account_id', 'variable', { match: 'partial', source: 'symbol-name' }],
    ['Category', 'Categories', 'class', { match: 'exact', source: 'symbol-name' }],
    ['Borrow', 'LibraryLending.Lending.LoanPolicy.CanBorrow(1)', 'method', { match: 'partial', source: 'symbol-name' }],
    ['Lending', 'LibraryLending.Lending.LoanPolicy', 'class', undefined],
    ['ID', 'Id', 'variable', undefined],
    ['ID', 'MemberId', 'variable', undefined],
    ['Late fees', 'LateFee', 'class', { match: 'exact', source: 'symbol-name' }],
    ['Late fees', 'LateFeeCalculator', 'class', { match: 'partial', source: 'symbol-name' }],
    ['Policies', 'Policy', 'class', { match: 'exact', source: 'symbol-name' }],
    ['Policies', 'LoanPolicy', 'class', { match: 'partial', source: 'symbol-name' }],
  ] as const)('%s against %s (%s)', (termText, name, kind, expected) => {
    expect(matchOf(termText, name, kind)).toEqual(expected);
  });

  it('a view is a table-name link and a procedure a symbol-name link', () => {
    expect(matchOf('Loan', 'dbo.v_loans', 'view')).toEqual({ match: 'partial', source: 'table-name' });
    expect(matchOf('Loan', 'dbo.usp_loans', 'procedure')).toEqual({ match: 'partial', source: 'symbol-name' });
  });

  it('a term with one long token among short ones still links', () => {
    expect(matchOf('ID card', 'IdCard')).toEqual({ match: 'exact', source: 'symbol-name' });
  });

  it("a context term matches only its context's symbols; a repo-wide term matches all; test symbols never match", () => {
    const candidates = [
      candidate('LoanPolicy', 'class', { file: 'src/Lending/LoanPolicy.cs', context: 'lending' }),
      candidate('LoanInvoice', 'class', { file: 'src/Billing/LoanInvoice.cs', context: 'billing' }),
      candidate('LoanHelper', 'class', { file: 'src/Shared/LoanHelper.cs', context: null }),
      candidate('LoanPolicyTests', 'class', { file: 'tests/LoanPolicyTests.cs', context: 'lending', isTest: true }),
    ];
    const lending = term('Loan', 'lending');
    const repoWide = term('Loan', REPO_WIDE_CONTEXT);
    const { links, counts } = termIdentifierLinks([lending, repoWide], candidates, split, dataResourceKinds);
    const targets = (id: string) => links.filter((l) => l.from === id).map((l) => (l.kind === 'term-identifier' ? l.to.symbolId : ''));
    expect(targets(lending.id)).toEqual(['src/Lending/LoanPolicy.cs::LoanPolicy::class']);
    expect(targets(repoWide.id)).toEqual([
      'src/Billing/LoanInvoice.cs::LoanInvoice::class',
      'src/Lending/LoanPolicy.cs::LoanPolicy::class',
      'src/Shared/LoanHelper.cs::LoanHelper::class',
    ]);
    expect(counts.get(lending.id)).toBe(1);
    expect(counts.get(repoWide.id)).toBe(3);
    expect(links[0]).toEqual({
      kind: 'term-identifier',
      from: lending.id,
      to: { file: 'src/Lending/LoanPolicy.cs', symbolId: 'src/Lending/LoanPolicy.cs::LoanPolicy::class' },
      source: 'symbol-name',
      match: 'partial',
    });
  });

  it('links are capped at 50 per term with exact matches and types first, and the count is kept', () => {
    const candidates: TermCandidate[] = [];
    for (let i = 0; i < 55; i++) candidates.push(candidate(`LoanStep${String(i).padStart(2, '0')}`, 'function'));
    candidates.push(candidate('LoanPolicy', 'class'));
    candidates.push(candidate('ILoanRepository', 'interface'));
    candidates.push(candidate('LoanId', 'type'));
    candidates.push(candidate('dbo.loans', 'table'));
    candidates.push(candidate('Loan', 'class'));
    expect(candidates).toHaveLength(60);
    const loan = term('Loan');
    const { links, counts } = termIdentifierLinks([loan], [...candidates].reverse(), split, dataResourceKinds);
    expect(TERM_IDENTIFIER_CAP).toBe(50);
    expect(links).toHaveLength(50);
    expect(counts.get(loan.id)).toBe(60);
    const ids = links.map((l) => (l.kind === 'term-identifier' ? l.to.symbolId : ''));
    expect(ids.slice(0, 6)).toEqual([
      'src/Lending/Code.cs::Loan::class',
      'src/Lending/Code.cs::dbo.loans::table',
      'src/Lending/Code.cs::LoanPolicy::class',
      'src/Lending/Code.cs::ILoanRepository::interface',
      'src/Lending/Code.cs::LoanId::type',
      'src/Lending/Code.cs::LoanStep00::function',
    ]);
    expect(ids[49]).toBe('src/Lending/Code.cs::LoanStep44::function');
  });

  it('the kind order puts types before members', () => {
    expect(TERM_KIND_ORDER).toEqual(['class', 'interface', 'type', 'table', 'view', 'procedure', 'function', 'method', 'variable']);
  });

  it('Account in two contexts: each term links only the symbols of its own context', () => {
    const candidates = [
      candidate('MemberAccount', 'class', { file: 'src/Lending/MemberAccount.cs', context: 'lending' }),
      candidate('AccountLedger', 'class', { file: 'src/Billing/AccountLedger.cs', context: 'billing' }),
      candidate('Account', 'class', { file: 'src/Billing/Account.cs', context: 'billing' }),
      candidate('AccountHelper', 'class', { file: 'src/Shared/AccountHelper.cs', context: null }),
    ];
    const lending = term('Account', 'lending');
    const billing = term('Account', 'billing');
    const { links, counts } = termIdentifierLinks([billing, lending], [...candidates].reverse(), split, dataResourceKinds);
    const targets = (id: string) => links.filter((l) => l.from === id).map((l) => (l.kind === 'term-identifier' ? l.to.symbolId : ''));
    expect(targets(lending.id)).toEqual(['src/Lending/MemberAccount.cs::MemberAccount::class']);
    expect(targets(billing.id)).toEqual(['src/Billing/Account.cs::Account::class', 'src/Billing/AccountLedger.cs::AccountLedger::class']);
    expect(counts.get(lending.id)).toBe(1);
    expect(counts.get(billing.id)).toBe(2);
  });

  it('a term of a context without symbols links nothing and counts 0', () => {
    const { links, counts } = termIdentifierLinks([term('Loan', 'reporting')], [candidate('LoanPolicy')], split, dataResourceKinds);
    expect(links).toEqual([]);
    expect(counts.get(term('Loan', 'reporting').id)).toBe(0);
  });

  it('a symbol listed twice is linked once', () => {
    const c = candidate('LoanPolicy');
    const { links, counts } = termIdentifierLinks([term('Loan')], [c, c], split, dataResourceKinds);
    expect(links).toHaveLength(1);
    expect(counts.get(term('Loan').id)).toBe(1);
  });
});
