using LibraryLending.Billing;
using Xunit;

namespace Billing.Tests.Contract;

public class ChargeServiceContractTests
{
    [Fact]
    [Trait("Kind", "Contract")]
    public void ChargeFineAcceptsAnyPayer()
    {
        IChargeService charges = new InvoiceLedger();
        charges.ChargeFine(1, 0);
        charges.ChargeFine(2, 14);
    }
}
