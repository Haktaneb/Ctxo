---
title: "get_rule"
description: "One domain rule with its tests, implementing symbols, decisions and provenance (needs @ctxo/domain)."
---

# get_rule

A business rule lives in three places: the card that states it, the tests that pin it and the code that
implements it. `get_rule` puts them side by side for one rule ID, and says for every link how Ctxo found it, so
an agent about to change the rule's code knows which tests must stay green and which decisions explain the rule.

::: info Needs @ctxo/domain
This tool is registered only when the opt-in [`@ctxo/domain`](/concepts/domain-knowledge) package is installed
(`ctxo install domain`). Ctxo has 14 core tools, plus [`get_domain_context`](/mcp-tools/get-domain-context) and
`get_rule` with the package. It reads the domain graph `ctxo index` writes (`.ctxo/index/domain/graph.json`).
:::

## Parameters

| Name     | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `ruleId` | string | yes      | A rule ID as written in a card heading, for example `LEND-03`. The variants `LEND03`, `Lend03` and `lend_03` find the same rule, and so does the `id` of a domain-scope hit of `get_ranked_context` (`rule:LEND-03`) |

## Example

```json
{ "ruleId": "LEND-03" }
```

## Response

From the synthetic library-lending sample (TypeScript variant):

```json
{
  "rule": {
    "ruleId": "LEND-03",
    "title": "A member holds at most five loans",
    "text": "",
    "line": 20,
    "context": { "id": "lending", "name": "Lending", "rung": "pinned" },
    "card": "docs/domain/lending/domain.md"
  },
  "tests": [
    {
      "file": "src/lending/__tests__/loan-limit.test.ts",
      "sources": [{ "source": "card-tests", "file": "docs/domain/lending/domain.md", "line": 21 }]
    },
    {
      "file": "src/lending/__tests__/loan-limit.test.ts",
      "symbolId": "src/lending/__tests__/loan-limit.test.ts::loan limit > LEND-03 rejects the sixth loan::function",
      "testName": "LEND-03 rejects the sixth loan",
      "sources": [{ "source": "test-title", "file": "src/lending/__tests__/loan-limit.test.ts", "line": 5 }]
    }
  ],
  "symbols": [
    {
      "file": "src/lending/loan-limit.ts",
      "symbolId": "src/lending/loan-limit.ts::canBorrow::function",
      "sources": [{ "source": "card-code", "file": "docs/domain/lending/domain.md", "line": 22 }]
    }
  ],
  "decisions": [
    {
      "id": "decision:lending/2026-09-12-1",
      "date": "2026-09-12",
      "text": "Loan limit raised from 3 to 5 (LEND-03). [spec](../../specs/loan-limit.md), #123, [ADR-007](../../adr/adr-007-loan-limit.md)",
      "card": "docs/domain/lending/domain.md",
      "line": 37,
      "rules": ["LEND-03"],
      "provenance": [
        { "kind": "file", "path": "docs/specs/loan-limit.md", "exists": true, "label": "spec" },
        { "kind": "external", "value": "#123" },
        { "kind": "file", "path": "docs/adr/adr-007-loan-limit.md", "exists": true, "label": "ADR-007" }
      ]
    }
  ],
  "provenance": [
    { "kind": "file", "path": "docs/specs/loan-limit.md", "exists": true, "label": "spec", "decision": "decision:lending/2026-09-12-1" },
    { "kind": "external", "value": "#123", "decision": "decision:lending/2026-09-12-1" },
    { "kind": "file", "path": "docs/adr/adr-007-loan-limit.md", "exists": true, "label": "ADR-007", "decision": "decision:lending/2026-09-12-1" }
  ],
  "_meta": { "totalItems": 3, "returnedItems": 3, "truncated": false }
}
```

In the C# variant the same rule also lists the test method `LoanLimitTests.RejectsTheSixthLoan` with the source
`{ "source": "annotation", "annotation": "Trait" }`, from `[Trait("Rule", "LEND-03")]`.

| Field | Meaning |
| --- | --- |
| `rule` | `ruleId`, `title`, `text` (the rule body under its heading, without the `Tests:`, `Code:` and `Untested:` lines), `line`, `untested` when the card gives a reason, the owning `context` and the `card` |
| `tests` | Every test linked to the rule: `file`, `symbolId` when the link names a symbol, `testName` (the captured test title, else the symbol's name), `fallback: true` when a card names a symbol ID the index does not hold, and `sources` |
| `symbols` | Every symbol or file that implements the rule, with the same shape |
| `decisions` | Card decisions that mention the rule ID, newest first, capped at 50 with `decisionsTotal` |
| `provenance` | The provenance of those decisions, each entry once, with the `decision` it came from |
| `unresolved` | Only when present: card `Tests:` or `Code:` values that resolve to no file (`missing-file`) or name a symbol the index does not hold (`not-a-symbol`), with `field`, `value`, `file`, `line` and `reason` |

### Link sources

| Source | Link | Found by |
| --- | --- | --- |
| `annotation` | test | An xUnit `Trait` whose key is in `domain.tests.ruleTraitKeys` (default `Rule`) and whose value is the ID |
| `category` | test | An NUnit `Category`, MSTest `TestCategory` or JUnit `Tag` whose value starts with the ID |
| `test-title` | test | A test title that starts with the ID (`it(`, `test(`, `describe(`, `t.Run(`, `@DisplayName(`, `[Fact(DisplayName =`) |
| `rule-comment` | test or code | A `rule: LEND-03` comment in any comment style; in a test file it links a test, elsewhere a symbol |
| `mention` | test | The ID (or a variant) written anywhere else in a test file |
| `card-tests` | test | The card's `Tests:` line |
| `card-code` | code | The card's `Code:` line |

Every source names the file and line where Ctxo saw it. A link exists only to an ID that a card defines.

## Graceful misses

| Situation | Response |
| --- | --- |
| No card defines the ID | `{ "found": false, "hint": "No rule LEND-99 in any card." }` |
| No registry, an invalid or changed registry, or no graph | `{ "found": false, "hint": "..." }` with the same hints as [`get_domain_context`](/mcp-tools/get-domain-context#graceful-misses) |
| A card or the glossary changed since the last index | The answer from the graph, plus `stale: true` and a hint to run `ctxo index` |

## Truncation

`tests`, `symbols`, `provenance` and `unresolved` are truncatable: when the response exceeds the limit, the
largest is cut and `_meta.hint` says where to look next. `decisions` is capped at the source instead.

## When to use

- A change touches code that `rulesAffected` (on [`get_blast_radius`](/mcp-tools/get-blast-radius)) or
  [`get_domain_context`](/mcp-tools/get-domain-context) links to a rule: which tests must stay green?
- A rule has no tests: `tests` is empty and `rule.untested` says why (or nothing does, and `ctxo verify-domain`
  reports it).
- Why is the rule what it is: `decisions` and `provenance`.

## Related tools

- [`get_domain_context`](/mcp-tools/get-domain-context): the whole card of a context.
- [`get_ranked_context`](/mcp-tools/get-ranked-context) with `scope: "domain"`: find a rule by words.
- [`get_why_context`](/mcp-tools/get-why-context): `decisions` for a symbol's context.
