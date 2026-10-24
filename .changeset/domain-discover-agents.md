---
"@ctxo/domain": minor
---

Agents adopting the domain layer never found `ctxo domain discover`, and its proposal turned security IDs into tracker keys, missed the GitHub issue tracker and missed contract tests marked by attributes or file names. Now:

- The `ctxo-domain-fold` skill tells agents to run `ctxo domain discover` first when adopting or tuning the domain config, and `get_context_map` and `ctxo domain map` add a hint naming the command while the conventions are all at their defaults.
- Well-known external ID families (CWE, CVE, ADR, RFC, ISO, GHSA, OWASP and more) are reported as "external IDs, kept from linking" and proposed for `domain.rules.trackerPrefixes`, so a plain `CWE-22` never links as a rule ID.
- GitHub `#N` references (subjects, `(#N)` squash suffixes, `type/N-slug` branches) and lowercase `name-NN` branch families are reported as evidence.
- Characterization and contract tests are proposed from Trait or Category values (`Trait:Category=StorageContract`), custom test attributes (`StorageContractFact`) and file names (`**/*ContractTests.cs` as a path glob), not only from folders. `--write` still adds values and removes none.
- `--json` gains `externalIds`, `githubIssues`, `otherIdentifiers` and `testKindMarkers` in the evidence and `externalIdPrefixes`, `characterizationAnnotations` and `contractAnnotations` in the proposal; existing fields are unchanged.
