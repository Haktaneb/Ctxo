// Fact fixture (PR 4, issue #156): attribute routes in a file-scoped namespace, next to a
// comparison in the same method, so both facts carry the same namespaced symbol ID.
using Microsoft.AspNetCore.Mvc;

namespace Lending.Facts.Shelves;

[ApiController]
[Route("api/[controller]")]
public class ShelfController : ControllerBase
{
    [HttpGet("{id}")]
    public int Get(int id)
    {
        if (id > 40) return 1;
        return 0;
    }
}
