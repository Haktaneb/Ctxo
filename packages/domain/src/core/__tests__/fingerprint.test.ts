import { describe, expect, it } from 'vitest';
import { decodeFingerprintPart, fingerprint, fingerprintSymbolPart, normalizeFingerprint } from '../fingerprint.js';

const SPEC = 'literal-comparison | LoanPolicy.CanBorrow | loans.Count >= 5';

describe('fingerprintSymbolPart', () => {
  it.each([
    ['src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow::method', 'LoanPolicy.CanBorrow'],
    ['src/Lending/LoanPolicy.cs::LibraryLending.Lending.LoanPolicy.CanBorrow(1)::method', 'LoanPolicy.CanBorrow'],
    ['src/lending/loan-policy.ts::LoanPolicy.canBorrow::method', 'LoanPolicy.canBorrow'],
    ['src/lending/loan-policy.ts::canBorrow::function', 'loan-policy.canBorrow'],
    ['src/main/java/lending/LoanPolicy.java::canBorrow::method', 'LoanPolicy.canBorrow'],
    ['loans/policy.go::CanBorrow::function', 'policy.CanBorrow'],
    ['db/migrations/lending/001_create_loans.sql::dbo.loans::table', 'dbo.loans'],
    ['src/app.ts::app::variable', 'app.app'],
  ])('the symbol part drops namespaces and the C# parameter suffix: %s', (symbolId, expected) => {
    expect(fingerprintSymbolPart(symbolId)).toBe(expected);
  });

  it('a nested parameter suffix, backslashes and a file without an extension', () => {
    expect(fingerprintSymbolPart('src\\Lending\\LoanPolicy.cs::NS.LoanPolicy.Pick(List<(int, int)>)::method')).toBe('LoanPolicy.Pick');
    expect(fingerprintSymbolPart('bin/run::main::function')).toBe('run.main');
  });

  it('a C# explicit interface implementation keeps its containing type (M3)', () => {
    const dispose = 'src/Lending/LoanPolicy.cs::NS.LoanPolicy.System.IDisposable.Dispose::method';
    expect(fingerprintSymbolPart(dispose, 'NS.LoanPolicy')).toBe('LoanPolicy.IDisposable.Dispose');
    const member = 'src/Lending/Models.cs::Lending.Member.System.IComparable<Lending.Member>.CompareTo::method';
    const loan = 'src/Lending/Models.cs::Lending.Loan.System.IComparable<Lending.Loan>.CompareTo::method';
    expect(fingerprintSymbolPart(member, 'Lending.Member')).toBe('Member.IComparable<Lending.Member>.CompareTo');
    expect(fingerprintSymbolPart(loan, 'Lending.Loan')).toBe('Loan.IComparable<Lending.Loan>.CompareTo');
    expect(fingerprintSymbolPart('src/M.cs::Member.IComparable<Member>.CompareTo::method', 'Member')).toBe('Member.IComparable<Member>.CompareTo');
    // A plain member of the container, or a container that is no prefix, keeps the H4 rule.
    expect(fingerprintSymbolPart('src/Lending/LoanPolicy.cs::NS.LoanPolicy.CanBorrow::method', 'NS.LoanPolicy')).toBe('LoanPolicy.CanBorrow');
    expect(fingerprintSymbolPart('src/Lending/LoanPolicy.cs::NS.LoanPolicy.CanBorrow::method', 'NS.Other')).toBe('LoanPolicy.CanBorrow');
  });

  it('a dot inside generic arguments does not split a segment (M3)', () => {
    expect(fingerprintSymbolPart('src/M.cs::Lending.Member.System.IComparable<Lending.Member>.CompareTo::method')).toBe(
      'IComparable<Lending.Member>.CompareTo',
    );
  });

  it('an id without a file part gives the last two segments of its name', () => {
    expect(fingerprintSymbolPart('dbo.loans::table')).toBe('dbo.loans');
    expect(fingerprintSymbolPart('Loose')).toBe('Loose');
  });
});

describe('fingerprint', () => {
  it('fingerprint reproduces the spec example', () => {
    expect(fingerprint('literal-comparison', 'LoanPolicy.CanBorrow', 'loans.Count >= 5')).toBe(SPEC);
  });

  it('normalizes the text as facts are normalized', () => {
    expect(fingerprint('literal-comparison', 'LoanPolicy.CanBorrow', '  loans.Count\n  >=   5 ')).toBe(SPEC);
    expect(fingerprint('retry-timeout', 'SmtpSender.Send', 'Timeout = 30s')).toBe('retry-timeout | SmtpSender.Send | Timeout = 30s');
  });

  it('a fingerprint survives normalizeFingerprint unchanged', () => {
    const value = fingerprint('normalization', 'Member.Key', 'email.Trim().ToLowerInvariant()');
    expect(normalizeFingerprint(value)).toBe(value);
  });

  it.each([
    ['db/migrations/lending/001.sql::dbo.status|history::table', 'data-resource', 'table dbo.status|history', 'dbo.status%7Chistory'],
    ["src/router.ts::Router.'get|post'::method", 'literal-comparison', 'n >= 5', "Router.'get%7Cpost'"],
    ['scripts/a|b.py::run::function', 'retry-timeout', 'timeout = 30', 'a%7Cb.run'],
    ['src/fmt.ts::Fmt.pct%7C::method', 'literal-comparison', 'x || y >= 5', 'Fmt.pct%257C'],
  ])('a | or %% in the symbol part is percent-encoded and round-trips (I1): %s', (symbolId, kind, text, encoded) => {
    const part = fingerprintSymbolPart(symbolId);
    const value = fingerprint(kind, part, text);
    expect(value).toBe(`${kind} | ${encoded} | ${text}`);
    expect(normalizeFingerprint(value)).toBe(value);
    expect(decodeFingerprintPart(encoded)).toBe(part);
  });

  it('a | in the kind is encoded too, and a | in the text stays text', () => {
    expect(fingerprint('a|b', 'X.y', 'p | q')).toBe('a%7Cb | X.y | p | q');
    expect(normalizeFingerprint('a%7Cb | X.y | p | q')).toBe('a%7Cb | X.y | p | q');
    expect(normalizeFingerprint('k|X.y|a || b')).toBe('k | X.y | a || b');
  });
});

describe('normalizeFingerprint', () => {
  it('normalizeFingerprint tolerates spacing around separators and inside parts', () => {
    expect(normalizeFingerprint('literal-comparison|LoanPolicy.CanBorrow|loans.Count  >=  5\n')).toBe(SPEC);
    expect(normalizeFingerprint('  literal-comparison \t|  LoanPolicy.CanBorrow |\tloans.Count >= 5')).toBe(SPEC);
    expect(normalizeFingerprint('a | b | x | y')).toBe('a | b | x | y');
    expect(normalizeFingerprint('a|b|x|y')).toBe('a | b | x|y');
  });

  it('normalizeFingerprint canonicalizes the encoding of the first two parts', () => {
    // Lower-case escapes, and a raw % that the encoder would have escaped.
    expect(normalizeFingerprint('data-resource | dbo.status%7chistory | table dbo.status|history')).toBe(
      'data-resource | dbo.status%7Chistory | table dbo.status|history',
    );
    expect(normalizeFingerprint('k | Fmt.pct%41 | x')).toBe('k | Fmt.pct%2541 | x');
    expect(normalizeFingerprint('k | Fmt.pct%41 | x')).toBe(fingerprint('k', 'Fmt.pct%41', 'x'));
  });

  it('normalizeFingerprint rejects fewer than three parts or an empty part', () => {
    expect(normalizeFingerprint('')).toBeUndefined();
    expect(normalizeFingerprint('literal-comparison')).toBeUndefined();
    expect(normalizeFingerprint('literal-comparison | LoanPolicy.CanBorrow')).toBeUndefined();
    expect(normalizeFingerprint(' | LoanPolicy.CanBorrow | x > 5')).toBeUndefined();
    expect(normalizeFingerprint('literal-comparison |   | x > 5')).toBeUndefined();
    expect(normalizeFingerprint('literal-comparison | LoanPolicy.CanBorrow |  \n')).toBeUndefined();
  });
});
