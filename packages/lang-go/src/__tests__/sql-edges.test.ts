import { describe, it, expect } from 'vitest';
import { sqlEdgesFromCallSites, MAX_SQL_TEXT_LENGTH, type SqlCallSite } from '../sql-edges.js';

const REPO = 'loans/repository.go';
const site = (symbolId: string, text: string, kind: SqlCallSite['kind'] = 'statement'): SqlCallSite => ({
  symbolId,
  line: 3,
  text,
  kind,
});

describe('sqlEdgesFromCallSites', () => {
  it('statement and procedure sites become data edges to canonical targets', () => {
    const edges = sqlEdgesFromCallSites([
      site(`${REPO}::flag::function`, 'UPDATE l SET l.Flag = 1 FROM dbo.Loans l'),
      site(`${REPO}::close::function`, '[dbo].[usp_CloseLoan]', 'procedureName'),
    ]);
    expect(edges).toEqual([
      { from: `${REPO}::close::function`, to: 'dbo.usp_closeloan::procedure', kind: 'executes' },
      { from: `${REPO}::flag::function`, to: 'dbo.loans::table', kind: 'reads' },
      { from: `${REPO}::flag::function`, to: 'dbo.loans::table', kind: 'writes' },
    ]);
  });

  it('duplicate sites give one edge and edges sort by source, kind and target', () => {
    const edges = sqlEdgesFromCallSites([
      site(`${REPO}::b::function`, 'SELECT Id FROM dbo.Members'),
      site(`${REPO}::a::function`, 'SELECT Id FROM dbo.Loans JOIN dbo.Holds ON 1 = 1'),
      site(`${REPO}::a::function`, 'SELECT Id FROM dbo.Loans'),
      site(`${REPO}::a::function`, 'DELETE FROM dbo.Holds'),
    ]);
    expect(edges).toEqual([
      { from: `${REPO}::a::function`, to: 'dbo.holds::table', kind: 'reads' },
      { from: `${REPO}::a::function`, to: 'dbo.loans::table', kind: 'reads' },
      { from: `${REPO}::a::function`, to: 'dbo.holds::table', kind: 'writes' },
      { from: `${REPO}::b::function`, to: 'dbo.members::table', kind: 'reads' },
    ]);
  });

  it('text without an access gives no edge', () => {
    expect(sqlEdgesFromCallSites([])).toEqual([]);
    expect(
      sqlEdgesFromCallSites([site(`${REPO}::a::function`, 'SELECT 1'), site(`${REPO}::a::function`, '')]),
    ).toEqual([]);
  });

  it('skips a call-site text longer than 1 MiB', () => {
    expect(MAX_SQL_TEXT_LENGTH).toBe(1_048_576);
    const padding = ' '.repeat(MAX_SQL_TEXT_LENGTH);
    expect(sqlEdgesFromCallSites([site(`${REPO}::a::function`, `SELECT Id FROM dbo.Loans${padding}`)])).toEqual([]);
    expect(sqlEdgesFromCallSites([site(`${REPO}::a::function`, 'SELECT Id FROM dbo.Loans')])).toHaveLength(1);
  });
});
