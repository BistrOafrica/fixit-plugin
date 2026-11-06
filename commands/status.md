---
description: Show what waits for approval, what is approved, what is building
effort: low
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs status --render)
---
!`node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs status --render`

Repeat the lines above as they are, then add one line with the suggested next action. Run nothing else. The owner can also run `remedy status` in a terminal, with no model call.
