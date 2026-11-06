---
description: Publish (or refresh) the live claude.ai tracker page from the local ledger
model: haiku
effort: low
context: fork
---
Load the `remedy` skill and follow BACKENDS.md §B. Load the `artifact-design` and `artifact-capabilities` skills only for a first publish, as the Artifact tool requires.
1. `remedy publish --prepare --out <scratchpad>/remedy-publish`. It prints `N changed, M batches, DIR` and writes `batch-NNN.json` files holding only documents that changed since the last publish.
2. If `meta.publish.trackerUrl` is empty, publish `${CLAUDE_PLUGIN_ROOT}/skills/remedy/assets/tracker.html` (copy it to the scratchpad first; set its `<title>` to the programme title) with capabilities `{"db":{},"user":{"scopes":["profile"]}}` and icon `checklist`; store the URL in `.remedy/meta.json` → `publish.trackerUrl`, then run the prepare again. Otherwise read the existing artifact before republishing.
3. Send each batch file as one `ArtifactData` `batch` call, exactly as written (creates without `if_version`; documents under `existing` pinned).
4. `remedy sync --artifact-commit`. Give the owner the link and explain: editors approve plans with the button; everything else flows through Claude Code.
