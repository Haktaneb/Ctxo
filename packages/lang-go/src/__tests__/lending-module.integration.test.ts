import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const DATA_KINDS = new Set(['reads', 'writes', 'executes']);
const REPO = 'loans/repository.go';
const REPO_TEST = 'loans/repository_test.go';

const EXPECTED_DATA_EDGES = [
  { from: `${REPO}::ActiveLoans::function`, to: 'dbo.loans::table', kind: 'reads' },
  { from: `${REPO}::ActiveLoans::function`, to: 'dbo.members::table', kind: 'reads' },
  { from: `${REPO}::Archive::function`, to: 'dbo.loans::table', kind: 'reads' },
  { from: `${REPO}::Archive::function`, to: 'dbo.loanarchive::table', kind: 'writes' },
  { from: `${REPO}::CloseLoan::function`, to: 'dbo.usp_closeloan::procedure', kind: 'executes' },
  { from: `${REPO}::HoldsFor::function`, to: 'dbo.holds::table', kind: 'reads' },
  { from: `${REPO}::Purge::function`, to: 'dbo.holds::table', kind: 'writes' },
  { from: `${REPO_TEST}::TestActiveLoanCount::function`, to: 'dbo.loans::table', kind: 'reads' },
];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe.skipIf(!detectGoToolchain().available)('lending module SQL call sites', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** Every data edge of every .go file under `prefix` of `dir`, sorted. */
  async function dataEdges(composite: GoCompositeAdapter, prefix: string) {
    const files = [REPO, REPO_TEST, 'loans/loan.go', 'loans/policy.go', 'loans/policy_test.go', 'loans/policy_external_test.go', 'itest/smoke_test.go'];
    const edges = [];
    for (const f of files) {
      for (const e of await composite.extractEdges(`${prefix}${f}`, '')) if (DATA_KINDS.has(e.kind)) edges.push(e);
    }
    return edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to));
  }

  it('repository functions and the test function have the expected data edges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-lending-sql-'));
    dirs.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });

    const composite = new GoCompositeAdapter({ sqlCallSites: true });
    await composite.initialize(dir);
    try {
      expect(composite.getTier()).toBe('full');
      const edges = await dataEdges(composite, '');
      const expected = [...EXPECTED_DATA_EDGES].sort((a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to));
      expect(edges).toEqual(expected);
    } finally {
      await composite.dispose();
    }
  }, 180_000);

  it('call-site ids carry the module prefix when go.mod sits in a subdirectory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-lending-sql-'));
    dirs.push(dir);
    const moduleDir = join(dir, 'services', 'lending');
    mkdirSync(moduleDir, { recursive: true });
    cpSync(FIXTURE, moduleDir, { recursive: true });

    const composite = new GoCompositeAdapter({ sqlCallSites: true });
    await composite.initialize(dir);
    try {
      expect(composite.getTier()).toBe('full');
      const edges = await composite.extractEdges(`services/lending/${REPO}`, '');
      expect(edges).toContainEqual({
        from: `services/lending/${REPO}::ActiveLoans::function`,
        to: 'dbo.loans::table',
        kind: 'reads',
      });
      const data = await dataEdges(composite, 'services/lending/');
      expect(data.length).toBe(EXPECTED_DATA_EDGES.length);
      for (const e of data) {
        expect(e.from.startsWith('services/lending/'), e.from).toBe(true);
        expect(e.to.startsWith('dbo.') && !e.to.includes('services/'), e.to).toBe(true);
      }
    } finally {
      await composite.dispose();
    }
  }, 180_000);

  it('getSqlStats reports 6 constant and 1 non-constant texts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-lending-sql-'));
    dirs.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });

    const composite = new GoCompositeAdapter({ sqlCallSites: true });
    await composite.initialize(dir);
    try {
      await composite.extractEdges(REPO, '');
      expect(composite.getAnalyzerDelegate()?.getSqlStats()).toEqual({ constant: 6, nonConstant: 1 });
    } finally {
      await composite.dispose();
    }
  }, 180_000);

  it('without sqlCallSites there are no data edges and no stats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-lending-sql-'));
    dirs.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });

    const composite = new GoCompositeAdapter();
    await composite.initialize(dir);
    try {
      expect(composite.getTier()).toBe('full');
      expect(composite.sqlCallSites).toBe(false);
      expect(await dataEdges(composite, '')).toEqual([]);
      expect(composite.getAnalyzerDelegate()?.getSqlStats()).toBeUndefined();
    } finally {
      await composite.dispose();
    }
  }, 180_000);
});
