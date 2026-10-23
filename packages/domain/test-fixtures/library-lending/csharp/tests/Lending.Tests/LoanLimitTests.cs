using LibraryLending.Lending;
using Xunit;

namespace Lending.Tests;

public class LoanLimitTests
{
    [Fact]
    [Trait("Rule", "LEND-03")]
    public void RejectsTheSixthLoan()
    {
        if (LoanLimit.CanBorrow(new Account(1, 5))) throw new Exception("the sixth loan was allowed");
        if (!LoanLimit.CanBorrow(new Account(1, 4))) throw new Exception("the fifth loan was refused");
    }
}
