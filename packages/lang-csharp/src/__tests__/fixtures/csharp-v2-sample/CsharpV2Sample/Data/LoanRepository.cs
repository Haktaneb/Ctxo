using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Lending.Data;

public sealed class Loan
{
    public int Id { get; set; }

    public int MemberId { get; set; }
}

public interface ILoanRepository
{
    IEnumerable<Loan> GetActive();
}

public sealed class LendingContext : DbContext
{
}

// One method per SQL call-site row of the lang-csharp tests.
public sealed class LoanRepository : ILoanRepository
{
    private const string ActiveLoansSql =
        "SELECT l.Id, l.MemberId FROM dbo.Loans l JOIN [dbo].[Members] m ON m.Id = l.MemberId WHERE l.ClosedAt IS NULL";

    private static readonly string StaticSql = "SELECT * FROM dbo.Holds";

    private readonly IDbConnection _db;
    private readonly SqlConnection _connection;
    private readonly LendingContext _context;

    public LoanRepository(IDbConnection db, SqlConnection connection, LendingContext context)
    {
        _db = db;
        _connection = connection;
        _context = context;
    }

    public IEnumerable<Loan> GetActive() => _db.Query<Loan>(ActiveLoansSql);

    public IEnumerable<Loan> GetByIds(int[] ids) =>
        _db.Query<Loan>("SELECT * FROM dbo.Loans WHERE Id IN @ids", new { ids });

    public void Close(int loanId)
    {
        var cmd = new SqlCommand("usp_CloseLoan", _connection);
        cmd.CommandType = CommandType.StoredProcedure;
        cmd.ExecuteNonQuery();
    }

    public void Archive(DateTime cutoff)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "INSERT INTO dbo.LoanArchive (Id) " + "SELECT Id FROM dbo.Loans WHERE ClosedAt < @cutoff";
        cmd.ExecuteNonQuery();
    }

    public void Notify(int memberId) =>
        _db.Execute("[dbo].[usp_NotifyMember]", new { memberId }, commandType: CommandType.StoredProcedure);

    public IEnumerable<Loan> ByDefinition(int id) =>
        _db.Query<Loan>(new CommandDefinition("SELECT * FROM dbo.Loans WHERE MemberId = @id", new { id }));

    public int ProcByDefinition(int id) =>
        _db.Execute(new CommandDefinition("dbo.usp_RenewLoan", new { id }, commandType: CommandType.StoredProcedure));

    public void BulkLoad(DataTable rows)
    {
        var bulk = new SqlBulkCopy(_connection) { DestinationTableName = "dbo.LoanStaging" };
        bulk.WriteToServer(rows);
    }

    public List<Loan> RawEf(int id)
    {
        var loans = _context.Set<Loan>().FromSqlRaw(@"SELECT * FROM dbo.Loans WHERE MemberId = {0}", id).ToList();
        _context.Database.ExecuteSqlRaw("""DELETE FROM dbo.Holds WHERE ExpiresAt < GETDATE()""");
        return loans;
    }

    public IEnumerable<Loan> Dynamic(string table) => _db.Query<Loan>("SELECT * FROM " + table);

    public IEnumerable<Loan> StaticReadonly() => _db.Query<Loan>(StaticSql);

    public int Broken() => _db.Execute("SELEC * FROM dbo.Loans");
}
