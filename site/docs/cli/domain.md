---
title: "ctxo domain commands"
description: "verify-domain, contexts-touched, domain rules and domain discover: the CLI of the opt-in @ctxo/domain package."
---

# Domain commands

These commands come with the opt-in `@ctxo/domain` package (`ctxo install domain`). They work on the
[domain knowledge layer](/concepts/domain-knowledge): a registry of named contexts, a markdown card per
context, and checks that keep the two in step with the code. Ctxo checks structure, never meaning.

Without the package, a known domain command name (`verify-domain`, `contexts-touched`, `domain`) prints an
install hint and exits 1, so CI never passes silently. With the package and no registry, the commands print
a hint and exit 0.

## ctxo verify-domain

The CI gate.

```shell
ctxo verify-domain [--since <ref>] [--boundaries by-rung|report] [--json]
```

| Flag | Description |
| --- | --- |
| `--since <ref>` | Also check that every context changed since the merge base of `<ref>` and `HEAD` has a card change or a `Domain-Unchanged` trailer (check 11) |
| `--boundaries <mode>` | `by-rung` or `report`; overrides `domain.boundaries.enforce` for this run |
| `--json` | Print the checks and the summary as JSON on stdout |

### The checks

| # | Check | Severity |
| --- | --- | --- |
| 1 | Registry schema valid, IDs unique and kebab-case, rungs valid; the `domain:` config valid | error |
| 2 | Every context with a rung above `fear` has a card; every listed card exists | error |
| 3 | Every `paths` glob matches at least one indexed file | error |
| 4a | No file owned by two contexts | error |
| 4b | No unowned file outside `unowned.allow` | `domain.coverage.unowned`: `warn` (default) or `error` |
| 5 | Cards have the five template H2 headings in order | error |
| 6 | Rule IDs match `domain.rules.idPattern`, are unique and match `rulePrefix`; IDs in structured test references exist in cards; every rule has a test link, a `Tests:` line or an `Untested:` line | error |
| 7 | Relative links and heading anchors in cards resolve (external URLs are not fetched) | error |
| 8 | Generated loader files match what `ctxo domain rules` would write, and no hand-written file blocks an expected path | error |
| 9 | `context-map.md` has a `Context` / `Rung` table that agrees with the registry (a missing file is a warning) | error |
| 10 | Boundaries: edges outside `contracts` | error for `blockingRungs` in `by-rung` mode, else warning |
| 11 | With `--since`: no unresolved touched contexts | error |

Check 6 also covers the links of the domain graph:

- A `Tests:` or `Code:` value whose file does not exist (or names a directory) is an error:
  `LEND-03: Tests file "<file>" does not exist`, `LEND-03: Code file "<file>" does not exist`.
- A value with `::` is a symbol ID. One the index does not hold is a warning, and the link falls back to its file:
  `LEND-03: Code: "<value>" is not an indexed symbol; it links to its file`. C# symbol IDs differ between the
  Roslyn and tree-sitter tiers, so C# cards are safer with file paths in `Code:` lines.
- A `rule:` comment in production code that names an unknown rule warns (`rule: comment names unknown rule
  LEND-09`), but only when its prefix is a rule prefix, so `# rule: E501` in a linter comment stays silent.

A registry that does not parse or validate skips checks 2 to 11. Day one is green: with the init skeleton (no contexts) or a partial registry,
unowned files and a missing context map are warnings until you set `domain.coverage.unowned: error`.

### Exit codes and `--json`

| Code | Meaning |
| --- | --- |
| `0` | No errors (warnings allowed), or no registry (a hint is printed) |
| `1` | At least one error, or a usage error |
| `2` | No index (run `ctxo index`), a base ref that cannot be found, a git failure, or an internal error |

The human report goes to stderr. With `--json`, stdout holds
`{ "registry", "checks", "summary", "exitCode" }` when the checks ran. **On exit 2 and on the no-registry path
stdout is empty** and the message is on stderr, so a script must read the exit code and not only parse stdout.

```shell
ctxo verify-domain --since origin/main --json > domain-report.json
echo "exit: $?"
```

In CI, check out with full history (`actions/checkout` with `fetch-depth: 0`); see
[CI integration](/reference/ci-integration#domain-gate).

## ctxo contexts-touched

Which named contexts a set of changes touched, and whether each is resolved.

```shell
ctxo contexts-touched [--since <ref>] [--committed | --staged] [--json] [--check]
```

| Flag | Description |
| --- | --- |
| `--since <ref>` | Compare against the merge base of `<ref>` and `HEAD` (default: `domain.guard.base`, else the merge base with `origin/HEAD`, else `main` or `master`) |
| `--committed` | Only the commits of the range, not the working tree |
| `--staged` | Only the staged changes |
| `--json` | Print the report as JSON on stdout |
| `--check` | Exit 1 when a touched context has no card change and no `Domain-Unchanged` trailer |

A context is touched when its `paths` hold a changed non-test file. Its `status` is `card-changed`,
`acknowledged` (a trailer in the range), `unresolved`, or `no-card` (a context at rung `fear` without a card
has nothing to fold into). Exit 2 means registry problems, a base that cannot be found, or a git failure.

A commit acknowledges a change that left behaviour as it was:

```text
Domain-Unchanged: lending (refactor only)
```

An empty commit (`git commit --allow-empty`) carries it just as well.

## ctxo domain rules

Generates one pointer file per context that has a card, so the agent reads the card before it edits the
context's code.

```shell
ctxo domain rules --write | --check
```

`--write` creates `.claude/rules/ctxo-context-<id>.md` (and `.cursor/rules/ctxo-context-<id>.mdc` when
`.cursor/` exists), rewrites outdated files and deletes stale ones. `--check` exits 1 when a generated file is
missing, outdated or stale, **or blocked**: a hand-written file without the generated marker at a path a
generated file belongs at. A blocked file is never overwritten; rename it or delete it, then run `--write`.
When only blocked files exist, `--check` prints that advice and not the "run --write" hint.

## ctxo domain discover

Proposes the conventions it finds in the repository: tracker prefixes (a prefix seen in 5 or more commit
subjects or branch names), `Trait` keys that carry rule-like IDs, and test folders no default glob covers.

```shell
ctxo domain discover [--json] [--write]
```

It prints the evidence and a proposed config, and writes only with `--write`, which merges the proposal into
`.ctxo/config.yaml` (it adds values and removes none).

## See also

- [Domain knowledge layer](/concepts/domain-knowledge) - the concepts and the adoption ladder
- [`ctxo init`](/cli/init) - `--domain` sets the layer up
- [Config schema](/reference/config-schema#domain) - the `domain:` keys
