# Backends

The protocol is the same; where the state lives differs.

## A. Local ledger (default — any repository, any environment)

```
node <remedy>/scripts/remedy.cjs init --title "<Project> Remediation Tracker" --plan-dir docs/remediation
```
- State: `<repo>/.remedy/meta.json`, `items/<ID>.json`, `register/<KEY>.json` — one file per record so merges are clean. Commit it (it is the programme's history) unless the owner prefers it ignored.
- Plans: `<planDir>/<ID>.md` and `<planDir>/<CLUSTER>.md` in the repo.
- Dashboard: `remedy render` writes `.remedy/dashboard.html`, a self-contained read-only page (board, table, clusters, register; each item shows the CLI command for its next step). Re-render after changes; open it in a browser.
- Approvals: the owner runs `remedy approve ID --by "<name>"` (or tells Claude explicitly to record it).
- CI: add `node <remedy>/scripts/remedy.cjs validate` to keep the gate honest (fails on a building/done item without an approval).

## B. Live claude.ai artifacts (when the Artifact and ArtifactData tools are available)

A shared, live page the owner and team can open, where editors approve plans with a button.

1. Load the `artifact-design` and `artifact-capabilities` skills as the Artifact tool requires.
2. Publish [assets/tracker.html](assets/tracker.html) as an artifact with capabilities `{"db":{}, "user":{"scopes":["profile"]}}` and a fitting icon (e.g. `checklist`). The page reads collections `items`, `bugs` and the doc `meta/protocol`, so one artifact holds tracker **and** register. (If the programme already has a separate register artifact, set `meta.registerUrl` and keep `bugs` there.)
3. Seed it: `remedy publish --prepare --out <scratch>/publish` writes `batch-NNN.json` files (≤ 50 writes each; the first run seeds everything). Send each file as one ArtifactData `batch` call (creates without `if_version`; documents listed under `existing` with it), then run `remedy sync --artifact-commit`. Record the URL in `meta.publish.trackerUrl`.
4. While working, keep both in step: `remedy sync --artifact-prepare --out <dir>` writes only the documents that changed since the last publish (compared with `.remedy/publish-manifest.json`); send those batches with `if_version`, then `remedy sync --artifact-commit`; after owner actions in the page (approvals, notes), pull them back with ArtifactData `list --out_dir`, then `remedy import-artifact --items <dir>/items --bugs <dir>/bugs --meta <dir>/meta/protocol.json`.
5. The page enforces the gate in the UI (no move past Approved without an approval; editing an approved plan withdraws it), mirrors stage changes to the linked register row, and shows each approver's name.

Artifact writes go through ArtifactData with the artifact URL; a plan approval is written by the owner from the page, never by you unless explicitly instructed.

## Choosing
Use A always (it is the source of truth that survives without claude.ai). Add B when the owner wants a shared live page or approves from the browser.
