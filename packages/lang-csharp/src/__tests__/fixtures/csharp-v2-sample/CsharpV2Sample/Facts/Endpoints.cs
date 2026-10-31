// Fact fixture (PR 4, issue #156): minimal API routes.
using Microsoft.AspNetCore.Builder;

namespace Lending.Facts
{
    public static class Endpoints
    {
        public static void Map(WebApplication app)
        {
            app.MapGet("/holds/{id}", (int id) => id);
            app.MapPost("/holds", () => 0);
        }
    }
}
