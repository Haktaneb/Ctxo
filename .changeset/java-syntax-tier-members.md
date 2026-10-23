---
"@ctxo/lang-java": patch
"@ctxo/lang-java-analyzer": patch
---

The Java syntax tier (tree-sitter) now indexes the members the JDT full tier indexes, with the same symbol ids: methods and fields after the constants of an enum, interface and annotation constants, record compact constructors, and the members of anonymous class and enum constant bodies. Existing ids are unchanged; a re-index only adds symbols. Every fact owner is now a symbol in both tiers.

The JDT full tier (`@ctxo/lang-java-analyzer`) now also walks the class bodies of enum constants (`GOLD { void q() {} }`). Their methods and fields become symbols with the ids the syntax tier uses, and the calls, uses and SQL call sites inside them are reported like those of any other member. The constants' arguments are still not walked.

The `named.method` value of an annotation now keeps enum constants as written, such as `RequestMethod.POST`, so both tiers read the same HTTP verbs. Spring repositories that use `method = RequestMethod.X` see a one-time annotation diff on the next re-index.
