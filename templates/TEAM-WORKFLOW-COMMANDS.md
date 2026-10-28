# Team Workflow — Copy-Paste Prompt Guide

Workflow-Version: 0.8.3

Copy `TEAM-WORKFLOW.md` and this guide into each project; keep both filenames unchanged. When Engineering Harness is installed, `harness init` manages this bootstrap safely.

The labels below are human-friendly prompt names, NOT installed slash commands or shell commands. Paste a prompt into the indicated agent's chat and replace text in angle brackets. These prompts follow TEAM-WORKFLOW.md; they do not replace project-specific AGENTS.md rules.

When Engineering Harness profiles are configured, `.harness/config.yaml` defines reviewer order and the approval threshold for each review level. Reviewers are dispatched lazily until the threshold is met. REVISE stops the chain immediately; only quota/service/model-access unavailability may fall through to the next reviewer. Each reviewer profile resumes its own exact feature session. See section 7 of TEAM-WORKFLOW.md.

## HELP — When you forget what to do (either agent)

```text
Read TEAM-WORKFLOW.md and TEAM-WORKFLOW-COMMANDS.md.
Inspect the current task status without editing files or starting work.
Tell me: current stage, review level, next responsible agent, and the exact
prompt I should send next. If there is no task, ask what I want to build.
```

## SETUP — Initialize a new project (Codex)

```text
Read TEAM-WORKFLOW.md. Set up this project's AG/Codex workflow.
Preserve existing instructions; add a reference to TEAM-WORKFLOW.md in
the root AGENTS.md if missing. Do not replace existing domain rules.
You are team leader/reviewer; Antigravity is developer.
Confirm the absolute workspace and current Git state. Do not create a
feature task, install tools or change application code yet.
```

Then tell AG:

```text
Read TEAM-WORKFLOW.md and applicable AGENTS.md. You are the developer.
Confirm your workspace matches Codex's workspace: <absolute path>.
Inspect task state and wait if no task is READY_FOR_DEV. Do not self-approve.
```

## PLAN — Define a feature or fix (Codex)

```text
Read TEAM-WORKFLOW.md and applicable AGENTS.md.
I want: <desired outcome or bug description>.
Inspect existing code and define the task with target files, scope,
observable acceptance criteria and verification. Select and explain
NONE, LIGHT or FULL based on risk; default to FULL if uncertain.
Record the selection and set READY_FOR_DEV when the task is actionable.
Preserve other active tasks. Do not implement application code.
```

## SIMPLE — Non-functional change without review (AG)

```text
Read TEAM-WORKFLOW.md and applicable AGENTS.md.
Task: <exact typo, formatting or ordinary documentation change>.
Review-Level: NONE. Selected by: user.
Scope: <allowed files and exclusions>.
Check that this is genuinely low risk; if it changes behavior, security,
deployment procedures, agent authority or domain guarantees, stop and
request reclassification. Otherwise make the minimal change, inspect
the diff and run proportional checks. Record a brief task entry without
overwriting other work. Report COMPLETED — REVIEW NOT REQUIRED with
verification and unchecked scope. Do not launch a reviewer or commit.
```

## SMALL — Isolated behavior change with one review (Codex)

```text
Define a small task for: <change>.
Preferred Review-Level: LIGHT; confirm the risk classification first.
Use a short task, focused behavioral tests and one independent review
gate. No separate architecture gate. Escalate to FULL if the change touches
financial logic, permissions, tenant isolation, security, data migrations
or concurrency. Do not implement code.
```

## DEVELOP — Implement the authorized task (AG)

```text
Read TEAM-WORKFLOW.md, applicable AGENTS.md and <task path>.
Confirm workspace, file ownership and selected review level.
Implement the next authorized checkpoint, preserving existing edits.
Run focused tests and required checkpoint checks; record actual exits
and tested source state. For LIGHT/FULL, prepare the review packet and
stop at READY_FOR_REVIEW. For NONE, finish verification and report
COMPLETED — REVIEW NOT REQUIRED. Do not commit, push or deploy.
```

## REVIEW — Review a submission (active authorized reviewer, same feature chat)

```text
Read TEAM-WORKFLOW.md, <task path> and <review-request path>.
Review the actual diff, affected callers and test evidence read-only.
Check acceptance criteria and project domain constraints. Do not assume
the developer's completion or approval claims are valid.
Return VERDICT: REVISE with numbered concrete findings, or
VERDICT: APPROVED for the named checkpoint and source state.
State what you inspected versus executed and what remains unchecked.
```

## FIX — Resolve review findings (AG)

```text
Read <review-result path>. Fix findings <IDs> within the authorized scope.
Verify each finding against the code; explain with evidence if you disagree.
Add meaningful regression tests and run affected checks. Update the
review packet with finding-to-fix mapping, incremental diff and log paths.
Stop at READY_FOR_REVIEW; do not self-approve or erase previous findings.
```

## RECHECK — Token-efficient follow-up (active authorized reviewer, same feature chat)

```text
Read <updated review-request path>.
Re-review findings <IDs>, changes since the last reviewed checkpoint,
and affected dependencies. Reuse unchanged verified context; expand
inspection where needed for correctness. Do not repeat unrelated reviews
or duplicate tests without a reason. Return the checkpoint verdict,
remaining numbered findings and unchecked scope.
```

AG may dispatch the review using REVIEW-CALL below. Use the recorded explicit session for THIS feature and reviewer, never a developer session or a session copied from another project. Codex and AG IDs are not interchangeable.

## REVIEW-CALL — Dispatch/resume the configured independent reviewers (AG)

```text
Read TEAM-WORKFLOW.md section 7, canonical harness review policy and session state.
Review-Level NONE: do not launch a reviewer.
Otherwise prepare the compact packet and use reviewer profiles in configured order.
Resume each profile by its exact saved feature session; do not use --last,
--continue or an unrelated developer/provider session.
Dispatch lazily: after each APPROVED verdict, stop if approvals_required is met;
otherwise call the next eligible reviewer. Do not call unused reviewers.
If any reviewer returns REVISE, stop the chain immediately, preserve findings,
return to FIX, then recheck through the exact relevant reviewer session(s).
On confirmed quota/service/model-access failure only, advance to the next
configured reviewer. Unavailable attempts do not count as approvals or completed
review slots. Timeout, cancellation, auth/permission failure, missing evidence and
REVISE are not fallback conditions.
Persist every approval with reviewer profile, exact session and source identity.
If a source change invalidates an approval, do not count it toward the threshold.
If the threshold cannot be met within max_reviewers/available reviewers, BLOCK.
Never self-approve or use later reviewers to outvote a concrete finding.
```

Command patterns are in TEAM-WORKFLOW.md. Check `codex exec resume --help`, `agy --help` and the available model catalog when initializing, not repeatedly on every unchanged review round. Verify changed client/account/model availability when necessary. No installation or account switch is implied.

## REVIEW-STATUS — Find the current reviewer/session (either agent)

```text
Read handoff/<feature-id>/review-session.md and the latest review result.
Report active reviewer/model, session ID, checkpoint, unresolved findings,
in-flight request if any, and the next safe review action.
Do not launch, resume, switch or duplicate a review in this step.
```

## FINAL — Whole-change gate (active authorized reviewer, FULL tasks)

```text
Perform the final whole-change review against <task path> and its complete
acceptance map. Check all checkpoint findings are resolved and required
regressions/evidence match the final source. Review remaining integration
risks. Return VERDICT: APPROVED or VERDICT: REVISE with unchecked scope.
Do not merge, commit, push or deploy. LIGHT tasks already approved at
their complete-task gate do not need a duplicate final review.
```

## STATUS — Get progress without starting work (either agent)

```text
Read current task/handoff state. Report status, review level, completed
scope, active runners if known, blockers and the next responsible agent.
Do not edit, launch tests, message another agent or resume implementation.
Do not present old test results as verification of changed source.
```

## STOP — Pause safely (send to each active agent)

```text
Stop this task. Do not start new edits or tests. Preserve existing work.
Report partial changes and active runners; stop only your own task runners
gracefully where safe and record interrupted checks as incomplete.
Do not reset, stash, delete work or stop another agent's processes.
Leave a concise handoff with the next safe step, then wait for me.
```

## CONTINUE — Resume safely (responsible agent)

```text
Read TEAM-WORKFLOW.md and the latest task, review and handoff files.
Confirm workspace/source state and check for active runners before acting.
Continue only the next authorized step for your role and review level.
Do not redo approved unchanged work, bypass a pending review, or restart
a test already running. If blocked, explain the specific action needed.
```

## RECLASSIFY — Change review level (Codex)

```text
Assess changing <task path> from <current level> to <requested level>.
Inspect actual scope and risk. Record your decision and rationale, keeping
prior findings and evidence. Do not downgrade to bypass a defect or failed
review. If accepted, update the task's review level and selected-by field.
No application edits or review dispatch in this step.
```


## CONTEXT — Inspect or compact a long-running exact session (either agent/operator)

```text
Use the harness context status for the current task. Treat estimated prompt
tokens as a local estimate only; provider cache/token data is authoritative
only when the provider reports it. If compaction is recommended, do not
silently create a new session. Create a deterministic compact handoff, mark
the exact session for explicit rotation, and preserve the previous session ID.
The next turn must start a fresh session with that handoff and record the new ID.
```

Harness commands:

```text
harness context status
harness context compact <developer|reviewer> <provider> <model>
harness metrics
```

## Quick choice

- Ordinary typo/docs/formatting: SIMPLE to AG, if genuinely non-functional.
- Small isolated behavior: SMALL to Codex, then DEVELOP to AG and REVIEW to Codex.
- Risky or substantial feature: PLAN to Codex, then checkpoint DEVELOP/REVIEW cycles and FINAL.
- Reviewer requests fixes: FIX to AG, then RECHECK in the same active reviewer feature chat.
- AG should invoke the reviewer for you: REVIEW-CALL. It must reuse saved sessions and honor the fallback conditions.
- Need the reviewer/session ID: REVIEW-STATUS.
- Unsure: HELP. A short diff is not proof of low risk.

No prompt in this guide authorizes production access, publishing, deployment or destructive changes. Review-level NONE skips independent review, not verification or safety.

## HARNESS — Executable workflow (V0.4+)

When the Engineering Harness CLI is installed, prefer machine-enforced ownership/state over manually copying verdicts. Configure verified provider/model profiles once:

```text
harness profile set developer antigravity <verified-model-id>
harness profile add reviewer claude-opus claude <verified-model-id>
harness profile add reviewer codex codex <verified-model-id>
harness profile add reviewer ag-gemini antigravity <verified-model-id>
harness profile order reviewers claude-opus,codex,ag-gemini
harness review policy set LIGHT 1 2
harness review policy set FULL 2 3
```

For FULL checkpoints, declare ownership before automated development:

```text
harness task checkpoint scope C1 src/auth/** tests/auth/** --exclude src/auth/generated/**
```

After the user/team leader has authorized the task by moving it to READY_FOR_DEV, the complete loop can be invoked with:

```text
harness run
```

Manual gates remain available:

```text
harness review run checkpoint:<id> configured [focused request]
harness review run final configured [focused request]
```

Optional task-specific assurance override (user/team leader only):

```text
harness task review-policy set <approvals-required> [max-reviewers]
harness task review-policy clear
```

The harness validates developer ownership, verification evidence, structured reviewer output, exact session/source identity, checkpoint/final eligibility and resulting state transitions. Do not manually mark a task approved or broaden scope to bypass a failed harness gate.


## RUNTIME — Recover/cancel provider execution (Harness V0.5+)

```text
harness runtime status
harness runtime reconcile
harness runtime cancel <request-id>
```

If a provider process/session is marked uncertain after a crash, inspect the provider and runtime logs first. Resolve only with explicit knowledge of the previous turn; never clear uncertain state merely to continue orchestration.

## OPERATOR — V0.7 catalog, events, migrations and release metadata

```text
harness agent models antigravity --refresh
harness agent models codex
harness run --progress
harness events --limit 50
harness migration matrix
harness migration plan
harness migration history
harness release generate
harness release verify
harness release sign <ed25519-private-key.pem>
```

Treat a provider model as catalog-validated only when the adapter returns a real catalog. Do not infer unavailable Codex model IDs from UI labels. Progress events are sanitized metadata, not raw agent transcripts. Release provenance/SBOM/signature verification records source/package integrity only and grants no permission to publish or deploy.

## OPERATOR-V08 — Dashboard, CI, keyless signing and workspaces

```text
# Realtime sanitized terminal dashboard
harness ui
harness ui --once

# Generate verification-only managed CI
harness ci generate github
harness ci generate gitlab

# Optional external-cosign keyless signing
harness release keyless-sign
harness release keyless-verify --identity <identity> --issuer <issuer>

# Register isolated worktrees/projects and inspect scheduler eligibility
harness workspace add <id> <path>
harness workspace list
harness scheduler plan
harness scheduler run --max-parallel 2
```

Generated CI must not be treated as permission to run coding agents or publish/deploy. An unmanaged CI file is preserved unless the user explicitly authorizes forced replacement. Scheduler dispatch never bypasses the target workspace's own run/session/review policies.


## PLAN-IMPORT — Analyze a plan and create a canonical task queue

```text
harness plan import <project-relative-plan.md>
harness plan show
```

Import does not start coding. After inspecting the generated task/dependency/checkpoint/acceptance map:

```text
harness plan approve
harness plan run --progress
```

If the source plan changes after import, re-plan explicitly; never continue old generated tasks or approvals against a changed plan.


## PLAN-WORKSPACE — Inspect plan-scoped canonical artifacts

```text
harness plan list
harness plan workspace
harness plan workspace <plan-id>
```

Use this when checking which task/review/evidence/session artifacts belong to a plan. Never infer ownership from task ID alone when multiple plans exist.
