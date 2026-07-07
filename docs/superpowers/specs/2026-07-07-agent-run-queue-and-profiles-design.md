# Agent Run Queue and Execution Profiles Design

Date: 2026-07-07

## Context

`gitlab-claude-webhook` currently starts webhook work with a fire-and-forget call to `EventProcessor.processEvent()`. This allows multiple webhook events to run at the same time, but it does not provide safe task-level concurrency because `EventProcessor` stores run state in instance fields such as `currentCommentId`, `currentDiscussionId`, and `progressMessages`.

Review mode also grants broad `Bash` access. The prompt says build, test, lint, compile, or validation failures should not stop the review, but it does not prevent ordinary review requests from starting those commands. As a result, a normal review can spend time on `cargo check` or similar CI-style validation even when CI/CD already handles that work.

The goal is to make ordinary review predictable, queue agent work safely, and prepare the service for provider/plugin profiles similar to Claude Code or Codex sessions.

## Goals

- Default ordinary review to static repository inspection, without running build, test, lint, compile, format, or typecheck commands.
- Continue a review when a denied or failed tool call occurs; tool problems should become review context, not terminate the whole run.
- Add a queue so tasks do not corrupt each other's GitLab progress comments, discussion replies, or in-memory progress state.
- Allow different merge requests to run concurrently when configured, while serializing work for the same project resource.
- Introduce execution profiles so Claude, Codex, CodeRabbit, and future plugin-backed behavior can be selected consistently.
- Keep the first implementation pragmatic and local-first; GitLab Runner execution remains an extension point for heavyweight verification.

## Non-Goals

- Replacing the existing multipass review engine in the first implementation.
- Making GitLab Runner the default execution path.
- Automatically running CI-equivalent validation during ordinary review.
- Implementing a full plugin marketplace UI in the first pass.
- Solving cross-process queue persistence for multiple service replicas in the first pass.

## Recommended Approach

Implement a `RunQueue` plus per-run `RunContext`, then route execution through explicit `ExecutionProfile` definitions.

This is preferred over adding command-specific fallbacks because command-specific handling will keep failing when the model tries a new validation command. It is also preferred over a runner-first rewrite because most review work should remain fast, local, and read-only.

Alternative approaches considered:

- Minimal patch: strengthen review prompts and add a few blocked command patterns. This is fast but brittle and does not fix shared state.
- Runner-first architecture: run all AI work inside GitLab Runner. This isolates tools well, but it adds pipeline latency and shifts ordinary review into a heavier CI path.
- Recommended profile architecture: define safe local profiles now, add runner-backed profiles later for explicit verification or build-heavy tasks.

## Execution Profiles

Add a profile layer used by both webhook command parsing and admin configuration.

### `review-static`

Default for `/code-review` and ordinary review commands.

Behavior:

- Read-only.
- No file edits, commits, pushes, or git state changes.
- No build, test, lint, compile, format, typecheck, package install, or dependency update commands.
- Allowed repository inspection commands are narrow and explicit, such as `git diff`, `git show`, `git log`, `git blame`, `git status`, `rg`, `grep`, `find`, and safe file reads.
- If a disallowed command is requested by the model, the tool policy denies it and returns a structured message explaining that the profile is static-review only. The run continues.
- The prompt explicitly says CI/CD owns validation; ordinary review should inspect code and history only.

### `review-verify`

Explicit opt-in for validation-heavy review.

Activation examples:

- `/code-review --verify`
- Admin-selected default for specific projects.
- Future GitLab label or MR setting.

Behavior:

- Still read-only with respect to source changes.
- Allows configured build/test/lint/compile commands.
- Can use the local deepflow build image or a future GitLab Runner backend.
- Validation failures are included in the review result, but should not prevent static findings from being produced.

### `implement`

For requests that ask the agent to modify code.

Behavior:

- Uses the existing Claude/Codex editing workflow.
- Can keep broad Claude Code tools when explicitly requested.
- Should still run inside the queue to avoid GitLab comment/progress state corruption.

### `custom-agent`

For admin-defined execution behavior.

Behavior:

- Selects provider, model, timeout, tool policy, plugin profile, and prompt overlays.
- Intended for controlled experiments and team-specific workflows.

## Tool Policy

Introduce a provider-neutral `ToolPolicy` model:

- `baseTools`: high-level tools exposed to the executor.
- `allowedCommands`: command allow patterns for Bash-like execution.
- `deniedCommands`: command deny patterns for high-risk or profile-incompatible commands.
- `denialMode`: `soft` for return-denial-and-continue, `hard` for abort.
- `readOnly`: prevents write/edit tools and git state mutation.

For Claude Code, map this policy to SDK options:

- Use `tools` to restrict available built-in tools.
- Use `allowedTools`/`disallowedTools` where the SDK supports them.
- Use `canUseTool` as the final guard for Bash command decisions so denial is systematic rather than prompt-dependent.
- Use local plugin configs only from validated absolute paths.

For Codex, map the same profile concept to its supported tool/config/prompt controls. Codex does not need to mimic Claude plugin internals; it only needs equivalent behavior.

## Queue and Run State

Create an `AgentRun` model:

- `id`
- `status`: `queued`, `running`, `succeeded`, `failed`, `canceled`
- `eventType`
- `projectId`
- `resourceType`: `merge_request`, `issue`, `note`, or `branch`
- `resourceIid`
- `branch`
- `headSha`
- `instruction`
- `provider`
- `profileId`
- `pluginProfileId`
- `commentId`
- `discussionId`
- `progressEntries`
- `createdAt`, `startedAt`, `finishedAt`
- `error`

Create a `RunContext` passed through execution:

- Holds the run id and GitLab target.
- Owns progress comment ids and discussion ids.
- Owns progress entries.
- Provides `updateProgress()`, `complete()`, and `fail()` helpers.

`EventProcessor` should stop storing per-run mutable fields on the class instance. Methods that currently read or write `currentCommentId`, `currentDiscussionId`, or `progressMessages` should receive `RunContext`.

## Queue Semantics

`WebhookServer` should enqueue work and return immediately:

- Response includes `runId`, `status: "queued"`, and optionally an admin URL.
- No webhook request should directly execute long-running agent work.

The queue should support:

- Global concurrency limit, default `1` initially for conservative rollout.
- Per-resource serialization key: `projectId:resourceType:resourceIid`.
- Different resources can run concurrently when global concurrency allows.
- Same MR/issue/branch runs sequentially.
- Configurable timeout per profile.
- Cancellation and retry hooks for the admin UI.

Initial storage can use the existing JSON-store pattern for `AgentRun` history plus an in-memory worker loop. This is sufficient for a single service instance. The design should keep the interface ready for SQLite or Postgres if multiple replicas or crash-resumable queues become necessary.

## Plugin Profiles

Add `PluginProfile` configuration:

- `id`
- `name`
- `enabled`
- `provider`: `claude`, `codex`, `coderabbit`, or `any`
- `localPluginPaths`
- `promptOverlays`
- `skillIds`
- `mcpServers`
- `toolPolicyPatch`

Initial profiles:

- `none`: no additional plugin behavior.
- `superpowers`: injects selected skill instructions and, for Claude, may load a validated local plugin path when configured.
- `coderabbit`: uses a CodeRabbit provider adapter rather than pretending CodeRabbit is only a prompt skill.

CodeRabbit support should produce the same normalized review output shape as the existing review engine so GitLab publishing remains shared.

## Admin Configuration

Extend runtime config with:

- `queue.globalConcurrency`
- `queue.perResourceConcurrency`
- `profiles.defaultReviewProfile`
- `profiles.defaultImplementProfile`
- `profiles.availableProfiles`
- `pluginProfiles`
- `toolPolicies`

Admin UI additions:

- Queue/runs list with queued/running/completed/failed filters.
- Run detail view showing instruction, profile, provider, progress, errors, and GitLab target.
- Cancel and retry actions.
- Profile editor for model, timeout, provider, tool policy, and plugin profile.
- Review settings that choose `review-static` by default and expose `review-verify` as opt-in.

## Data Flow

1. GitLab sends webhook.
2. `WebhookServer` verifies the token and parses the event.
3. Instruction extraction determines provider and requested mode.
4. Profile resolver maps the instruction to `review-static`, `review-verify`, `implement`, or `custom-agent`.
5. `RunQueue.enqueue()` creates an `AgentRun`, stores it, and returns the run id.
6. Worker picks runs respecting global concurrency and per-resource serialization.
7. Worker creates `RunContext`.
8. Existing `EventProcessor` logic executes with `RunContext` instead of shared instance fields.
9. Executor receives resolved profile, tool policy, plugin profile, model, and timeout.
10. Progress and final result update the correct GitLab note/discussion through `RunContext`.
11. Run status is persisted.

## Error Handling

- Tool denial in `review-static` is soft by default and should not end the review.
- Build/test/compile failures in `review-verify` are captured and summarized, then static review continues.
- GitLab update failures are logged on the run and retried where safe.
- Executor crashes mark the run failed with a concise error and preserve progress history.
- Timeout marks the run failed or canceled according to whether the executor was actively aborted.
- Queue worker errors should not stop the queue loop.

## Testing Strategy

Unit tests:

- Profile resolution for `/code-review`, `/code-review --verify`, ordinary review phrases, and implementation commands.
- `ToolPolicy` denies validation commands in `review-static` and returns soft denial.
- `ToolPolicy` allows configured validation commands in `review-verify`.
- `RunQueue` serializes the same resource and allows different resources when global concurrency permits.
- `RunContext` keeps comment id, discussion id, and progress entries isolated per run.

Integration-style tests:

- Two different MR events run without sharing progress comments.
- Two events for the same MR are ordered.
- A denied `cargo check` in `review-static` does not terminate the review.
- A failed validation command in `review-verify` is reported while the review still returns findings or a no-findings conclusion.

Manual verification:

- Trigger ordinary `/code-review` on an MR and confirm no compile/test command runs.
- Trigger `/code-review --verify` and confirm configured verification is allowed.
- Trigger two MR reviews concurrently and confirm progress comments stay attached to the correct MR.
- Confirm admin config changes take effect without port conflicts.

## Rollout Plan

Phase 1:

- Add profile and tool policy types.
- Add `review-static` and `review-verify`.
- Make ordinary review static-only.
- Add tests around denied validation commands.

Phase 2:

- Add `AgentRun`, `RunContext`, and `RunQueue`.
- Refactor `EventProcessor` to remove per-run class fields.
- Add tests for same-resource serialization and different-resource concurrency.

Phase 3:

- Extend admin config and UI for queue visibility and profile selection.
- Add cancel/retry where feasible.

Phase 4:

- Add plugin profiles.
- Wire Claude local plugin dirs with path validation.
- Add CodeRabbit provider adapter behind a profile.

Phase 5:

- Add optional runner backend for `review-verify` and build-heavy workflows.

