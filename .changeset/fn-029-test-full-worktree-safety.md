---
"@runfusion/fusion": patch
---

Protect the active fn worktree during full-suite tests and engine cleanup so `pnpm test:full` can run safely from `.worktrees/<slug>` checkouts.
