---
"@ctxo/cli": minor
"@ctxo/domain": minor
"@ctxo/lang-typescript": minor
"@ctxo/lang-csharp": minor
"@ctxo/lang-java": minor
"@ctxo/lang-java-analyzer": minor
"@ctxo/lang-go": minor
---

Business rules that live only in code are invisible to the cards an agent reads, so it can break them without breaking a test; this release finds them (#156 Phase 4). The TypeScript, C#, Java and Go plugins now detect literal comparisons, string normalization, retry and timeout values and public endpoints in every tier they have with one shared rule set (the analyzers collect evidence behind `--facts=`), and with `@ctxo/domain` and its registry file (`domain.registry`), or with `index.facts: true`, every indexed file of these languages gets a `facts` array (possibly empty) in its index JSON on the next re-index, so run a full `ctxo index` once after upgrading and again after adding the registry. Without a registry `@ctxo/domain` requests no facts, and the index is byte-identical to a run without the package. A fact extraction failure in any of the four plugins warns on stderr and gives `facts: []` for that file; TypeScript `typeof` guards give no facts; in `ctxo watch` a saved Go file takes its facts from the tree-sitter tier and a saved Java file reads the keep-alive analyzer's result without starting a second JVM. `@ctxo/domain` adds a text-scan fallback, `find_shadow_specs` and `get_context_map` (14 core tools, 18 with the package), `ctxo domain shadow-specs <context>`, `ctxo domain map`, `shadow-specs.yaml` resolutions and `ctxo verify-domain` check 12, plus the `domain.facts`, `domain.tests.characterization`, `domain.tests.contract` and `domain.rungs` config keys. Fingerprints go into `shadow-specs.yaml` as YAML single-quoted scalars (`- fingerprint: '...'`), the form `ctxo domain shadow-specs` prints. When `ctxo index` builds the domain graph but not the candidates or the maturity facts, it removes both loop artifacts, so the tools ask for a new `ctxo index` instead of serving old data. The `ctxo-domain-fold` skill marker moved to v0.16: run `ctxo init --domain` or `ctxo doctor --fix` after upgrading to refresh copies installed by 0.15.
