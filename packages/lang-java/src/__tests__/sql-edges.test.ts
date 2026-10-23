import { describe, it, expect } from 'vitest';
import { sqlEdgesFromCallSites, MAX_SQL_TEXT_LENGTH, type SqlCallSite } from '../sql-edges.js';

const REPO = 'src/main/java/lending/data/LoanRepository.java';
const site = (symbolId: string, text: string, kind: SqlCallSite['kind'] = 'statement'): SqlCallSite => ({
  symbolId,
  line: 3,
  text,
  kind,
});

describe('sqlEdgesFromCallSites', () => {
  it('statement and procedure sites become data edges to canonical targets', () => {
    const edges = sqlEdgesFromCallSites([
      site(`${REPO}::flag::method`, 'UPDATE l SET l.Flag = 1 FROM dbo.Loans l'),
      site(`${REPO}::close::method`, '[dbo].[usp_CloseLoan]', 'procedureName'),
    ]);
    expect(edges).toEqual([
      { from: `${REPO}::close::method`, to: 'dbo.usp_closeloan::procedure', kind: 'executes' },
      { from: `${REPO}::flag::method`, to: 'dbo.loans::table', kind: 'reads' },
      { from: `${REPO}::flag::method`, to: 'dbo.loans::table', kind: 'writes' },
    ]);
  });

  it('duplicate sites give one edge and edges sort by source, kind and target', () => {
    const edges = sqlEdgesFromCallSites([
      site(`${REPO}::b::method`, 'SELECT Id FROM dbo.Members'),
      site(`${REPO}::a::method`, 'SELECT Id FROM dbo.Loans JOIN dbo.Holds ON 1 = 1'),
      site(`${REPO}::a::method`, 'SELECT Id FROM dbo.Loans'),
      site(`${REPO}::a::method`, 'DELETE FROM dbo.Holds'),
    ]);
    expect(edges).toEqual([
      { from: `${REPO}::a::method`, to: 'dbo.holds::table', kind: 'reads' },
      { from: `${REPO}::a::method`, to: 'dbo.loans::table', kind: 'reads' },
      { from: `${REPO}::a::method`, to: 'dbo.holds::table', kind: 'writes' },
      { from: `${REPO}::b::method`, to: 'dbo.members::table', kind: 'reads' },
    ]);
  });

  it('text without an access gives no edge', () => {
    expect(sqlEdgesFromCallSites([])).toEqual([]);
    expect(
      sqlEdgesFromCallSites([site(`${REPO}::a::method`, 'SELECT 1'), site(`${REPO}::a::method`, '')]),
    ).toEqual([]);
  });

  it('skips a call-site text longer than 1 MiB', () => {
    expect(MAX_SQL_TEXT_LENGTH).toBe(1_048_576);
    const padding = ' '.repeat(MAX_SQL_TEXT_LENGTH);
    expect(sqlEdgesFromCallSites([site(`${REPO}::a::method`, `SELECT Id FROM dbo.Loans${padding}`)])).toEqual([]);
    expect(sqlEdgesFromCallSites([site(`${REPO}::a::method`, 'SELECT Id FROM dbo.Loans')])).toHaveLength(1);
  });
});
