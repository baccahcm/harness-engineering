# Policy Reference

- **P001** Developer cannot approve its own work; non-reviewer roles cannot issue review verdicts.
- **P002** Reviewer is read-only for application source/tests/migrations/runtime configuration.
- **P003** Production access requires explicit user authorization.
- **P010** NONE tasks never emit APPROVED and complete after proportional verification.
- **P011** LIGHT requires the configured ordered-threshold number of independent whole-task approvals before completion; default is one unless project/task policy raises it.
- **P012** FULL requires every configured checkpoint and the final whole-change gate to satisfy the effective ordered-threshold approval policy before completion.
- **P013** REVISE/missing evidence/local permission/auth failures/timeout/cancellation are not reviewer-fallback conditions.
- **P014** APPROVED structured review output must identify evidence inspected or executed.
- **P020** Invalid lifecycle/review-stage transitions are rejected.
- **P022** Review approval is bound to recorded source identity; source mutation during review invalidates that turn.
- **P023** Automated FULL development requires explicit checkpoint ownership; out-of-scope mutations stop orchestration.
- **P024** Scoped checkpoint approval is invalidated only by content changes in its ownership scope; final approval remains whole-source bound.
- **P025** Automated orchestration cannot authorize DRAFT/BLOCKED work or bypass verification.
- **P026** A provider session already in-flight cannot accept a duplicate request.
- **P027** Crash/restart uncertainty is never silently converted to idle/success/failure; explicit recovery is required.
- **P028** Async dispatch validates provider availability and role capability before starting a provider process.
- **P029** A non-COMPLETED active task cannot be silently overwritten by a new task.
- **P034** Only one live async workflow orchestrator may hold the project run lease at a time.
- **P035** Reviewer prompts are compiled per candidate/session; a fallback reviewer without prior session context must receive full task context.
- **P036** Session compaction/rotation is explicit. The old session ID is retained and replacement requires a newly returned provider session ID.
- **P037** Provider token/cache telemetry is recorded only when returned by the provider; local estimates must remain labeled estimates.
- **P030/P031/P032/P033** Push/merge/commit/reset/stash require explicit authorization and are never introduced implicitly.
- **P040/P041/P042** Installation preserves existing project rules/configuration and remains idempotent.

- **P038** Provider model IDs are never inferred from display names; catalog validation is used only when an adapter returns a real provider catalog, otherwise runtime validation remains authoritative.
- **P039** Progress events must contain harness-owned metadata only; raw prompts, provider responses, credentials and source bodies are excluded.
- **P043** Upgrade applies only ordered known migrations, records migration history, refuses downgrades, and preserves project-owned workflow files.
- **P044** Release provenance/SBOM describe the current source/package state only; generation/verification do not authorize publication or deployment.
- **P045** Release signing is optional and must never persist the private signing key in harness state or release artifacts.

- **P046** Operator dashboard/events expose harness-owned metadata only; raw prompts/responses/credentials are not copied into dashboard state.
- **P047** CI generation must not overwrite unmanaged CI configuration without explicit force and must not enable agent execution/publication by default.
- **P048** Keyless signing delegates to an external verified backend and must not persist OIDC tokens/private signing credentials.
- **P049** Scheduler may dispatch only isolated initialized workspaces with runnable tasks and no held run lease or unresolved provider runtime.
- **P050** Multi-workspace scheduling never bypasses the target workspace lifecycle, evidence, independent review or run-lease policies.

- **P051** Reviewers are dispatched lazily in configured project order and dispatch stops immediately once the effective approval threshold is satisfied.
- **P052** REVISE stops the reviewer chain immediately; later reviewers cannot outvote, override or shop around an unresolved concrete finding.
- **P053** Qualifying quota/service/model-access fallback is distinct from approval counting: unavailable attempts contribute no approval and no completed-review slot.
- **P054** Each reviewer approval is persisted with reviewer identity, exact session and source fingerprint; only still-current approvals count toward the threshold.
- **P055** Reviewer sessions are isolated by task + reviewer profile + provider/model; profiles that use the same provider/model cannot silently share a review session.
- **P056** Project review policy may vary by NONE/LIGHT/FULL. Per-task overrides must record user/team-leader authority and cannot be inferred from developer output.
- **P057** Provider token/cache telemetry and local estimates must remain attributable to the reviewer profile that incurred them; missing provider telemetry is never invented.


## P080–P086 Plan authority

- **P080** — Plan import is analysis-only and MUST NOT start implementation.
- **P081** — A canonical plan manifest requires explicit user/team-leader approval before any generated task is authorized.
- **P082** — Planner output with unknown dependencies, dependency cycles, invalid ownership scopes, duplicate IDs, unknown verification keys, or missing FULL checkpoints is rejected.
- **P083** — Every generated task is bound to the imported plan path and SHA-256. A changed plan blocks execution with `PLAN_CHANGED`.
- **P084** — Plan tasks execute only when their declared dependencies are completed. V0.8.3 executes same-repository plan tasks sequentially.
- **P085** — Planner selection is project-local: explicit `agents.planner` wins; otherwise the primary reviewer is reused read-only for planning. Planner analysis does not count as review approval.
- **P086** — Plan-derived review levels/scopes become authoritative only when the plan is explicitly approved; the developer cannot weaken them through agent output.

- **P085** — Plan-generated task artifacts are canonical only inside `.harness/plans/<plan-id>/tasks/<task-id>/`; the global active-task file is a control pointer, not duplicate authority.
- **P086** — Two plans may reuse the same task ID without sharing review, evidence, session, context or metric state. Ambiguous cross-plan task lookup must fail rather than guess.
- **P087** — Plan execution runtime/lease/event state is plan-scoped. A manual non-plan task must never inherit the last completed plan's execution namespace.
- **P088** — V0.8.2 migration preserves unassignable legacy evidence instead of guessing its owning task; new plan evidence is always task-scoped.
