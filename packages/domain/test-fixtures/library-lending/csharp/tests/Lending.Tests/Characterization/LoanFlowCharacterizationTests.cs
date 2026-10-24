using LibraryLending.Lending;
using LibraryLending.Lending.Api;
using Xunit;

namespace Lending.Tests.Characterization;

public class LoanFlowCharacterizationTests
{
    [Fact]
    [Trait("Kind", "Characterization")]
    public void BorrowAndRead()
    {
        var controller = new LoansController(new LoanService(null!));
        if (!controller.Borrow(1, 1001)) throw new Exception("the first loan was refused");
        if (controller.Get(1) != "loan 1") throw new Exception("the loan could not be read");
    }
}
