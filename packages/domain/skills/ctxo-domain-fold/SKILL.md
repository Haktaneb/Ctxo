---
name: ctxo-domain-fold
description: Use BEFORE changing code under a named domain context and BEFORE finishing a branch, to read the context's card and fold behaviour changes back into it.
---

# Fold domain knowledge with ctxo

## Before changing a context's code

1. Find the context that owns the files: the generated path rule for the folder, or `docs/domain/contexts.yaml` (each context lists its `paths` and its `card`).
2. Read the context's card before you edit: its rules, contracts and decisions are the behaviour the code must keep.

## When behaviour changes

1. Update the card in the same branch as the code: a changed rule, contract or decision goes into the card, not only into the commit message.
2. Rule IDs are permanent. Never reuse or renumber one; retire a rule by marking it, and give a new rule a new ID.

## At branch finish

1. Run `ctxo contexts-touched --since <base>` to list the contexts this branch changed.
2. For each unresolved context, either commit a card update or add `Domain-Unchanged: <id> (reason)` to a commit (an empty commit is fine).
3. The Stop guard blocks once when a commit changed a context without either, so resolve every context before you finish.

<!-- ctxo-skill v0.14 -->
