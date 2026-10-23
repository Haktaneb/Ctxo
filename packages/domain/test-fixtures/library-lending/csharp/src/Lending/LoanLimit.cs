namespace LibraryLending.Lending;

public static class LoanLimit
{
    public const int MaxLoans = 5;

    public static bool CanBorrow(Account account)
    {
        return account.ActiveLoans < MaxLoans;
    }
}
