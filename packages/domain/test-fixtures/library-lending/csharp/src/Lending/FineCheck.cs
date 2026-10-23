namespace LibraryLending.Lending;

/// <summary>Lending's own check of a member's unpaid fine; it never calls into Billing.</summary>
public static class FineCheck
{
    // rule: LEND-04
    [System.Diagnostics.Contracts.Pure]
    public static bool BlocksBorrowing(Account account)
    {
        return account.UnpaidFineCents > 0;
    }
}
