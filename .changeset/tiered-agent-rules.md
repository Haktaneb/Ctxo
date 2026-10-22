---
"@ctxo/cli": minor
---

Claude Code now gets a compact ctxo block in `CLAUDE.md` when the safe-edit guard and the skills are installed, and every other client gets the full block, inside versioned markers that are replaced in place without touching the rest of the file (#159). `ctxo init` gains `--only`, `--skip` and `--no-guard`, and `ctxo doctor` gains the `ai_rules`, `skills` and `claude_guard_hook` checks, which `ctxo doctor --fix` repairs.
