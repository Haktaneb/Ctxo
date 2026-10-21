import { describe, it, expect } from 'vitest';
import { extractSqlAccesses } from '../accesses.js';
import type { SqlAccess } from '../types.js';

/** Access lists by kind, in the order the extractor returns them. */
function byKind(accesses: readonly SqlAccess[]): Record<string, string[]> {
  const out: Record<string, string[]> = { reads: [], writes: [], executes: [] };
  for (const a of accesses) out[a.kind]!.push(a.name);
  return out;
}

describe('extractSqlAccesses in procedureName mode', () => {
  it('a procedure name gives one executes access', () => {
    expect(extractSqlAccesses('[dbo].[usp_CloseLoan]', 'procedureName')).toEqual([
      { kind: 'executes', name: 'dbo.usp_closeloan' },
    ]);
    expect(extractSqlAccesses('usp_RenewLoan', 'procedureName')).toEqual([
      { kind: 'executes', name: 'dbo.usp_renewloan' },
    ]);
    expect(extractSqlAccesses('[dbo].[usp Close Loan]', 'procedureName')).toEqual([
      { kind: 'executes', name: 'dbo.usp close loan' },
    ]);
  });

  it('a procedure name with spaces outside brackets or more than two parts gives nothing', () => {
    expect(extractSqlAccesses('usp Close Loan', 'procedureName')).toEqual([]);
    expect(extractSqlAccesses('dbo.usp_CloseLoan @id', 'procedureName')).toEqual([]);
    expect(extractSqlAccesses('EXEC dbo.usp_CloseLoan', 'procedureName')).toEqual([]);
    expect(extractSqlAccesses('Library.dbo.usp_CloseLoan', 'procedureName')).toEqual([]);
    expect(extractSqlAccesses('srv.Library.dbo.usp_CloseLoan', 'procedureName')).toEqual([]);
    expect(extractSqlAccesses('#usp_Temp', 'procedureName')).toEqual([]);
    expect(extractSqlAccesses('', 'procedureName')).toEqual([]);
  });

  it('statement is the default mode', () => {
    expect(extractSqlAccesses('dbo.usp_CloseLoan')).toEqual([]);
    expect(extractSqlAccesses('EXEC dbo.usp_CloseLoan')).toEqual(
      extractSqlAccesses('EXEC dbo.usp_CloseLoan', 'statement'),
    );
  });
});

describe('extractSqlAccesses in statement mode', () => {
  it('accesses are unique and sorted by kind, then name', () => {
    const sql = [
      'EXEC dbo.usp_RenewLoan;',
      'UPDATE dbo.Members SET Blocked = 1;',
      'SELECT * FROM dbo.Loans JOIN dbo.Books ON Books.Id = Loans.BookId;',
      'SELECT * FROM DBO.LOANS;',
      'INSERT INTO dbo.Fines (Id) VALUES (1);',
      'EXEC [dbo].[usp_AddFine];',
      'EXEC dbo.usp_RenewLoan;',
    ].join('\n');
    expect(extractSqlAccesses(sql)).toEqual([
      { kind: 'executes', name: 'dbo.usp_addfine' },
      { kind: 'executes', name: 'dbo.usp_renewloan' },
      { kind: 'reads', name: 'dbo.books' },
      { kind: 'reads', name: 'dbo.loans' },
      { kind: 'writes', name: 'dbo.fines' },
      { kind: 'writes', name: 'dbo.members' },
    ]);
  });

  it('malformed SQL (unbalanced parentheses) returns what it found without throwing', () => {
    expect(byKind(extractSqlAccesses('SELECT * FROM dbo.Loans WHERE Id IN (SELECT LoanId FROM dbo.Holds'))).toEqual({
      reads: ['dbo.holds', 'dbo.loans'],
      writes: [],
      executes: [],
    });
    expect(byKind(extractSqlAccesses('SELECT * FROM dbo.Loans)) WHERE ((Id = 1'))).toEqual({
      reads: ['dbo.loans'],
      writes: [],
      executes: [],
    });
    expect(byKind(extractSqlAccesses('EXEC dbo.usp_CloseLoan (((; DELETE FROM dbo.Fines'))).toEqual({
      reads: [],
      writes: ['dbo.fines'],
      executes: ['dbo.usp_closeloan'],
    });
    const garbage = [
      '(', ')', ';', ',', 'FROM', 'JOIN (', 'FROM (', 'UPDATE', 'DELETE TOP (1', 'INSERT TOP (', 'MERGE INTO',
      'EXEC @', 'EXEC @rc =', 'WITH x AS (', 'WITH x (a', 'TRUNCATE TABLE', 'SELECT * INTO', "SELECT 'x",
      'SELECT * FROM [dbo].[Loans', 'FETCH NEXT', 'FROM dbo.', 'FROM a..', ')))(((',
    ];
    for (const sql of garbage) expect(() => extractSqlAccesses(sql), sql).not.toThrow();
  });

  it('a cursor FOR UPDATE OF and trigger-style AFTER UPDATE are not DML targets', () => {
    expect(byKind(extractSqlAccesses('DECLARE c CURSOR FOR SELECT Id FROM dbo.Loans FOR UPDATE OF ClosedAt'))).toEqual({
      reads: ['dbo.loans'],
      writes: [],
      executes: [],
    });
    expect(extractSqlAccesses('CREATE TRIGGER dbo.trg_LoanTouched ON dbo.Loans AFTER UPDATE AS SELECT 1')).toEqual([]);
    expect(extractSqlAccesses('CREATE TRIGGER dbo.trg_LoanTouched ON dbo.Loans AFTER INSERT, UPDATE AS SELECT 1')).toEqual([]);
    expect(extractSqlAccesses('CREATE TRIGGER dbo.trg_LoanKept ON dbo.Loans INSTEAD OF DELETE AS SELECT 1')).toEqual([]);
    expect(extractSqlAccesses('CREATE TRIGGER dbo.trg_LoanAny ON dbo.Loans FOR INSERT, UPDATE, DELETE AS SELECT 1')).toEqual([]);
  });

  it('UPDATE STATISTICS, UPDATE() and ON DELETE / ON UPDATE actions are not DML targets', () => {
    expect(extractSqlAccesses('UPDATE STATISTICS dbo.Loans')).toEqual([]);
    expect(extractSqlAccesses("IF UPDATE(ClosedAt) PRINT 'closed'")).toEqual([]);
    expect(
      extractSqlAccesses(
        'CREATE TABLE dbo.Fines (Id INT, LoanId INT REFERENCES dbo.Loans (Id) ON DELETE CASCADE ON UPDATE NO ACTION)',
      ),
    ).toEqual([]);
    expect(extractSqlAccesses('GRANT INSERT, UPDATE, DELETE ON dbo.Fines TO librarian')).toEqual([]);
    expect(extractSqlAccesses('GRANT EXECUTE ON dbo.usp_CloseLoan TO librarian')).toEqual([]);
  });

  it('TOP (n) and TOP n may precede the DML target', () => {
    const sql = [
      'DELETE TOP (10) FROM dbo.Holds WHERE ExpiresAt < @now;',
      'UPDATE TOP (5) PERCENT dbo.Fines SET Paid = 1;',
      'INSERT TOP (1) INTO dbo.LoanArchive (Id) SELECT Id FROM dbo.Loans;',
      'DELETE TOP (SELECT COUNT(*) FROM dbo.Members) FROM dbo.Books;',
    ].join('\n');
    expect(byKind(extractSqlAccesses(sql))).toEqual({
      reads: ['dbo.loans', 'dbo.members'],
      writes: ['dbo.books', 'dbo.fines', 'dbo.holds', 'dbo.loanarchive'],
      executes: [],
    });
  });

  it('a one-part UPDATE or DELETE target that is not an alias gets the dbo schema', () => {
    expect(byKind(extractSqlAccesses('UPDATE Fines SET Paid = 1 FROM dbo.Members m WHERE m.Id = Fines.MemberId'))).toEqual({
      reads: ['dbo.members'],
      writes: ['dbo.fines'],
      executes: [],
    });
    expect(byKind(extractSqlAccesses('DELETE f FROM dbo.Fines AS F WHERE F.Paid = 1'))).toEqual({
      reads: ['dbo.fines'],
      writes: ['dbo.fines'],
      executes: [],
    });
  });

  it('an alias of a derived table, temp table or table variable gives no write', () => {
    expect(byKind(extractSqlAccesses('UPDATE x SET Paid = 1 FROM (SELECT * FROM dbo.Fines) AS x'))).toEqual({
      reads: ['dbo.fines'],
      writes: [],
      executes: [],
    });
    expect(extractSqlAccesses('DELETE t FROM #LateLoans t; UPDATE v SET Paid = 1 FROM @Fines v')).toEqual([]);
  });

  it('a comma list in FROM is read, while commas in other clauses are not tables', () => {
    expect(byKind(extractSqlAccesses('SELECT l.Id, m.Name FROM dbo.Loans l, dbo.Members AS m, dbo.Books WHERE l.MemberId = m.Id ORDER BY l.Id, m.Name'))).toEqual({
      reads: ['dbo.books', 'dbo.loans', 'dbo.members'],
      writes: [],
      executes: [],
    });
    expect(byKind(extractSqlAccesses('SELECT Kind, COUNT(*) FROM dbo.Loans GROUP BY Kind, MemberId'))).toEqual({
      reads: ['dbo.loans'],
      writes: [],
      executes: [],
    });
  });

  it('a parenthesized join reads every table in it', () => {
    expect(byKind(extractSqlAccesses('SELECT * FROM (dbo.Loans l JOIN dbo.Members m ON m.Id = l.MemberId) JOIN dbo.Books b ON b.Id = l.BookId'))).toEqual({
      reads: ['dbo.books', 'dbo.loans', 'dbo.members'],
      writes: [],
      executes: [],
    });
  });

  it('FETCH ... FROM a cursor is not a read', () => {
    expect(extractSqlAccesses('FETCH NEXT FROM loan_cursor INTO @id')).toEqual([]);
    expect(extractSqlAccesses('FETCH ABSOLUTE 3 FROM loan_cursor INTO @id')).toEqual([]);
    expect(byKind(extractSqlAccesses('SELECT * FROM dbo.Loans ORDER BY Id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY'))).toEqual({
      reads: ['dbo.loans'],
      writes: [],
      executes: [],
    });
  });

  it('a CTE name is skipped up to the next top-level semicolon or the end of the batch', () => {
    expect(byKind(extractSqlAccesses('WITH Active AS (SELECT * FROM dbo.Loans) SELECT * FROM Active; SELECT * FROM Active'))).toEqual({
      reads: ['dbo.active', 'dbo.loans'],
      writes: [],
      executes: [],
    });
    expect(byKind(extractSqlAccesses('WITH Active (Id) AS (SELECT Id FROM dbo.Loans) SELECT * FROM [ACTIVE]\nGO\nSELECT * FROM Active'))).toEqual({
      reads: ['dbo.active', 'dbo.loans'],
      writes: [],
      executes: [],
    });
    expect(byKind(extractSqlAccesses('WITH Late AS (SELECT * FROM dbo.Loans) UPDATE Late SET Flag = 1; DELETE Late'))).toEqual({
      reads: ['dbo.loans'],
      writes: ['dbo.late'],
      executes: [],
    });
  });

  it('table options and hints after WITH are not CTEs', () => {
    expect(byKind(extractSqlAccesses('SELECT * FROM dbo.Loans AS l WITH (NOLOCK, INDEX(ix_Loans_Member)), dbo.Members m WITH (NOLOCK)'))).toEqual({
      reads: ['dbo.loans', 'dbo.members'],
      writes: [],
      executes: [],
    });
  });

  it('a MERGE join hint is not a MERGE statement', () => {
    expect(byKind(extractSqlAccesses('SELECT * FROM dbo.Loans l INNER MERGE JOIN dbo.Members m ON m.Id = l.MemberId OPTION (MERGE JOIN)'))).toEqual({
      reads: ['dbo.loans', 'dbo.members'],
      writes: [],
      executes: [],
    });
  });

  it('MERGE INTO with TOP and a USING derived table', () => {
    const sql =
      'MERGE TOP (100) INTO dbo.Fines AS f USING (SELECT LoanId FROM dbo.Loans WHERE Late = 1) AS s ON f.LoanId = s.LoanId ' +
      'WHEN NOT MATCHED BY TARGET THEN INSERT (LoanId) VALUES (s.LoanId) WHEN NOT MATCHED BY SOURCE THEN DELETE;';
    expect(byKind(extractSqlAccesses(sql))).toEqual({
      reads: ['dbo.loans'],
      writes: ['dbo.fines'],
      executes: [],
    });
  });

  it('a UTF-8 byte order mark changes nothing', () => {
    expect(extractSqlAccesses('﻿SELECT * FROM dbo.Loans')).toEqual(extractSqlAccesses('SELECT * FROM dbo.Loans'));
  });
});
