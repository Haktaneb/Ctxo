---
"@ctxo/lang-java": patch
---

The Java syntax tier (tree-sitter) now indexes the members the JDT full tier indexes, with the same symbol ids: methods and fields after the constants of an enum, interface and annotation constants, record compact constructors, and the members of anonymous class bodies. It also indexes the members of enum constant bodies, which own facts in both tiers. Existing ids are unchanged; a re-index only adds symbols.

The `named.method` value of an annotation now keeps enum constants as written, such as `RequestMethod.POST`, so both tiers read the same HTTP verbs. Spring repositories that use `method = RequestMethod.X` see a one-time annotation diff on the next re-index.
