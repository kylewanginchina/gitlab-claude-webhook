# Review Summary Thread Implementation Plan

> Execute inline in the existing review-skills worktree, following test-driven-development and verification-before-completion. The user approved the thread routing design in this conversation.

**Goal:** Publish manually requested `/code-review` summaries in the command's discussion, with the existing fallback to an MR comment and existing inline findings.

**Architecture:** Add an optional summary publisher to `GitLabReviewService.postReview`. `EventProcessor` supplies its existing `postComment` method, which already routes replies and handles unavailable discussions. Direct service callers retain the current default publisher.

**Tech Stack:** TypeScript, Jest, Node 20.20.2, Docker.

## Constraints

- Work only in `/home/gitlab-claude-webhook/.worktrees/review-skills`.
- Preserve summary text, SHA marker, inline finding positions, scoring and review settings.
- Tests run in read-only containers with `--network none`, public source mounts and temporary data; no real credentials, GitLab API calls or model requests.
- Preserve the running release and the original main rollback container; no merge or push.

## Task 1: Route summaries through the existing reply publisher

**Files:** `src/services/gitlabReviewService.ts`, `src/services/eventProcessor.ts`, `src/__tests__/runtimeConfigExecution.test.ts`, `README.md`.

- [ ] Add integration regressions using real review publication and `postComment`, mocking AI execution and GitLab transport. Cover an original discussion, no discussion, and a failed discussion reply. Verify one summary, inline positions and subsequent SHA-marker detection.
- [ ] Run the new regressions against the current code and confirm discussion routing fails.
- [ ] Extend `postReview` with `publishSummary?: (body: string) => Promise<void>` and choose the callback when present. Keep the existing top-level publisher as the default.
- [ ] Call `postReview(event, reviewContext, finalReview, body => this.postComment(event, body, runContext))` from the processor.
- [ ] Document thread placement and the actual MR-description webhook trigger; enabling review alone does not schedule reviews.
- [ ] Run the targeted suites, full Jest suite, both TypeScript checks, formatting/lint and server build using the isolated Docker harness. Review the focused diff and commit locally.

## Task 2: Publish and retain rollback

- [ ] Build a local image from the currently running image, copying only freshly compiled `dist`.
- [ ] Check startup with copied data in an isolated container. Verify summary routing through the compiled application with mocked external transport.
- [ ] Rehearse rollback using temporary isolated containers. Preserve a shortcut that restores original main through all retained releases.
- [ ] Verify an idle service, compare candidate environment/ports/mounts, switch, and verify revision, health, admin and port 3001.
- [ ] Report the deployed revision, verification results and the actual webhook trigger conditions.
