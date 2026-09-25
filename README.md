# approval-evidence-web

Async approvals with **frozen evidence**: what an approver judges and what gets
executed are stored as separate, independently verifiable records.

## Run

```bash
npm start          # http://localhost:4184, ledger persisted to ./data/ledger.json
PERSIST=0 npm start # in-memory only
npm test           # 22 domain tests + 12 HTTP/SSE tests
```

Seeded demo state: rule `amount-rule/v1`, object `change-a = {amount: 10}`,
actors `alice` (submit), `bob` (submit + approve + withdraw.any),
`carol` (explicitly no permissions). Switch the acting user via the
`x-actor` header (selector in the page header).

## Model (three things never conflated)

| Record | Lives in | Moves when |
|---|---|---|
| **live object** (`objects[id].versions[]`, append-only) | server ledger + `data/ledger.json` | direct save or a *clean* approval applies a new head version |
| **frozen submission evidence** (`submissions[id]`, immutable) | same ledger | never — inputs, rule version, frozen rule body, base/proposed values and per-field SHA-256 digests are fixed at submit time |
| **decision** (`decisions[]`, append-only) | same ledger | approve/reject/withdraw; each is bound to a submission id, base version and evidence digest |

### Evidence freeze

At submission the server captures `inputs`, `ruleVersion`, the registered
rule body, `baseValue`, `proposedValue` and a `summary` (rule output /
computation digest), then stores per-field SHA-256 digests plus an envelope
digest. Incomplete evidence is rejected at submit time (`400` with the
missing paths). Later drift or tampering is detectable per field through
`GET /api/submissions/:id` (`verification.missing` / `verification.tampered`).

### State rules (explicit, never button-hidden)

- approve while `headVersion !== baseVersion` → **409 `version-conflict`**,
  nothing is mutated; the frozen proposal is not silently applied over newer data
- newer pending submission for the same object marks the older one
  `superseded`; approving it → **409 `superseded`**; reject/withdraw still allowed
- second decision on an approved/rejected/withdrawn submission → **409 `already-decided`**
- grants are re-checked at decision time (a mid-flight revoke → **403**)
- only the submitter (or `withdraw.any`) may withdraw
- damaged evidence blocks approve/reject with **422**, withdrawal still works
- stale `baseVersion` at submit time → **409 `stale-base`**

## API

| Method/Path | Purpose |
|---|---|
| `PUT /api/source` | Legacy direct save, unchanged: `{id, value}` appends a version without evidence |
| `POST /api/submissions` | Freeze evidence: `{objectId, proposedValue, inputs, ruleVersion, summary, baseVersion?}`. Legacy `{id, evidence}` still accepted |
| `GET /api/submissions/:id` | Submission view + `verification` + `diff` + replayable decisions |
| `POST /api/decisions` | `{submissionId, action: approve|reject|withdraw, reason?}` bound to the snapshot |
| `GET /api/decisions/:seq/replay` | Frozen basis, execution record, verification, live diff for a past decision |
| `GET /api/objects/:id/history` | Every object version incl. approval provenance (`via.submissionId`, `evidenceDigest`) |
| `GET /api/approvals` | Overview: objects, submissions (with viewer `can` flags), decisions, rules, grants |
| `GET /api/events?since=seq` | SSE stream of ledger changes (live refresh); missed events are replayed |
| `POST /api/rules`, `PUT /api/grants` | Register frozen rule versions; change permissions |

## Frontend

The review page has three tabs per submission: **Original snapshot** (frozen
inputs/rule/digests, damaged fields highlighted), **Current difference** (frozen
base vs live head, changed JSON paths), **History** (decisions replayed with
bound basis and execution version). Buttons for unavailable actions stay
visible with a reason; every conflict/forbidden/duplicate response is rendered
as a banner. Live updates arrive over SSE and trigger a full server refetch —
the page never trusts a pre-submit client-side JSON cache.
