// Fact fixture (PR 4, issue #156): literal comparisons, normalization calls and retry/timeout
// values, next to trivial literals, a constant without a retry/timeout name and code in a string.
namespace Lending.Facts;

public static class LoanPolicy
{
    public const int MaxRetries = 3;

    public static readonly System.TimeSpan HoldTimeout = System.TimeSpan.FromMinutes(90);

    private const int SettlementDays = 3;

    public static bool CanBorrow(int openLoans, string? member)
    {
        if (member == null) return false;
        if (openLoans >= 5 && member != "") return false;
        return true;
    }

    public static decimal Fee(string tier)
    {
        switch (tier)
        {
            case "gold": return 0m;
            case "": return 1m;
            default: return 2.5m;
        }
    }

    public static string Key(string email) => email.Trim().ToLowerInvariant();

    public static string Label(int days) => days is > 14 ? "late" : "ok";

    private static System.Threading.Tasks.Task Remind() => System.Threading.Tasks.Task.Delay(System.TimeSpan.FromSeconds(30));

    private static string Note() => "if (x > 5) timeout = 30";
}
