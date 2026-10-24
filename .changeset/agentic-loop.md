---
"@ctxo/cli": minor
"@ctxo/domain": minor
"@ctxo/lang-typescript": minor
"@ctxo/lang-csharp": minor
"@ctxo/lang-java": minor
"@ctxo/lang-java-analyzer": minor
"@ctxo/lang-go": minor
---

Fact detectors and the agentic loop tools of the domain knowledge layer (#156 Phase 4). The TypeScript, C#, Java and Go plugins now detect literal comparisons, string normalization, retry and timeout values and public endpoints in both tiers with one shared rule set (the analyzers collect evidence behind `--facts=`), and with `@ctxo/domain` or `index.facts: true` every indexed file of these languages gets a `facts` array (possibly empty) in its index JSON on the next re-index, so run a full `ctxo index` once after upgrading. `@ctxo/domain` adds a text-scan fallback, `find_shadow_specs` and `get_context_map` (14 core tools, 18 with the package), `ctxo domain shadow-specs <context>`, `ctxo domain map`, `shadow-specs.yaml` resolutions and `ctxo verify-domain` check 12, plus the `domain.facts`, `domain.tests.characterization`, `domain.tests.contract` and `domain.rungs` config keys.
