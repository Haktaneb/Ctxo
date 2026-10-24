---
title: "find_shadow_specs"
description: "Business-looking code in a named context that no card rule pins yet, with fingerprints and resolutions: the Deletion Test (needs @ctxo/domain)."
---

# find_shadow_specs

A rule that lives only in code is a rule nobody can see. `if (loans.length >= 5)` is the loan limit whether or
not a card says so, and an agent that "simplifies" it breaks the business without breaking a test.
`find_shadow_specs` runs the Deletion Test on a context: it lists the code that looks like business logic (literal
comparisons, string normalization, retry and timeout values, endpoints, owned tables and procedures) and the rules
without tests, so each one can be pinned by a rule or recorded as not a rule.

::: info Needs @ctxo/domain
This tool is registered only when the opt-in [`@ctxo/domain`](/concepts/domain-knowledge) package is installed
(`ctxo install domain`). Ctxo has 14 core tools; 18 with the package: [`get_domain_context`](/mcp-tools/get-domain-context),
[`get_rule`](/mcp-tools/get-rule), `find_shadow_specs` and [`get_context_map`](/mcp-tools/get-context-map). It reads
`.ctxo/index/domain/shadow-candidates.json`, which `ctxo index` writes, and the context's `shadow-specs.yaml` on
every call.
:::

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | string | yes | A context ID from the registry, for example `lending` |
| `kinds` | string[] | no | Candidate kinds to return: `literal-comparison`, `normalization`, `retry-timeout`, `endpoint`, `data-resource`, `procedure`, `rule-without-tests`. Omitted or an empty list returns all kinds |
| `includeResolved` | boolean | no | Also return resolved candidates with their resolution (default `false`) |

## Example

```json
{ "context": "lending" }
```

## Response

From a synthetic library-lending project (TypeScript), with no `shadow-specs.yaml` yet:

```json
{
  "context": { "id": "lending", "name": "Lending", "rung": "pinned" },
  "counts": {
    "open": 6,
    "resolved": 0,
    "byKind": {
      "literal-comparison": { "open": 1, "resolved": 0 },
      "normalization": { "open": 2, "resolved": 0 },
      "retry-timeout": { "open": 1, "resolved": 0 },
      "endpoint": { "open": 1, "resolved": 0 },
      "rule-without-tests": { "open": 1, "resolved": 0 }
    }
  },
  "shadowSpecs": [
    {
      "fingerprint": "rule-without-tests | LEND-04 | A hold expires after seven days",
      "kind": "rule-without-tests",
      "file": "docs/domain/lending/domain.md",
      "line": 12,
      "ruleId": "LEND-04",
      "text": "LEND-04 A hold expires after seven days",
      "source": "card"
    },
    {
      "fingerprint": "retry-timeout | loan-policy.HOLD_TIMEOUT_MS | HOLD_TIMEOUT_MS = 604800000",
      "kind": "retry-timeout",
      "file": "src/lending/loan-policy.ts",
      "line": 1,
      "symbolId": "src/lending/loan-policy.ts::HOLD_TIMEOUT_MS::variable",
      "text": "HOLD_TIMEOUT_MS = 604800000",
      "detail": { "name": "HOLD_TIMEOUT_MS", "value": "604800000" },
      "source": "native"
    },
    {
      "fingerprint": "literal-comparison | loan-policy.canBorrow | loans.length >= 5",
      "kind": "literal-comparison",
      "file": "src/lending/loan-policy.ts",
      "line": 4,
      "symbolId": "src/lending/loan-policy.ts::canBorrow::function",
      "text": "loans.length >= 5",
      "detail": { "operator": ">=", "literal": "5" },
      "source": "native"
    },
    {
      "fingerprint": "normalization | loan-policy.memberKey | email.trim()",
      "kind": "normalization",
      "file": "src/lending/loan-policy.ts",
      "line": 9,
      "symbolId": "src/lending/loan-policy.ts::memberKey::function",
      "text": "email.trim()",
      "detail": { "method": "trim" },
      "source": "native"
    },
    {
      "fingerprint": "normalization | loan-policy.memberKey | email.trim().toLowerCase()",
      "kind": "normalization",
      "file": "src/lending/loan-policy.ts",
      "line": 9,
      "symbolId": "src/lending/loan-policy.ts::memberKey::function",
      "text": "email.trim().toLowerCase()",
      "detail": { "method": "toLowerCase" },
      "source": "native"
    },
    {
      "fingerprint": "endpoint | routes.routes | GET /loans/:id",
      "kind": "endpoint",
      "file": "src/lending/routes.ts",
      "line": 5,
      "symbolId": "src/lending/routes.ts::routes::variable",
      "text": "GET /loans/:id",
      "detail": { "verb": "GET", "route": "/loans/:id" },
      "source": "native"
    }
  ],
  "resolutionFile": "docs/domain/lending/shadow-specs.yaml",
  "staleResolutions": [],
  "unknownRules": [],
  "resolutionProblems": [],
  "_meta": { "totalItems": 6, "returnedItems": 6, "truncated": false }
}
```

After the team writes `docs/domain/lending/shadow-specs.yaml`:

```yaml
- fingerprint: "literal-comparison | loan-policy.canBorrow | loans.length >= 5"
  resolution: { rule: lend03 }
- fingerprint: "normalization | loan-policy.memberKey | email.trim()"
  resolution: { notARule: "input hygiene, not a business rule" }
- fingerprint: "literal-comparison | loan-policy.canBorrow | loans.length >= 3"
  resolution: { rule: LEND-03 }
- fingerprint: "endpoint | routes.routes | GET /loans/:id"
  resolution: { rule: LEND-99 }
```

`{ "context": "lending", "kinds": ["literal-comparison"], "includeResolved": true }` gives:

```json
{
  "context": { "id": "lending", "name": "Lending", "rung": "pinned" },
  "counts": { "open": 0, "resolved": 1, "byKind": { "literal-comparison": { "open": 0, "resolved": 1 } } },
  "shadowSpecs": [
    {
      "fingerprint": "literal-comparison | loan-policy.canBorrow | loans.length >= 5",
      "kind": "literal-comparison",
      "file": "src/lending/loan-policy.ts",
      "line": 4,
      "symbolId": "src/lending/loan-policy.ts::canBorrow::function",
      "text": "loans.length >= 5",
      "detail": { "operator": ">=", "literal": "5" },
      "source": "native",
      "resolution": { "by": "shadow-specs", "rule": "LEND-03" }
    }
  ],
  "resolutionFile": "docs/domain/lending/shadow-specs.yaml",
  "staleResolutions": [{ "fingerprint": "literal-comparison | loan-policy.canBorrow | loans.length >= 3", "line": 6 }],
  "unknownRules": [{ "fingerprint": "endpoint | routes.routes | GET /loans/:id", "rule": "LEND-99", "line": 8 }],
  "resolutionProblems": [],
  "_meta": { "totalItems": 1, "returnedItems": 1, "truncated": false }
}
```

The rule `lend03` is canonicalized to `LEND-03`. The `loans.length >= 3` entry is stale: the literal changed, so its
fingerprint matches nothing (and `ctxo verify-domain` check 12 warns). `LEND-99` is defined by no card, so that
entry resolves nothing and the endpoint stays open.

| Field | Meaning |
| --- | --- |
| `context` | `id`, `name` and `rung` of the context |
| `counts` | `open`, `resolved` and `byKind` (`{ open, resolved }` for each kind that has candidates), after the `kinds` filter, counted per candidate |
| `shadowSpecs` | Open candidates (and resolved ones with `includeResolved`): `fingerprint`, `kind`, `file`, `line` (1-based), `symbolId` or `ruleId`, `text`, `detail`, `source`, `resolution` |
| `resolutionFile` | The context's `shadow-specs.yaml`, whether or not it exists |
| `staleResolutions` | Entries whose fingerprint matches no candidate: `fingerprint`, `line` |
| `unknownRules` | Entries naming a rule no card defines: `fingerprint`, `rule`, `line` |
| `resolutionProblems` | Problems of the file: `line`, `severity` (`error` or `warning`), `message` |

### Sources and resolutions

| `source` | Candidate |
| --- | --- |
| `native` | A fact the language plugin found |
| `text` | A fact the `@ctxo/domain` text scan found (no fact-capable plugin for the file) |
| `index` | A `table`, `view` (`data-resource`) or `procedure` symbol in a file the context owns |
| `card` | A rule of the context's card without tests (`rule-without-tests`) |

| `resolution.by` | Set when |
| --- | --- |
| `rule-link` | A rule's card `Code:` line or a `rule:` comment links to the candidate's symbol (`rules` lists them) |
| `untested` | The rule has an `Untested:` line (`reason`) |
| `shadow-specs` | An entry of `shadow-specs.yaml` has the candidate's fingerprint (`rule` or `notARule`) |

Fingerprints are `kind | symbol | normalized text` and do not depend on line numbers. Copy each one verbatim into
`shadow-specs.yaml`: `%7C` and `%25` in the kind and symbol parts are an encoded `|` and `%`. Several candidates may
share one fingerprint (overloads, the same text twice), and one entry resolves them all. An entry with an unknown rule
that matches no candidate is listed in both `staleResolutions` and `unknownRules`. See
[the Deletion Test loop](https://github.com/alperhankendi/Ctxo/blob/master/docs/features/domain-knowledge.md#the-deletion-test-loop)
for the fingerprint rules and the file format.

## Graceful misses

| Situation | Response |
| --- | --- |
| No registry | `{ "found": false, "hint": "..." }` |
| A registry with problems | `{ "found": false, "hint": "..." }` (run `ctxo verify-domain`) |
| A context the registry does not name, or a blank one | `{ "found": false, "hint": "No context <id> in the registry; get_context_map lists the contexts." }` |
| No loop artifacts (not indexed with this release) | `{ "found": false, "hint": "No shadow-spec data yet; run \"ctxo index\"." }` |
| Artifacts built for another registry, or cards changed since the last index | The answer, plus `stale: true` and a hint to run `ctxo index` |
| An unexpected failure | `{ "error": true, "message": "The shadow-spec data could not be read: ..." }` |

## Truncation

`shadowSpecs` is truncatable: when the response exceeds the limit it is cut and `_meta.hint` says how to narrow
the query (`kinds`). `staleResolutions`, `unknownRules` and `resolutionProblems` are capped at 50 at the source, with
`staleResolutionsTotal`, `unknownRulesTotal` and `resolutionProblemsTotal` when cut.

## CLI

`ctxo domain shadow-specs <context> [--kinds <k,...>] [--all] [--json]` prints the same body without `_meta`
(see [domain commands](/cli/domain#ctxo-domain-shadow-specs)). Under `ctxo watch`, candidates refresh only on the
next `ctxo index`.

## When to use

- Before tightening a context's rung: what business logic does no rule state yet?
- After writing a rule: add a `Code:` line or a `rule:` comment, and the candidate resolves itself.
- In review: `includeResolved: true` shows what was marked `notARule` and why.

## Related tools

- [`get_rule`](/mcp-tools/get-rule): the rule a candidate belongs to, with its tests.
- [`get_context_map`](/mcp-tools/get-context-map): open candidates per context and what blocks `boring`.
- [`get_domain_context`](/mcp-tools/get-domain-context): the card of the context.
