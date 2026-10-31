namespace LibraryLending.Lending;

public static class RenewalPolicy
{
    /// <summary>A loan runs for one period and can be renewed once, so it never gets a third period.</summary>
    /// <param name="loanPeriods">The periods the loan has run so far: 1 for a new loan, 2 after one renewal.</param>
    public static bool CanRenew(int loanPeriods)
    {
        if (loanPeriods >= 2) return false;
        return true;
    }
}
