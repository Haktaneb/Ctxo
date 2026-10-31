// Fact fixture (PR 4, issue #156): a minimal API in top-level statements. Its facts belong to the
// file's module symbol in both tiers.
using Microsoft.AspNetCore.Builder;

var app = new WebApplication();
app.MapGet("/loans", () => 0);
