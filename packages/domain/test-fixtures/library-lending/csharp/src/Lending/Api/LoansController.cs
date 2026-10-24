using Microsoft.AspNetCore.Mvc;

namespace LibraryLending.Lending.Api;

[ApiController]
[Route("api/[controller]")]
public class LoansController : ControllerBase
{
    private readonly LoanService _loans;

    public LoansController(LoanService loans)
    {
        _loans = loans;
    }

    [HttpGet("{id}")]
    public string Get(int id)
    {
        return "loan " + id;
    }

    // rule: LEND-03
    [HttpPost]
    public bool Borrow(int memberId, int bookId)
    {
        return _loans.Borrow(new Account(memberId, 0), bookId);
    }
}
