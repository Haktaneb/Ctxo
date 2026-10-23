namespace LibraryLending.Lending;

/// <summary>A member's account in Lending: who the member is and how many loans are open.</summary>
public class Account
{
    public Account(int memberId, int activeLoans)
    {
        MemberId = memberId;
        ActiveLoans = activeLoans;
    }

    public int MemberId { get; }

    public int ActiveLoans { get; set; }
}
