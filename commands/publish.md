---
description: Publish (or refresh) the live claude.ai tracker page from the local ledger
---
Load the `remedy` skill and follow BACKENDS.md §B. Load the `artifact-design` and `artifact-capabilities` skills first, as the Artifact tool requires.
1. `node ${CLAUDE_PLUGIN_ROOT}/skills/remedy/scripts/remedy.cjs export-artifact --out <scratchpad>/remedy-export`.
2. If `meta.publish.trackerUrl` is empty, publish `${CLAUDE_PLUGIN_ROOT}/skills/remedy/assets/tracker.html` (copy it to the scratchpad first; set its `<title>` to the programme title) with capabilities `{"db":{},"user":{"scopes":["profile"]}}` and icon `checklist`; store the URL in `.remedy/meta.json` → `publish.trackerUrl`. Otherwise read the existing artifact before republishing.
3. Seed or refresh the db with ArtifactData `batch` writes (≤ 50 per batch; creates without `if_version`, updates pinned): `items/*` → `items`, `bugs/*` → `bugs`, `meta-protocol.json` → `meta/protocol`.
4. Give the owner the link and explain: editors approve plans with the button; everything else flows through Claude Code.
