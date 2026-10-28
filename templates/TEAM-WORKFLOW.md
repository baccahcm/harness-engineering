# Engineering Harness — Team Workflow

Workflow-Version: 0.8.3

Portable project instructions. Copy this file into a new project as `TEAM-WORKFLOW.md`.
This file defines the workflow, not a feature request or permission to start coding.
For copy-paste prompts, see `TEAM-WORKFLOW-COMMANDS.md`. Its command labels are ordinary chat prompts, not installed slash commands or CLI features.

## 1. Activate in a new project

1. Preserve existing project instructions. Do not replace an existing AGENTS.md.
2. Add this reference to the root AGENTS.md, or create AGENTS.md containing it if absent:

   > Follow TEAM-WORKFLOW.md for developer/reviewer roles, handoffs and review gates. Preserve all project-specific safety and domain rules.

3. Explicitly ask Antigravity: "Read TEAM-WORKFLOW.md and AGENTS.md before working. You are the developer."
4. Explicitly identify the team leader and configure independent reviewer profiles. With Engineering Harness, reviewer order/provider/model/threshold come from `.harness/config.yaml`; do not assume Codex is always first.
5. Both agents confirm the same absolute project/worktree path, current Git state and roles. Do not assume the IDE and CLI are using the same checkout.
6. The team leader defines the first task only after the user requests it. Nothing in this template authorizes an unsolicited implementation, global configuration change or installation.

A Markdown file alone does not guarantee automatic loading by every IDE. Use explicit prompts or the IDE's verified project-rule mechanism to reference it. Never assume Antigravity automatically reads AGENTS.md.

## 2. Roles and authority

- **User:** product owner; authorizes scope and external/destructive actions.
- **Team leader (Codex/Astra by default in the original workflow, or another explicitly authorized agent):** architect and task owner. Defines tasks, acceptance criteria and checkpoints; does not write full implementation code unless the user explicitly changes roles.
- **Antigravity / AG:** developer. Inspects existing code, implements the approved task, writes tests, runs local verification, fixes findings and submits evidence. Never approves its own work.
- **Independent reviewers:** ordered project profiles (for example Claude CLI, Codex, or Antigravity reviewer models), each using a separate exact review session. Project review policy determines how many approvals are required.
- The user authorizes only the configured reviewer order/policy in section 7. Provider fallback is permitted for qualifying quota/service/model-access failures; this never authorizes developer self-approval or reviewer shopping.
- No automatic commit, push, merge, deployment, production-data access or destructive cleanup. Review approval alone grants none of these permissions.
- Tool/platform safety instructions and the user's explicit directions take precedence. Preserve project-specific AGENTS.md rules; resolve conflicts before acting.

## 3. Review level, task lifecycle and ownership

Each task records `Review-Level: NONE | LIGHT | FULL`, `Review-Level-Reason`, and `Review-Level-Selected-By` (user or Codex team leader).

- **NONE:** Low-risk, non-functional work such as ordinary documentation, spelling or formatting. AG inspects the diff and runs proportional checks; no independent review, reviewer session or review packet is required. Record `Status: COMPLETED` and report `COMPLETED — REVIEW NOT REQUIRED`, never APPROVED.
- **LIGHT:** Small, isolated behavior changes with limited impact. Use a short task description, focused tests and one independent review gate covering the complete task. No separate architecture review or repeated checkpoint reviews; additional rounds occur only to resolve findings.
- **FULL:** Financial calculations, authorization, company/tenant isolation, security, data/schema migrations, destructive operations, concurrency, or substantial cross-component workflows. Use the complete checkpoint process and final whole-change review.

Default to FULL if risk is unclear or no level was selected. Diff size alone does not establish risk: a one-line permission change is FULL. Documentation that changes security/deployment procedures or agent authority is not automatically NONE.
AG may recommend a level but cannot waive review or downgrade it. If scope or risk increases, stop and request reclassification from the user/team leader. Record any change and its authority; never downgrade merely to bypass failed tests or reviewer findings. Review level does not waive domain rules, testing, evidence, or authorization for external actions.

Task lifecycle status and review verdict are separate concepts. Use these task statuses:

`DRAFT -> READY_FOR_DEV -> IN_PROGRESS -> READY_FOR_REVIEW -> COMPLETED`

Review results use `PENDING | REVISE | APPROVED` and are attached to checkpoints/final review, never used as the task lifecycle status. On review rejection, keep the task at `READY_FOR_REVIEW` while recording verdict `REVISE`, then return it to `IN_PROGRESS` for fixes. Use `BLOCKED` when progress needs user input/access; record the reason and previous stage. For NONE: `READY_FOR_DEV -> IN_PROGRESS -> COMPLETED`, after the agreed scope and checks are satisfied. A user's explicit small-task instruction may serve as the initial handoff; AG records a brief task entry and does not overwrite an unrelated active TASK.md.

- Team leader owns scope, acceptance criteria and checkpoint definitions.
- Developer may update progress, evidence and blocking conditions, but cannot weaken acceptance criteria or set APPROVED.
- Only the designated reviewer may issue approval for a named checkpoint and identified source state.
- After a checkpoint is APPROVED, proceed to the next authorized checkpoint. Do not invent a new feature or expand scope.
- Changes to reviewed source invalidate approval for the affected scope; submit them again. When Engineering Harness V0.4+ is active, FULL checkpoints should declare repository-relative include/exclude ownership so unrelated checkpoint changes do not invalidate each other; the final review remains bound to the whole final source.
- During automated scoped development, modifying files outside the active checkpoint ownership is a harness violation. Preserve those changes for diagnosis; do not silently reset or delete them.
- Preserve prior verdicts and results. Never rewrite failed runs as passed or mark unchecked items complete.

## 4. Files used for each feature

For one active feature, use root `TASK.md` and `handoff/<feature-id>/`.
For simultaneous features, use separate worktrees or `tasks/<feature-id>/TASK.md`; never overwrite another task's state. Record the chosen task path in its session file.

- `TASK.md`: objective, scope, target files, acceptance criteria, checkpoints and status.
- `handoff/<feature-id>/review-session.md`: active reviewer plus per-provider/model session IDs, exact model IDs, project path, checkpoints and fallback history (section 7).
- `handoff/<feature-id>/review-request.md`: small current request, finding resolutions and evidence references.
- `handoff/<feature-id>/review-01.md`, `review-02.md`, etc.: actual reviewer results, retained without rewriting.
- `handoff/<feature-id>/evidence/`: relevant logs, screenshots and review-checkpoint diffs or links to retained artifacts.

Scale paperwork with risk: NONE needs only a short task record and verification summary; omit reviewer files. LIGHT needs a short task and review packet, using one review session if available. FULL uses all applicable artifacts above. Do not create empty files just to satisfy the list.

Keep credentials, tokens, private production data and machine-specific secrets out of handoffs. Session IDs and absolute workspace paths are local metadata: do not copy them into the next project's template or publish them without checking.

## 5. Team leader: define the task

Before setting READY_FOR_DEV:

- Inspect existing implementations, callers, tests and project rules. Reuse existing components before creating new abstractions.
- State the outcome, in-scope files, excluded work and expected behavior at failure boundaries.
- Give each acceptance criterion a stable ID such as A1, A2. Define observable outcomes, not "works correctly".
- Select and record the review level. For FULL, define small independently testable/reviewable checkpoints; LIGHT has one final review gate, NONE has verification without independent review.
- Specify required regression/release checks and safe test resources. Do not invent commands; inspect the project's scripts/config.
- State whether additional approval is needed for migrations, dependency changes or broader file ownership.

Task skeleton:

```markdown
# <Feature name>
Status: READY_FOR_DEV
Developer: Antigravity
Reviewer policy: <ordered reviewer profiles and effective approval threshold from project config>
Review-Level: <NONE | LIGHT | FULL>
Review-Level-Reason: <risk-based explanation>
Review-Level-Selected-By: <user or Codex team leader; instruction/decision reference>
Workspace: <absolute checkout path>
Baseline: <HEAD plus relevant existing changes>

## Objective
<User-visible outcome>
## Scope and ownership
<Allowed files; excluded changes; existing changes to preserve>
## Acceptance criteria
- A1: <observable behavior and failure boundaries>
## Checkpoints
- C1: <deliverable and verification; reviewer gate if LIGHT/FULL>
## Verification
<Actual commands, environment/resources, required outcomes>
## Risks and decisions
<Domain constraints, unresolved choices, authorizations>
```

## 6. Developer: implement and verify

- Read task and applicable rules. Inspect status/diff; announce intended file ownership.
- Preserve other agents' changes. Never reset, stash, switch branches, stop others' runners or change shared test data to make tests pass.
- Make the smallest complete change; avoid speculative abstractions and unrelated refactors/formatting.
- Reproduce independent bugs with regression tests before fixing them. If code already passes, call it compatibility evidence; never invent a RED run.
- Assert observable behavior. Avoid vacuous assertions, callback-only proof, weakened fixtures and disabled tests that hide defects.
- Exercise relevant missing/null/false/zero, permissions, tenant isolation, stale response, retry, duplicate submission and failed-write boundaries.
- Run focused checks during iteration, affected regressions at stable checkpoints and all required final gates. Do not rerun a full suite after every small edit.
- Keep source and shared resources stable during runs. Record command, cwd, environment, logs, final exit, counts/skips and source fingerprints. A green summary before runner/teardown exit is not completion.
- Reuse evidence only when relevant source, tests, fixtures, config, dependencies and environment match. Label it reused. Required fresh gates still apply.
- For LIGHT/FULL, submit READY_FOR_REVIEW with a compact packet and stop at the defined reviewer gate. For NONE, finish the agreed checks, record COMPLETED and report `COMPLETED — REVIEW NOT REQUIRED`, with changed files, verification and unchecked scope.

## 7. Adaptive approval policy, persistent sessions and token efficiency

- This section applies when independent review is required (LIGHT/FULL), not NONE.
- When Engineering Harness is installed, `.harness/config.yaml` is the authority for reviewer order and approval thresholds. Do not replace the configured order with a remembered or provider-specific default.

### Ordered-threshold reviewer policy

- Reviewers are configured as an ordered list of named profiles. Profiles may use Claude CLI, Codex, Antigravity, or another adapter explicitly supported by the installed harness.
- `approvalsRequired` is the number of independent APPROVED verdicts needed for the current gate. `maxReviewers` bounds the number of completed reviewer verdicts that may be consumed for the gate.
- Dispatch is lazy and sequential: call the first eligible reviewer, count a valid APPROVED verdict, and start the next reviewer only if the threshold is still unmet. Stop immediately once the threshold is satisfied. Do not call remaining reviewers merely because they are configured.
- A REVISE verdict stops the chain immediately. Return to the developer for the concrete findings, then resume the exact reviewer session for recheck. Never call later reviewers to outvote or shop around a REVISE verdict.
- Provider fallback is different from multi-approval review. Automatically advance past a reviewer only on observed quota exhaustion, service unavailability or unavailable model access. An unavailable attempt contributes no approval and no completed-review slot.
- A busy session, timeout, cancellation, missing session ID, local permission/auth failure, missing evidence or REVISE is not a fallback condition. Resolve it or mark BLOCKED.
- Each reviewer approval is bound to reviewer identity, exact session and reviewed source identity. If affected source changes, only still-current approvals count. If the current threshold is no longer satisfied, the gate is pending again.
- Project policy may define different thresholds for NONE/LIGHT/FULL. A per-task override requires recorded user/team-leader authority. The developer cannot weaken or silently lower the threshold.
- Verify exact model IDs against provider/runtime capabilities. Never infer model IDs from display names or silently substitute another reviewer.
- If all eligible reviewers are unavailable before the threshold can be met, set BLOCKED. Never self-approve. No installation, account change, subscription purchase or permission bypass is authorized by fallback.

### Session reuse protocol — required for every review call

1. Read canonical harness session state (and any human-readable review-session handoff) and identify feature, workspace, reviewer profile, provider and exact model.
2. Confirm the reviewer is separate from the developer conversation. Reusing the developer chat with a different model is not independent review.
3. Resume the existing recorded session for that reviewer profile + provider/model + feature. Never use `--last`, `--continue`, or `-c` to select an ambiguous most-recent conversation.
4. Confirm it is idle before sending. Record in-flight request/round and runner ID when available. Never operate one session simultaneously from CLI and desktop or launch duplicate reviews while an earlier invocation is still running. Clear in-flight state only after confirmed completion/failure; a timeout alone is not proof of exit.
5. If this feature has no session for the selected reviewer profile, create one separate reviewer session once, then capture the actual returned session/conversation ID. If ID retrieval/resumption fails, stop and diagnose; do not silently create a new session each round.
6. Send only the concise review packet path, finding IDs and review scope. Resume the same session for corrections and follow-ups.
7. Store the actual verdict, reviewed source identity and session/model used. Never attribute a fallback verdict to Codex.

Keep **one saved session per feature per reviewer profile/provider/model**, with only one request in-flight per session. Claude, Codex and Antigravity session IDs are not interchangeable, and two named profiles using the same provider/model must not silently share a session. Switching providers requires a handoff, not cross-provider session resumption. Reuse the saved session if that reviewer returns later; first load the newer decisions and findings it missed.

Invocation patterns for manual operation (verify installed help before use; the harness adapter is authoritative when installed):

```powershell
# Claude CLI reviewer: resume the exact dedicated review session.
claude -p --output-format json --model <VERIFIED_CLAUDE_MODEL_ID> --permission-mode plan --resume <CLAUDE_SESSION_ID> "Read-only follow-up review. Read the current review packet, unresolved findings and changed source. Return the required structured verdict."

# Codex reviewer: resume its dedicated reviewer session and explicitly retain the configured model.
codex exec resume <CODEX_SESSION_ID> --model <VERIFIED_CODEX_MODEL_ID> "Read-only follow-up review. Read the current review packet. Verify unresolved findings, incremental changes and affected dependencies. Return the required structured verdict."

# Antigravity reviewer: resume the separate reviewer conversation, never the developer conversation.
agy --conversation <AG_REVIEW_CONVERSATION_ID> --model <VERIFIED_REVIEWER_MODEL_ID> --mode plan -p "Independent read-only follow-up review. Read the current review packet and applicable project rules. Verify unresolved findings and changed code. Do not edit application files. Return the required structured verdict."
```

These are command patterns, not a script installed by this document. CLI availability, authentication, model IDs and session support must be verified locally. `--mode plan` expresses the intended mode; it is not a substitute for permission controls. Do not add bypass flags. If an existing session is only accessible through its UI, request that route instead of duplicating it.

Session record skeleton (fill only actual known values; omit unused fallback entries):

```markdown
# Reviewer sessions — <feature-id>
Task: <path>
Workspace: <absolute checkout>
Active reviewer: <configured reviewer profile / provider / exact model>
Checkpoint / round: <IDs>
Approval policy: required=<N>; max-reviewers=<M>; current=<reviewer IDs>
In-flight: <none, or request/runner ID and start time>

## Saved sessions
- <reviewer-profile-1>: provider=<provider>; model=<exact ID>; session=<actual ID>
- <reviewer-profile-2>: provider=<provider>; model=<exact ID>; session=<actual ID>
- <reviewer-profile-3>: provider=<provider>; model=<exact ID>; session=<actual ID>

## Latest reviewed state
Verdict: <path>
Source checkpoint: <HEAD, fingerprints and retained diff/content>
Unresolved findings: <IDs>

## Fallback history
- <time>: <from -> to>; reason=<actual quota/service/access error>;
  handoff=<packet path>; previous invocation=<confirmed terminal state>
```

### Keep review context small

- Keep the packet short; reference files/logs instead of pasting whole transcripts. Read relevant code, not unrelated repository history.
- Save a reproducible reviewed-source checkpoint: HEAD, fingerprints and sufficient preserved content/diffs to compare the next round. HEAD alone cannot identify a dirty state; hashes identify changes but do not reconstruct them. Never create commits or discard work merely to obtain a checkpoint.
- Follow-up reviews inspect fixes plus affected callers/tests; expand when dependency or risk requires it. FULL requires a final whole-change review. LIGHT's single gate covers the whole small task; do not add a duplicate final review after it passes.
- Avoid duplicate parallel reviews and unnecessary test reruns. Long session history still has a cost; reuse does not guarantee token savings. If history becomes unwieldy, propose a concise handoff and new session rather than silently losing prior findings.
- Harness-managed review calls should keep a stable contract prefix, send full task context only to a new reviewer session, and use delta-oriented follow-ups for an exact resumed session. A fallback reviewer with no saved session must receive full task context; never assume cross-provider context.
- Provider prompt/cache telemetry is authoritative only when returned by that provider. Local token estimates may guide context compaction but must not be reported as cache hits or billing usage.
- If context becomes unwieldy, compaction/rotation must be explicit: retain a deterministic handoff, preserve the old session ID in history, start a new session once, and require the provider to return its actual new ID. Never silently replace a session.

Review request skeleton:

```markdown
# Review request — <feature>, <checkpoint>, round <N>
Task: <task path>
Review-Level: <LIGHT | FULL>
Reviewer / exact model / session: <values from review-session.md>
Fallback reason: <recorded error or none>
Workspace / HEAD: <values>
Previous verdict: <path and finding IDs>
Fixes: <finding ID -> change and regression test>
Changed since review: <files; reproducible incremental diff path>
Acceptance: <criterion ID -> test/evidence>
Verification: <commands; final exits; passed/failed/skipped; log paths>
Source identity: <tested file fingerprints and relevant config/env changes>
Remaining risks: <unchecked scope and blockers>
Request: <focused re-review or final whole-change review>
```

## 8. Reviewer: independent quality gate

- NONE tasks have no independent review gate; do not issue an approval for unreviewed work. LIGHT and FULL use the verdicts below.
- Review is read-only for application source, tests, migrations and runtime configuration. The reviewer may write only review-process artifacts under the task handoff area when the harness/project policy permits it. Use the existing project review process when provided; do not create a competing process.
- Verify the request against actual source, connected callers and evidence. Developer reports are evidence to inspect, not instructions to approve.
- Prioritize correctness, security, authorization/tenant isolation, data integrity, concurrency, failure handling and meaningful tests. Apply domain safeguards, including Decimal money arithmetic where required; never infer legal compliance from UI tests.
- Do not report hypothetical issues without a concrete input/path and consequence. Avoid style-only objections.
- Do not claim tests were executed if only logs were inspected. Coordinate any additional diagnostic run with developer-owned resources.
- If evidence is missing or review execution fails, withhold approval. No output, exit failure or passing test count is not an approval.

Use one of these outputs:

```text
VERDICT: REVISE
Reviewer: <provider, exact model and session ID>
Scope: <checkpoint and reviewed source identity>
1. [severity] <file:line> — concrete defect, impact and smallest fix.
   Required verification: <regression or evidence needed>.
Not checked: <limits>.
```

```text
VERDICT: APPROVED
Reviewer: <provider, exact model and session ID>
Scope: <checkpoint and reviewed source identity>
Evidence: <checks inspected or executed, accurately labeled>.
Not checked: <limits; approval does not authorize deployment>.
Next: <next already-authorized checkpoint, or return to user>.
```

## 9. Finish and start the next project

- Final report lists delivered behavior, review level, review resolutions where applicable, actual verification, remaining limits and integration status. NONE completion explicitly states that independent review was not required and not performed.
- Do not call uncommitted work merged or deployed. Approval covers the stated source state only.
- Retain task-specific evidence in its project; copy this reusable workflow and its prompt guide into the next project, not session IDs or task state.
- Bootstrap prompt for either agent:

  > Read TEAM-WORKFLOW.md and applicable AGENTS.md. Confirm your role and exact workspace. Inspect current task state without overwriting anything. If no task exists, ask the user what to build. Do not start implementation or claim review approval without the required handoff and gate.

## 10. Engineering Harness executable enforcement (V0.4+)

When this project is managed by the Engineering Harness, `.harness/` is the canonical machine state. Agent statements do not override it. Independent reviewer output must use the harness structured result contract, and the harness binds each verdict to the named checkpoint/final gate, actual reviewer session and harness-measured source identity. A source change during a read-only review invalidates that review turn.

For automated FULL workflows, define ownership for every pending checkpoint with `harness task checkpoint scope <id> <include...> [--exclude <pattern...>]`. Scoped checkpoint fingerprints are content-based and intentionally independent of global HEAD, so later unrelated checkpoint changes do not invalidate earlier approvals. Changes inside a checkpoint's ownership do invalidate that checkpoint.

Project provider/model profiles and ordered-threshold approval policy are stored in `.harness/config.yaml`. Their reviewer order and effective per-level/task threshold are the harness review authority for that project; do not silently substitute a different model/provider. `harness run` may automate developer -> verification -> review -> fix/recheck -> final only after the task has been explicitly moved out of DRAFT. It never authorizes commit, push, merge, deployment, destructive cleanup or production access. Existing project rules and explicit user authorization still take precedence.


### Runtime recovery when Engineering Harness V0.5+ is active

Provider turns are tracked by request ID and PID. A live recorded process must not be duplicated. If a harness crash leaves a provider process/session without a confirmed terminal result, the harness marks it `uncertain`; do not clear or reuse that session merely because the previous CLI invocation ended. Inspect runtime/session state and explicitly resolve uncertainty before continuing. Timeout or cancellation is not evidence of reviewer unavailability and does not authorize fallback.

## 10. Engineering Harness V0.7 operator metadata

When Engineering Harness V0.7+ is active:

- Use `harness agent models antigravity --refresh` to probe Antigravity's actual provider catalog. Do not invent model IDs. Codex and Claude remain runtime-validated unless their adapters gain a supported catalog probe.
- `harness run --progress` and `harness events` expose sanitized harness metadata only. Do not use event records as a substitute for review evidence or provider transcripts.
- Use `harness migration plan`/`history` before or after upgrading old projects when provenance of configuration changes matters. Downgrades are not an automatic migration path.
- `harness release generate`/`verify` may produce source provenance, SPDX SBOM and checksums. Optional signing does not authorize publishing, deployment, commit, push or release distribution.

## 11. Engineering Harness V0.8 operator/CI/scheduler rules

When V0.8+ is active:

- `harness ui` is a sanitized operator view, not review evidence and not a raw agent transcript.
- Generated GitHub/GitLab CI is verification-only by default. It does not authorize agent execution, publishing or deployment.
- Never overwrite unmanaged CI configuration unless the user explicitly authorizes `--force` after reviewing the target file.
- Optional keyless release signing delegates to installed `cosign`; do not persist OIDC tokens or fabricate a successful Sigstore verification.
- Multi-workspace scheduling may dispatch only initialized isolated roots with runnable tasks and no active/uncertain provider runtime or held run lease.
- Each scheduled workspace retains its own task lifecycle, exact provider sessions, evidence, review gates and run lease. Scheduler completion is not review approval.


## 12. Engineering Harness V0.8.1 adaptive review rules

When V0.8.1+ is active:

- `.harness/config.yaml` defines the ordered reviewer profiles and per-level approval threshold. Do not replace that order with a remembered provider default.
- Review dispatch is lazy: call only enough reviewers to satisfy `approvalsRequired`; do not spend tokens on remaining profiles after the threshold is met.
- `REVISE` stops the chain immediately and returns to FIX/RECHECK. Later reviewers cannot outvote a concrete finding.
- Only quota/service/model-access unavailability permits provider fallback; unavailable attempts do not count as approvals or completed reviewer slots.
- Each approval is bound to reviewer profile, exact session and source identity. Stale reviewer approvals stop counting automatically.
- Per-task threshold overrides require explicit user/team-leader authority in canonical state. Developer output cannot weaken the requirement.
- Named reviewer profiles using the same provider/model still require independent exact sessions and independent usage accounting.
- Claude CLI, Codex and Antigravity reviewer sessions are provider-specific; never resume one provider's session ID with another provider.


## 13. Plan-native execution (V0.8.2+)

- A user-owned plan file may be imported with `harness plan import <path>`. Import is read-only analysis and creates a DRAFT canonical manifest; it never authorizes coding.
- The planner is the explicit project planner profile when configured, otherwise the first configured reviewer profile in read-only planning mode. Planner work is not review approval.
- Inspect `harness plan show`, then use `harness plan approve` for explicit authorization. `harness plan run` materializes generated tasks in dependency order and delegates each task to the normal developer/evidence/review gates.
- Every plan-generated task is bound to the plan source path and SHA-256. If the plan changes after import, stop with PLAN_CHANGED; do not reinterpret changed requirements under old approvals.
- The harness validates task IDs, dependencies/cycles, acceptance criteria, review level, FULL checkpoint ownership scopes, and configured verification keys before accepting planner output.
- Do not silently broaden the plan. Missing or ambiguous requirements remain missing/ambiguous; planner-derived decomposition must stay grounded in the plan and actual repository.


## 14. Plan logical workspaces (V0.8.3+)

- Every imported plan owns `.harness/plans/<plan-id>/` as its canonical logical workspace.
- Plan task state, sessions, reviews, evidence, compacted context, metrics and archives belong under `tasks/<task-id>/`; plan runtime/lease/events belong under `execution/`.
- The project-level active-task record is only a pointer for plan tasks; never treat a second project-global task copy as authority.
- Task IDs may repeat across different plans. Never reuse a review/session/evidence artifact across plans solely because the task ID text matches.
- If a task lookup is ambiguous across plans and no active plan context resolves it, stop rather than guess.
- Non-plan tasks continue to use project-global harness state and must not be routed into a completed plan workspace.
- Migration from older plan-native versions must preserve artifacts that cannot be assigned safely; never guess historical evidence ownership.
