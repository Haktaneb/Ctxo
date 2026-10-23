namespace LibraryLending.Billing;

/// <summary>The only door into Billing for other contexts.</summary>
public interface IChargeService
{
    void ChargeFine(int payerId, int overdueDays);
}
