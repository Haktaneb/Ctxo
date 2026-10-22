// A stand-in for Dapper's SqlMapper, so the fixture needs no NuGet restore.
// Only the type, member and parameter names match the real library.
using System.Data;

namespace Dapper;

public static class SqlMapper
{
    public static IEnumerable<T> Query<T>(this IDbConnection cnn, string sql, object? param = null, IDbTransaction? transaction = null, bool buffered = true, int? commandTimeout = null, CommandType? commandType = null) =>
        throw new NotSupportedException();

    public static int Execute(this IDbConnection cnn, string sql, object? param = null, IDbTransaction? transaction = null, int? commandTimeout = null, CommandType? commandType = null) =>
        throw new NotSupportedException();
}
