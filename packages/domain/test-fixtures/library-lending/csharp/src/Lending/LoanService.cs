using LibraryLending.Billing;

namespace LibraryLending.Lending;

public class LoanService
{
    private readonly IChargeService _charges;

    public LoanService(IChargeService charges)
    {
        _charges = charges;
    }

    public bool Borrow(Account account, int bookId)
    {
        if (!LoanLimit.CanBorrow(account)) return false;
        account.ActiveLoans += 1;
        return bookId > 0;
    }

    public void ReturnLate(Account account, int overdueDays)
    {
        account.ActiveLoans -= 1;
        _charges.ChargeFine(account.MemberId, overdueDays);
    }
}
