# Protocol and data model

## Records

### Register row (`.remedy/register/<KEY>.json`, artifact collection `bugs`)
Confirmed defects only. Schema: [schemas/register.schema.json](schemas/register.schema.json).

| Field | Meaning |
|---|---|
| `key` | `PREFIX-NN`, shared with the tracker item |
| `title`, `detail`, `impact` | what happens, who is hurt |
| `location` | `file:line · file:line` |
| `category`, `component` | area for grouping and heat maps |
| `severity` | critical · high · medium · low (unrated only while unvalidated) |
| `status` | open · in_progress · fix_in_review · fixed · wont_fix |
| `foundBy`, `confidence` | which layer caught it (e.g. "Security audit (run-3)", "Integration tests", "Code review (remediation planning)", "Owner report") and how sure |
| `pinnedBy` | the test that reports it today |
| `fingerprint` | stable id from the audit, for dedupe across runs |
| `note`, `history[]`, `updatedAt`, `updatedBy` | |

### Tracker item (`.remedy/items/<ID>.json`, artifact collection `items`)
Schema: [schemas/item.schema.json](schemas/item.schema.json).

| Field | Meaning |
|---|---|
| `id` | `PREFIX-NN` |
| `title`, `summary`, `impact`, `acceptance` | |
| `severity` | as the register; `unrated` for needs-validation leads and non-bugs without risk |
| `kind` | bug · todo · stub · gap · debt · test-gap · perf · feature · validation · hardening |
| `wave` | priority band (W0…W5 by default) |
| `workstream`, `component` | |
| `cluster` | id of a cluster in `meta.clusters` ("" = standalone) |
| `stage` | see below |
| `dependsOn[]` | items whose plan/build must come first |
| `sources[]` | evidence: `file:line · note` |
| `pinnedBy` | test that flips when fixed |
| `registerKey` | the register row, if this is a confirmed defect |
| `plan` | `{path, summary, approvedAt, approvedBy}` |
| `note`, `history[]`, `order`, `updatedAt`, `updatedBy` | |

### Meta (`.remedy/meta.json`, artifact doc `meta/protocol`)
`title`, `project`, `subtitle`, `planDir` (default `docs/remediation`), `waves[] {id,name,why}`, `clusters[] {id,name,items[]}`, `protocol[]` (the steps shown on the dashboard), `excluded` (what is deliberately out of scope), `reservedIds[]` (ranges claimed by parallel sessions), `decisions[]` (optional log), `publish {trackerUrl, registerUrl}`.

## Stages and the gate

```
backlog → planning → plan_review → approved ▸ building → in_review → done
                         ▲   │                    (gate)
                         └───┘ request changes          blocked · wont_do (outside the flow)
```

- **backlog**: known, not yet planned.
- **planning**: a planning run is investigating it.
- **plan_review**: plan written to `<planDir>/<ID>.md`, path + summary recorded. Waits for the owner.
- **approved**: owner recorded approval (`plan.approvedAt`, `plan.approvedBy`). Only `approve` (or the artifact's Approve button) sets it.
- **building / in_review / done**: past the gate; refused without an approval. `in_review` = change written, not merged; `done` = merged, pinned test flipped.
- **Revising** a plan after approval (before building) withdraws the approval and returns the item to plan_review.
- Moving back to backlog/planning clears the approval.

Register status mirrors the tracker stage: building → in_progress, in_review → fix_in_review, done → fixed, wont_do → wont_fix; everything before the gate → open. `sync-register` (and every `stage` call) applies this.

## Severity

- **critical**: exploitable now, e.g. account takeover, unauthenticated data access, default credentials live.
- **high**: wrong or unauthorised decisions, data exposure, a broken core flow, data loss.
- **medium**: incorrect behaviour with a workaround or limited reach.
- **low**: cosmetic, tooling, hygiene.
- **unrated**: needs validation; never guess a severity for an unconfirmed lead. (Mirrors security-audit: `needs_validation` has no severity.)

Security findings imported from the audit keep the audit's `overall_severity` (informational → low).

## Waves (defaults; edit `meta.waves`)
W0 Stop the bleeding · W1 Integrity · W2 Scale and access · W3 User-facing defects · W4 Platform and hygiene · W5 Feature gaps. A wave is a priority band, not a schedule.

## Clusters
Items that share code or a design decision. One planning run covers a cluster and writes a cluster overview plus one plan per item; each item is still approved individually. Name a cluster by the outcome ("Keep citizens out of the back office"), id in caps (`CITIZEN-ACCESS`). Standalone items have `cluster: ""` and can later be grouped into new clusters.

## IDs
`PREFIX-NN`: SEC (security), WF (workflow/engine), WEB (front end), BO (back office/admin UI), API, DATA, PERF, OPS, TOOL, TEST, DEBT, CAT (catalog/config), INT (integrations), PAY, FEAT (feature gaps). Get the next free id with `next-id PREFIX`; never reuse a retired id. Register rows and tracker items share one id space.
