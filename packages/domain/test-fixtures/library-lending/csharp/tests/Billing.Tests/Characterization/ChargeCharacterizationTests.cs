using LibraryLending.Billing;
using Xunit;

namespace Billing.Tests.Characterization;

public class ChargeCharacterizationTests
{
    [Fact]
    [Trait("Kind", "Characterization")]
    public void ChargesAFine()
    {
        IChargeService charges = new InvoiceLedger();
        charges.ChargeFine(7, 3);
    }
}
