import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintSymbolPart, normalizeFingerprint } from '../fingerprint.js';

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
});

describe('normalizeFingerprint', () => {
  it('normalizeFingerprint tolerates spacing around separators and inside parts', () => {
    expect(normalizeFingerprint('literal-comparison|LoanPolicy.CanBorrow|loans.Count  >=  5\n')).toBe(SPEC);
    expect(normalizeFingerprint('  literal-comparison \t|  LoanPolicy.CanBorrow |\tloans.Count >= 5')).toBe(SPEC);
    expect(normalizeFingerprint('a | b | x | y')).toBe('a | b | x | y');
    expect(normalizeFingerprint('a|b|x|y')).toBe('a | b | x|y');
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
