# Engineering Harness

V0.8.3 turns every imported implementation plan into a self-contained logical workspace. V0.8.2 plan-native decomposition remains intact, but generated task state, reviews, evidence, sessions, context, metrics, execution runtime/events and archives are now namespaced under `.harness/plans/<plan-id>/`, so different plans can safely reuse the same task IDs without artifact collisions. V0.8.1 adaptive reviewer policies, exact sessions, runtime safety, operator/CI/scheduler features remain intact. The harness—not the LLM—owns plan/task state, run leases, checkpoint ownership, source identity, evidence, provider process/session state, reviewer routing, prompt compilation, migrations, and allowed transitions.

## Quick start

```bash
npm run build
harness init
harness doctor
```

For an existing harness project:

```bash
harness upgrade
harness doctor
```

`init` and `upgrade` preserve existing project rules and workflow documents. The harness manages only its explicit AGENTS.md block and `.harness/` state.



## Plan-native workflow

Configure an explicit planner profile, or omit it and the harness will use the first configured reviewer as the read-only planner:

```bash
harness profile set planner claude <verified-planner-model-id>
```

Import a plan file that already exists inside the project:

```bash
harness plan import docs/plans/my-feature.md
harness plan show
```

The planner reads the plan and project rules/repository structure, then proposes a canonical manifest containing one or more tasks, dependencies, review levels, observable acceptance criteria, FULL-task checkpoints with ownership scopes, and configured verification keys. The harness validates the structured result; unknown dependencies, cycles, invalid scopes, duplicate IDs, unknown verification keys, or FULL tasks without scoped checkpoints are rejected. Import creates a **DRAFT** plan only and never starts implementation.

After inspection, explicitly authorize the derived task queue:

```bash
harness plan approve
harness plan run --progress
```

`plan run` materializes one plan task at a time in dependency order and sends it through the normal developer/evidence/adaptive-review workflow. Independent tasks are still executed sequentially inside one repository in V0.8.3; cross-workspace parallel dependency scheduling remains a later scheduler concern.

Every generated task stores:

```text
plan manifest ID
plan source path
plan SHA-256
plan task ID
execution order
```

The authoritative plan path and SHA are included in developer/reviewer context. If the plan file changes after import, both `harness plan run` and ordinary `harness run` on a plan-generated task stop with `PLAN_CHANGED`; old task/review state is not silently reused against a changed specification.

Typical daily flow:

```bash
harness plan import docs/plans/feature.md
harness plan show
harness plan approve
harness plan run --progress
harness ui
```

### Plan logical workspace layout

Each imported plan owns its own canonical artifact tree:

```text
.harness/plans/<plan-id>/
├── manifest.json
├── source.json
├── tasks/
│   └── <task-id>/
│       ├── state.yaml
│       ├── sessions.yaml
│       ├── reviews/
│       ├── evidence/
│       ├── context/
│       ├── metrics/
│       └── archive/
├── execution/
│   ├── run-state.json
│   ├── runtime-processes.json
│   ├── run-lease/
│   ├── runtime/
│   ├── events.jsonl
│   └── metrics/
└── archive/
    └── completed.json
```

Project-global state now acts only as a thin control/index layer (for example the active-plan pointer, active-task pointer, project config and cross-plan event index). Non-plan tasks continue to use the legacy project-global layout. V0.8.3 migration moves task-addressable V0.8.2 plan artifacts into the matching logical workspace; historical global evidence is preserved when it cannot be assigned safely because old evidence records did not contain task identity.

Inspect plan workspaces with:

```bash
harness plan list
harness plan workspace
harness plan workspace <plan-id>
```

## Operator dashboard

```bash
harness ui
harness ui --once
harness ui --interval-ms 1000
```

The dashboard is a terminal view over canonical task/run/runtime/metrics/event state. It does not stream raw prompts or provider responses. `--once --json` is suitable for automation and smoke checks.

## CI adapters

```bash
harness ci generate github
harness ci generate gitlab
```

The generated CI is intentionally verification-only: it runs `harness doctor` and verifies release artifacts when present. It does **not** execute coding agents or assume provider credentials. GitHub output is a managed workflow. GitLab output uses `.harness/ci/gitlab-ci.yml`; an unmanaged existing `.gitlab-ci.yml` is preserved and receives only a manual include note.

## Optional Sigstore/cosign keyless signing

```bash
harness release keyless-sign
harness release keyless-verify --identity <certificate-identity> --issuer <oidc-issuer>
```

This backend delegates to an installed `cosign` executable and uses ambient OIDC/keyless provider behavior. The harness does not persist OIDC tokens or signing credentials. Local Ed25519 signing remains supported separately.

## Multi-worktree scheduler foundation

```bash
harness workspace add api ../repo-api
harness workspace add web ../repo-web
harness workspace list
harness scheduler plan
harness scheduler run --max-parallel 2
```

Each registered workspace keeps its own `.harness` task/session/runtime/run-lease state. The controller only dispatches workspaces that are initialized, enabled, have a runnable active task, and have no active/uncertain provider runtime or held run lease. Per-workspace `harness run` still owns the actual workflow authority.

## Adaptive reviewer profiles and approval policy

Reviewer order and approval thresholds are configured per project. Claude CLI, Codex, and Antigravity can be mixed in any order:

```bash
harness profile set developer antigravity <verified-developer-model-id>
harness profile add reviewer claude-opus claude <verified-claude-model-id>
harness profile add reviewer codex codex <verified-codex-model-id>
harness profile add reviewer ag-gemini antigravity <verified-ag-model-id>
harness profile order reviewers claude-opus,codex,ag-gemini
```

Set the required approvals independently for each review level:

```bash
harness review policy set LIGHT 1 2
harness review policy set FULL 2 3
harness review policy show
```

The default strategy is `ordered_threshold`: reviewers are dispatched lazily in configured order and the gate stops immediately when the required number of approvals has been collected. For example, `LIGHT=1` calls Claude first and does not call Codex/AG after Claude approves; `FULL=2` calls only enough reviewers to obtain two approvals. This avoids paying for unnecessary review turns.

A `REVISE` verdict stops the chain immediately. Later reviewers are never used to outvote or reviewer-shop around a concrete finding. The developer fixes the finding and the exact reviewer session is resumed for recheck. Provider fallback is separate from approval counting: quota/service/model-access unavailability may advance to the next reviewer, but an unavailable reviewer does not count as a completed review or approval. Timeout, cancellation, auth/permission failure, missing evidence, and REVISE do not authorize fallback.

Per-task overrides are optional and record who selected them:

```bash
harness task review-policy set 3 3
harness task review-policy clear
```

The developer cannot reduce the canonical approval requirement through agent output. Existing approvals are stored per reviewer and bound to source fingerprints; source changes invalidate only approvals whose reviewed scope became stale.

Project config shape:

```yaml
reviewPolicy:
  strategy: ordered_threshold
  levels:
    NONE:
      approvalsRequired: 0
      maxReviewers: 0
    LIGHT:
      approvalsRequired: 1
      maxReviewers: 2
    FULL:
      approvalsRequired: 2
      maxReviewers: 3
  execution:
    lazyDispatch: true
    parallel: false
    stopOnRevise: true
    reuseSessions: true
```

V0.8.3 preserves the V0.8.1 adaptive-review migration behavior and deliberately keeps the historical FULL default at one approval so an upgrade does not silently increase token cost. Projects that want stronger assurance should explicitly set FULL to two or three approvals.


## Provider capability and model catalog probing

```bash
harness agent doctor
harness agent models antigravity --refresh
harness agent models codex
```

Antigravity uses the provider CLI `agy models` catalog and caches the result under `.harness/cache/model-catalog.json`. Codex and Claude remain runtime-validated when no authoritative machine-readable catalog is exposed by their adapters; the harness does not scrape an unsupported catalog/UI. A missing catalog never causes the harness to invent a model ID. `doctor` reports configured models against the last real catalog probe when one exists.

## Sanitized progress events

```bash
harness run --progress
harness events --limit 50
```

Canonical events are append-only JSONL under `.harness/events/events.jsonl`. They contain phase/provider/model/request/evidence/verdict metadata only; raw prompts, provider responses and secrets are not emitted. This event contract is the integration boundary for future TUI/web dashboards.

## Versioned migrations

```bash
harness migration matrix
harness migration plan
harness migration history
harness upgrade
```

V0.8.3 carries explicit migration steps from V0.1 through V0.8.2, records applied steps under `.harness/state/migrations.json`, refuses downgrade migrations, and still preserves project-owned workflow files.

## Release provenance, SBOM and optional signing

```bash
harness release generate
harness release verify
harness release sign path/to/ed25519-private-key.pem
```

Release generation writes `release/provenance.json`, `release/sbom.spdx.json` and `release/checksums.sha256`. Provenance contains a deterministic source digest over the source/test/schema/template/docs/scripts inputs. Optional Ed25519 signing signs the checksum manifest; the private key is read only for signing and is never copied into the release output.

## Cache-aware prompt compilation

Automated developer/reviewer turns no longer rebuild one large prompt every round. V0.6+ compiles prompts into ordered sections:

```text
stable harness contract
  -> stable task context (first/new session)
  -> compact session handoff (only after explicit rotation)
  -> current-round delta
```

For an existing exact session, follow-up/recheck prompts omit repeated acceptance/task context and send the current target, unresolved findings, changed source identity, and current evidence. A new fallback reviewer receives full task context because it does not share the prior provider session.

Prompt metadata records stable-prefix hash, full prompt hash, mode, session reuse, included sections, and a clearly labeled local token estimate. Provider-reported usage remains authoritative when available.

## Persistent sessions and context compaction

Exact session reuse remains the default. Inspect context budget estimates:

```bash
harness context status
```

Default recommendation threshold:

```yaml
context:
  compactionThresholdEstimatedTokens: 60000
```

Compaction is explicit, never silent:

```bash
harness context compact reviewer codex <model>
harness context compact developer antigravity <model>
```

The harness writes a deterministic compact handoff under `.harness/handoff/<task>/context/`, marks the old session for rotation, and starts a fresh provider session on the next turn. The old ID is retained in session history. The first turn of the new session includes the compact handoff plus current-round context.

## Token/cache metrics

```bash
harness metrics
harness metrics --json
```

Turn metrics are appended to:

```text
.harness/metrics/turns.jsonl
```

When a provider returns usage telemetry, the harness records input, output, cached-input, and total tokens without inventing missing values. Reviewer turns are also summarized separately by configured `reviewerName`, so Claude/Codex/AG cost and cache behavior can be compared without merging their usage. If telemetry is absent, those fields remain unknown. `estimatedPromptTokens` is a local character-based estimate and is never labeled as provider billing/cache data.

## Run lease / concurrency

The CLI `harness run` path acquires an atomic project run lease before orchestration:

```bash
harness run lease
```

A second live harness process is rejected with `RUN_LEASE_HELD`. A lease left by a dead harness PID can be reclaimed; provider-process uncertainty is still checked independently by runtime reconciliation before work continues.

## Runtime reliability

Provider turns run through a streaming spawn runner. Stdout/stderr are written incrementally under:

```text
.harness/runtime/<request-id>.stdout.log
.harness/runtime/<request-id>.stderr.log
```

Controls:

```bash
harness runtime status
harness runtime reconcile
harness runtime cancel <request-id>
harness runtime resolve <request-id> <completed|failed>
```

Crash rule: live PID stays running; vanished unresolved PID becomes `uncertain`; linked exact sessions become `uncertain`; explicit resolution is required before reuse.

## FULL checkpoint ownership

```bash
harness task create auth-hardening "Auth hardening" FULL "security-sensitive change"
harness task acceptance add A1 "Unauthorized requests are rejected"
harness task checkpoint add C1
harness task checkpoint scope C1 "src/auth/**" "tests/auth/**" --exclude "src/auth/generated/**"
harness task transition READY_FOR_DEV
```

Scoped checkpoint fingerprints intentionally exclude global HEAD so unrelated changes do not invalidate an approved checkpoint. Final review remains whole-source bound. Out-of-scope developer mutations stop orchestration and are never auto-reverted.

## Automated workflow orchestration

```bash
harness run
```

Optional controls:

```bash
harness run --max-rounds 4
harness run --verify lint,typecheck,test
harness run --timeout-ms 900000
harness run status
```

LIGHT/FULL path:

```text
READY_FOR_DEV
  -> IN_PROGRESS
  -> developer turn (exact session / compiled prompt)
  -> verification/evidence
  -> READY_FOR_REVIEW
  -> ordered-threshold independent review gate
      -> APPROVED -> count approval; lazily call next reviewer only if needed
      -> REVISE -> stop chain -> FIX -> verification -> exact-session RECHECK
      -> threshold met -> next checkpoint/final
  -> COMPLETED
```

## Task history

```bash
harness task archive
harness task history
```

A non-completed active task cannot be overwritten. A completed predecessor is archived automatically when a new task is created.

## Safety properties

- Existing `AGENTS.md` content is preserved.
- `init` is idempotent and `upgrade` is non-destructive.
- Developer self-approval is impossible through canonical state APIs.
- A REVISE verdict cannot be overridden by later reviewers; the chain stops for a fix/recheck cycle.
- FULL ownership is machine-checked during automated development.
- Provider processes have PID/request tracking, timeout and explicit cancellation.
- Crash uncertainty is never silently cleared.
- Exact provider sessions are isolated per task + reviewer profile + provider/model and are not reused while in-flight or uncertain.
- Session rotation/compaction is explicit and preserves old session IDs.
- Provider token/cache telemetry is recorded only when actually returned and is attributable per reviewer profile.
- A live run lease prevents two `harness run` orchestrators from racing.
- No automatic commit, push, merge, reset, stash, deployment, or production access is introduced.
