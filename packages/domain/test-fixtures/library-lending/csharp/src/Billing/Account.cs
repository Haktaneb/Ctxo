namespace LibraryLending.Billing;

/// <summary>A payer's account in Billing: who pays and what is owed, in cents.</summary>
public class Account
{
    public Account(int payerId)
    {
        PayerId = payerId;
    }

    public int PayerId { get; }

    public int Balance { get; set; }
}
