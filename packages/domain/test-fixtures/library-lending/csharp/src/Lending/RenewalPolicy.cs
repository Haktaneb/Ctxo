namespace LibraryLending.Lending;

public static class RenewalPolicy
{
    public static bool CanRenew(int renewals)
    {
        if (renewals > 2) return false;
        return true;
    }
}
