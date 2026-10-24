---
"@ctxo/lang-go": patch
---

The tree-sitter syntax tier now drops type parameters from the receiver in method IDs, as the full tier (ctxo-go-analyzer) does: `func (l *List[T]) Get()` is `List.Get::method` in both tiers, not `List[T].Get::method`. This applies to symbols, complexity and facts. Syntax-tier IDs of generic methods change once, on the next `ctxo index`; methods on non-generic types keep their IDs.
