---
"@ctxo/lang-csharp": patch
---

C# syntax tier (tree-sitter): a file-scoped namespace (`namespace Lending.Loans;`) now applies to every type after it, as it does in the Roslyn tier. Symbol, edge and complexity IDs of such files gain the namespace, for example `Loans/LoanService.cs::Lending.Loans.LoanService::class` instead of `Loans/LoanService.cs::LoanService::class`. These IDs change once, on the next `ctxo index`. Files with block namespaces (`namespace X { ... }`) and repos indexed in the Roslyn tier are unchanged.
