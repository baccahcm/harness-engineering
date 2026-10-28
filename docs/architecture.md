# Architecture

Engineering Harness V0.8.3 separates machine authority from agent suggestions and adds adaptive ordered-threshold review approval on top of the V0.8 operator/CI/scheduler platform.

## Layers

1. **CLI** — bootstrap, profiles, task/history, context/metrics, runtime recovery, review gates, and `harness run`.
2. **Core state/policy** — lifecycle, review levels, acceptance criteria, ownership, and transition validation.
3. **Git/source identity** — whole-repository fingerprints, scoped content fingerprints, and before/after manifests.
4. **Prompt compiler** — provider-neutral PromptPlan -> CompiledPrompt with stable contract prefix, optional stable task context, explicit compact handoff, and round delta.
5. **Agent adapters/capabilities** — Claude CLI, Codex and Antigravity provider command/result contracts, exact-session capture/resume, optional provider usage telemetry.
6. **Session/context manager** — exact-session registry, explicit rotation, previous-session history, deterministic compact handoff, context-pressure reporting.
7. **Streaming runtime** — spawn execution, logs, PID/request registry, timeout/cancel, crash reconciliation.
8. **Run lease** — atomic single-orchestrator ownership for `harness run`; stale dead-PID lease reclaim is distinct from provider-process recovery.
9. **Metrics** — append-only per-turn prompt metadata and provider-reported token/cache usage when available, attributed separately to configured reviewer identities.
10. **Evidence** — verification execution, logs, source stability and indexed runs.
11. **Review orchestration** — ordered-threshold lazy dispatch, per-reviewer source-bound approvals, qualifying-failure-only fallback, stop-on-REVISE, per-candidate prompt compilation, immutable artifacts and canonical state progression.
12. **Workflow runner** — developer -> evidence -> review -> fix/recheck -> final loop with durable run journal.
13. **Event bus** — sanitized append-only workflow/operator events, with live in-process sink support for CLI progress/TUI consumers.
14. **Provider catalog probe** — exact provider capability metadata; Antigravity catalog is probed/cached when supported, Codex remains runtime-validated instead of scraped.
15. **Migration engine** — ordered V0.1→current migration steps plus durable migration history and downgrade refusal.
16. **Release provenance** — deterministic source manifest digest, SPDX SBOM, checksums, optional Ed25519 signature, and verification.
17. **Operator dashboard** — terminal snapshot/refresh UI over sanitized canonical state.
18. **CI adapters** — managed verification-only GitHub/GitLab templates with non-destructive install rules.
19. **Sigstore adapter** — optional external-cosign keyless sign/verify backend; credentials remain external.
20. **Workspace scheduler** — registry/planner/bounded dispatcher across isolated harness roots; per-workspace run lease remains authoritative.
21. **Installer/upgrader** — idempotent bootstrap and non-destructive migration.

## Adaptive review/approval boundary

Reviewer *order*, provider choice, model choice, `approvalsRequired`, and `maxReviewers` are project configuration. Reviewers are dispatched lazily in order. An APPROVED result contributes one source-bound approval for that reviewer identity; the next reviewer is started only when the threshold has not yet been met. A REVISE result stops the chain immediately and enters the fix/recheck cycle. Later reviewers cannot outvote a concrete finding.

Fallback and approval counting are distinct. A reviewer that cannot run because of a qualifying quota/service/model-access failure may fall through to the next configured reviewer, but that unavailable attempt does not count toward `maxReviewers` or the approval threshold. Non-qualifying failures do not permit reviewer shopping.

Session identity includes the configured reviewer profile name in addition to task/provider/model. Two profiles using the same provider/model therefore keep independent exact sessions and independent token/cache metrics.

Project-level thresholds may be overridden for a task only through canonical policy state with a recorded `selectedBy` authority. Changing source invalidates only the per-reviewer approvals whose bound source scope changed; an aggregate gate cannot remain approved if the current threshold is no longer satisfied.

## Prompt/context boundary

The harness never assumes that session reuse guarantees provider cache hits. It controls what it can verify: exact session IDs, prompt layout, repeated versus delta context, local prompt hashes/estimates, and explicit session rotation. Provider token/cache fields are persisted only when the provider output contains them.

A reviewer prompt is compiled per candidate. If the candidate has an exact saved session, the prompt is delta-oriented. If fallback selects a provider/model without saved context, the harness compiles a full initial packet. This prevents context loss during fallback.

## Explicit compaction

When estimated prompt accumulation crosses the configured threshold, `context status` recommends compaction. Nothing rotates automatically. `context compact` writes a deterministic task/review handoff and marks the chosen exact session for rotation. The next dispatch intentionally omits the old session ID, requires a new returned session ID, then archives the old ID in session history.

## Authority boundary

Provider output cannot directly mutate approval state. Reviewer output is parsed as input; the harness verifies target eligibility, exact session identity, source stability and structured evidence before applying a transition.


## Operator/event boundary

The event bus deliberately emits only harness-owned metadata. Provider prompts, provider responses, stdout/stderr bodies, credentials and full source snippets remain in their existing protected files/streams and are not duplicated into progress events. `harness run --progress` is therefore a view over canonical state transitions, not a raw model transcript.

## Model-catalog boundary

A model catalog is trusted only when an adapter has a supported probe. Catalog absence means `unknown/runtime validation`, never an inferred model. Cached catalogs have a TTL and can be refreshed explicitly. This keeps core policy provider-neutral while allowing stronger validation where the CLI exposes a stable catalog command.

## Release boundary

Release provenance is about reproducibility and traceability, not an assertion that CI or publication occurred. `release verify` proves that the current source manifest matches the generated provenance and that checksums/signature (if present) verify. Deployment/publishing authorization remains outside the harness.


## Multi-workspace boundary

The scheduler is a controller, not a replacement state machine. It only selects registered roots that are independently initialized and runnable, then launches that root's normal `harness run`. Task state, exact sessions, runtime recovery, evidence and review approvals remain local to each workspace.

## CI boundary

Generated CI validates harness/project/release state but does not automatically execute coding agents. Provider credentials, publication and deployment remain explicit operator decisions outside the generated default templates.

## Keyless signing boundary

Sigstore support delegates to `cosign sign-blob/verify-blob`. The harness stores the resulting bundle only; OIDC tokens and signing identities are not persisted in harness state.


## Plan-native analysis and execution

V0.8.2 added a read-only `planner` agent purpose and a canonical plan manifest. V0.8.3 promotes that plan directory into a self-contained logical workspace under `.harness/plans/<plan-id>/`. Planner output is structured and validated before persistence. `harness plan import` never authorizes implementation; `harness plan approve` records user/team-leader authorization; `harness plan run` materializes dependency-ready task specs one at a time and delegates each task to the existing workflow orchestrator.

Plan-generated `TaskState` records a plan binding (`manifestId`, source path/SHA-256, task spec ID, execution order). The normal run orchestrator checks that binding before and during execution. A changed plan therefore invalidates execution authority independently of source-code review staleness.


## Plan logical workspace storage (V0.8.3)

Plan-generated artifacts no longer share the project-global task/handoff/evidence/session namespaces. The canonical plan layout is:

```text
.harness/plans/<plan-id>/
  manifest.json
  source.json
  tasks/<task-id>/
    state.yaml
    sessions.yaml
    reviews/
    evidence/
    context/
    metrics/
    archive/
  execution/
    run-state.json
    runtime-processes.json
    run-lease/
    runtime/
    events.jsonl
    metrics/
  archive/completed.json
```

A thin `.harness/state/active-task.json` pointer identifies the currently active plan task; task state itself remains canonical inside the plan workspace. Project-global `.harness/events/events.jsonl` remains a sanitized cross-plan event index, while the canonical plan execution event stream lives under the plan. Non-plan tasks preserve the legacy global layout.

Path resolution always prefers the active plan/task context. When duplicate task IDs exist across plans, an operation without an active plan context is rejected as ambiguous instead of guessing.
