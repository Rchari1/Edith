---
name: edith
description: Show Edith's status - how many memories are held, what this session has recalled, and whether the app is reachable. Use when the user asks about Edith, their second brain, or whether it is working.
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/status)
---

Report Edith's current status to the user.

!`${CLAUDE_SKILL_DIR}/status`

Show the output above to the user as-is. Do not re-run the command, do not
search the brain, and do not start any other work - this is a status check and
nothing more. If it reports that Edith is not running, say so plainly and stop.
