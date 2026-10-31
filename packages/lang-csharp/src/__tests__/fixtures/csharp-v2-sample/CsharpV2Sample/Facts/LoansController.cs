// Fact fixture (PR 4, issue #156): attribute routes under a controller route.
using Microsoft.AspNetCore.Mvc;

namespace Lending.Facts
{
    [ApiController]
    [Route("api/[controller]")]
    public class LoansController : ControllerBase
    {
        [HttpGet("{id}")]
        public int Get(int id) => id;

        [HttpPost]
        public int Borrow(int id) => id;

        [HttpGet("/health")]
        public string Health() => "ok";
    }
}
