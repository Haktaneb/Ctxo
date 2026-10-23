import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoCompositeAdapter } from '../composite-adapter.js';
import { GoAdapter } from '../go-adapter.js';
import { detectGoToolchain } from '../analyzer/toolchain-detect.js';

const FIXTURE = join(import.meta.dirname, '..', '..', 'test-fixtures', 'lending-module');
const LOAN_ID = 'loans/loan.go::Loan::class';

const EXPECTED = [
  { name: 'tag', named: { member: 'LoanID', json: 'loan_id', gorm: 'column:loan_id;primaryKey' } },
  { name: 'tag', named: { member: 'MemberID', json: 'member_id' } },
  { name: 'tag', named: { member: 'CopyID', json: 'member_id' } },
  { name: 'tag', named: { member: 'Due', json: 'due_at' } },
];

describe.skipIf(!detectGoToolchain().available)('lending module struct tags', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('the analyzer gives Loan the same tag annotations as the tree-sitter tier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-lending-'));
    dirs.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });

    const composite = new GoCompositeAdapter();
    await composite.initialize(dir);
    try {
      expect(composite.getTier()).toBe('full');
      const source = readFileSync(join(dir, 'loans', 'loan.go'), 'utf-8');
      const full = await composite.extractSymbols('loans/loan.go', source);
      const syntax = await new GoAdapter().extractSymbols('loans/loan.go', source);

      const fullLoan = full.find((s) => s.symbolId === LOAN_ID);
      const syntaxLoan = syntax.find((s) => s.symbolId === LOAN_ID);
      expect(fullLoan?.annotations).toEqual(EXPECTED);
      expect(syntaxLoan?.annotations).toEqual(EXPECTED);

      const base = full.find((s) => s.symbolId === 'loans/loan.go::Base::class');
      expect(base).toBeDefined();
      expect(base).not.toHaveProperty('annotations');
    } finally {
      await composite.dispose();
    }
  }, 180_000);

  it('test functions are function symbols with calls edges in the full tier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-lending-'));
    dirs.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });

    const composite = new GoCompositeAdapter();
    await composite.initialize(dir);
    try {
      expect(composite.getTier()).toBe('full');
      const canBorrow = 'loans/policy.go::CanBorrow::function';
      const cases = [
        { file: 'loans/policy_test.go', fn: 'TestCanBorrow', calls: true },
        { file: 'loans/policy_external_test.go', fn: 'TestPolicyFromOutside', calls: true },
        { file: 'itest/smoke_test.go', fn: 'TestSmoke', calls: false },
      ];
      for (const c of cases) {
        const source = readFileSync(join(dir, ...c.file.split('/')), 'utf-8');
        const id = `${c.file}::${c.fn}::function`;
        const symbols = await composite.extractSymbols(c.file, source);
        expect(symbols.filter((s) => s.symbolId === id)).toEqual([
          expect.objectContaining({ symbolId: id, name: c.fn, kind: 'function' }),
        ]);
        const edges = await composite.extractEdges(c.file, source);
        if (c.calls) {
          expect(edges).toContainEqual({ from: id, to: canBorrow, kind: 'calls' });
        }
      }

      const testSource = readFileSync(join(dir, 'loans', 'policy_test.go'), 'utf-8');
      expect(await composite.extractEdges('loans/policy_test.go', testSource)).toContainEqual({
        from: 'loans/policy_test.go::fakeStore::class',
        to: 'loans/policy.go::Store::interface',
        kind: 'implements',
      });
    } finally {
      await composite.dispose();
    }
  }, 180_000);
});
