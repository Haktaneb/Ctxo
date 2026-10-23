---
"@ctxo/lang-csharp": patch
---

C# syntax tier (tree-sitter): a file-scoped namespace (`namespace Lending.Loans;`) now applies to every type after it, as it does in the Roslyn tier. Symbol, edge and complexity IDs of such files gain the namespace, for example `Loans/LoanService.cs::Lending.Loans.LoanService::class` instead of `Loans/LoanService.cs::LoanService::class`, and base types are resolved through the file's namespace, its `using` directives, the global namespace, then a unique name match.

Who is affected: projects indexed in the syntax tier, that is, machines without a .NET 8+ SDK, and runs where the Roslyn helper fails and C# falls back to tree-sitter. Their IDs for file-scoped namespace files change once, on the next `ctxo index`. Files with block namespaces (`namespace X { ... }`) and runs in the Roslyn tier are unchanged.
