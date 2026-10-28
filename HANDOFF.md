# Engineering Harness V0.8.3 — Handoff

## Summary

V0.8.3 upgrades V0.8.2 plan-native execution into **plan-scoped logical workspaces**. Every imported plan owns a self-contained canonical artifact tree under `.harness/plans/<plan-id>/`. Plan-generated task IDs may now safely repeat across plans without sharing task state, reviews, evidence, sessions, context or token metrics.

## Canonical layout

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

Project-global `.harness/state/active-task.json` is only a pointer to the current plan task. Project-global `.harness/events/events.jsonl` remains a sanitized cross-plan event index. Non-plan tasks retain the legacy global layout.

## Delivered behavior

1. Plan task state is canonical in `plans/<plan>/tasks/<task>/state.yaml`.
2. Plan review artifacts are task-scoped under `reviews/`.
3. Verification evidence is task-scoped under `evidence/`.
4. Exact provider sessions are task-scoped in `sessions.yaml`.
5. Context-compaction handoffs are task-scoped under `context/`.
6. Turn/token/cache metrics are task-scoped under `metrics/`.
7. Plan runtime registry, run state, run lease, provider stdout/stderr and sanitized events are plan-scoped under `execution/`.
8. Planner execution before manifest persistence is routed through a temporary plan context so planner runtime/events/metrics are associated with the target plan workspace.
9. Plan completion writes `archive/completed.json` with the final task summary.
10. Duplicate task IDs across different plans are isolated. Ambiguous lookup without active plan context fails rather than guessing.
11. A manual non-plan task created after a completed plan returns to project-global runtime storage and never inherits the completed plan namespace.
12. `harness plan list` lists logical plan workspaces.
13. `harness plan workspace [plan-id]` reports canonical paths and task artifact presence.

## Migration M083-plan-logical-workspace

Upgrade from V0.8.2 to V0.8.3:

- creates `source.json` and logical task directories for imported plans;
- migrates task-addressable review/context/archive artifacts when ownership is unambiguous;
- splits legacy session registry entries into task-local session registries when task ownership is unique;
- splits legacy token metrics by task ID when ownership is unique;
- migrates an active plan task from project-global `active-task.yaml` into plan `state.yaml` plus the thin active-task pointer;
- moves execution runtime artifacts only when task identity proves the owning plan;
- preserves ambiguous artifacts rather than guessing;
- intentionally preserves legacy global evidence when it cannot be assigned safely, because V0.8.2 evidence index entries did not encode task ID.

No migration performs reset/stash/commit/push/merge or deletes ambiguous historical evidence.

## Compatibility

- V0.1–V0.8.2 migration paths remain supported.
- Non-plan task behavior remains project-global.
- V0.8.2 plan manifests remain schema-compatible.
- V0.8.1 adaptive ordered-threshold reviewer policy remains unchanged.
- Claude/Codex/Antigravity exact-session behavior remains unchanged.
- Plan source SHA authority and `PLAN_CHANGED` protection remain unchanged.

## Verification

Automated regression suite before package smoke:

- **107/107 tests PASS**
- includes all prior V0.1–V0.8.2 tests plus logical-workspace isolation/migration tests.

New focused coverage includes:

- canonical plan task artifact paths;
- duplicate task IDs across plans do not collide;
- V0.8.2 migration preserves unassignable evidence;
- plan completion archive summary;
- non-plan task after completed plan does not inherit plan execution storage.

## Known limitations

1. Same-repository plan tasks are still executed sequentially, even when dependency-independent. Parallel plan DAG execution remains future scheduler work.
2. Historical V0.8.2 evidence cannot always be assigned to a task because the old evidence schema omitted task identity; it remains preserved in the legacy global evidence tree.
3. Project-global cross-plan event index is intentionally retained for operator observability; canonical per-plan events live in each plan's `execution/events.jsonl`.
4. Provider E2E in this environment uses mock CLI executables matching the real adapter contracts unless explicitly noted otherwise.

## Next recommended validation

Pilot on a real Windows project:

```powershell
npx harness upgrade
npx harness doctor
npx harness plan list
npx harness plan workspace
npx harness plan import docs/plans/<feature>.md
npx harness plan show
npx harness plan approve
npx harness plan run --progress
```

After the run, confirm task artifacts are under `.harness/plans/<plan-id>/tasks/<task-id>/` and provider sessions resume correctly with the real Claude/Codex/Antigravity CLIs.

## Package-boundary smoke result

The final V0.8.3 tarball was installed into a separate Git repository with mock Codex planner/reviewer and Antigravity developer executables matching the adapter contracts.

Observed flow:

- `harness init`
- configure AG developer, Codex planner, Codex reviewer
- `harness plan import PLAN.md --id smoke-plan`
- `harness plan approve`
- `harness plan run --progress`
- LIGHT task completed with developer -> test evidence -> independent review
- plan reached `COMPLETED`
- `harness doctor` returned `READY`
- `harness plan workspace smoke-plan --json` reported all task artifact categories present

Filesystem inspection confirmed canonical artifacts under `.harness/plans/smoke-plan/`:

- `manifest.json` and `source.json`;
- `tasks/smoke-task/state.yaml`;
- task-local `sessions.yaml`, `reviews/`, `evidence/`, and `metrics/`;
- plan-local `execution/run-state.json`, `runtime-processes.json`, runtime stdout/stderr, events and planner execution metrics;
- `archive/completed.json`.

This smoke validates package-boundary path routing with mock providers. It is not a claim of real provider authentication/quota behavior.
