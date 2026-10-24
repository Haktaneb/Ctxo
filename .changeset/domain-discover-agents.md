---
"@ctxo/domain": minor
---

Agents adopting the domain layer never found `ctxo domain discover`, and its proposal turned security IDs into tracker keys, missed the GitHub issue tracker and missed contract tests marked by attributes or file names. Now:

- The `ctxo-domain-fold` skill tells agents to run `ctxo domain discover` first when adopting or tuning the domain config. The `get_context_map` description names it, the "no registry" and "no domain graph" hints name it, and `get_context_map` and `ctxo domain map` add a hint while the conventions are all at their defaults and the last `ctxo index` found that discovery would add something (recorded in `maturity.json`).
- Well-known external ID families (CWE, CVE, ADR, RFC, ISO, GHSA, OWASP and more) are reported as "external IDs: references, not rule IDs; no config needed" and never proposed. A plain mention of them never linked as a rule ID, since only IDs that exist in a card link; a family that equals a card rule prefix is flagged.
- GitHub issue references (subjects, `(#N)` squash suffixes, `N-slug` branches) are reported with their share and named as the issue tracker when they are the largest family; lowercase `name-NN` branch families are reported as lowercase identifiers, marked as possible tracker keys when their upper case is a known prefix. Both are evidence only.
- Characterization and contract tests are proposed from Trait or Category values that name the kind (`Trait:Category=StorageContract`), custom test attributes (`StorageContractFact`) and test file names (`**/*ContractTests.cs` as a path glob), not only from folders. A file named after a non-test class (`LoanContractTests.cs` next to `LoanContract`) and a value that only contains the word (`ContractRenewal`) are not proposed. `--write` still adds values and removes none; remove a wrong value by hand.
- `--json`: external ID families no longer appear in `evidence.trackerKeys`. The evidence gains `externalIds`, `githubIssues`, `otherIdentifiers` and `testKindMarkers`, the proposal `characterizationAnnotations` and `contractAnnotations`; other fields are unchanged.
