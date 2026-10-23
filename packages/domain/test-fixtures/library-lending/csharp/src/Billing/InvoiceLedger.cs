namespace LibraryLending.Billing;

public class InvoiceLedger : IChargeService
{
    private const int CentsPerDay = 2;
    private readonly Dictionary<int, Account> _accounts = new();

    public void ChargeFine(int payerId, int overdueDays)
    {
        if (!_accounts.TryGetValue(payerId, out var account))
        {
            account = new Account(payerId);
            _accounts[payerId] = account;
        }
        account.Balance += overdueDays * CentsPerDay;
    }

    public int BalanceOf(int payerId)
    {
        return _accounts.TryGetValue(payerId, out var account) ? account.Balance : 0;
    }
}
