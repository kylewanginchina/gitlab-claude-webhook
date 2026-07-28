# Runtime Hardening Final Review and Fix Report

## Scope and Revision

- Worktree: `/home/gitlab-claude-webhook/.worktrees/runtime-hardening`
- Base SHA reviewed: `da5464289f88b24f4dd1557fb16d3063c9bc923d`
- Branch: `codex/runtime-hardening-fixes`
- Production instances and real data/log directories were not accessed. Image smoke tests used ephemeral container filesystems and temporary Docker volumes that were removed after the check.

## Requirement Review

### 1. Built-in review pass/scoring fallback is static-first

- Files: `src/services/gitlabReviewService.ts`, `src/__tests__/gitlabReviewService.test.ts`
- GREEN: disabled `review.pass.template` and `review.scoring.template` render built-in fallbacks containing the exact static-inspection policy.
- RED evidence (post-hoc controlled mutation): removed the scoring fallback policy line, then ran `npx jest --runInBand src/__tests__/gitlabReviewService.test.ts --testNamePattern='disabled pass and scoring templates use built-in fallbacks'`. The test failed because the scoring prompt lacked the exact required policy. The line was restored immediately.

### 2. Publication checks accept `sha` or `diff_refs.head_sha` and fail closed

- Files: `src/services/eventProcessor.ts`, `src/__tests__/runtimeConfigExecution.test.ts`
- GREEN: `getMergeRequestHeadSha` accepts top-level `sha` first and otherwise `diff_refs.head_sha`; missing values post a skip notification and return `false`. Tests directly cover top-level match/change, `diff_refs` match/change, and both fields missing.
- RED evidence (post-hoc controlled mutation): changed `return sha || diffRefsHeadSha` to `return sha`, then ran `npx jest --runInBand src/__tests__/runtimeConfigExecution.test.ts --testNamePattern='diff_refs head SHA'`. Both `diff_refs` cases failed: the match was blocked and the changed SHA reported an unverifiable head. The fallback was restored immediately.

### 3. Failed proposal dismissal persistence leaves in-memory state open

- Files: `src/admin/reviewCustomizationService.ts`, `src/__tests__/reviewCustomizationService.test.ts`
- GREEN: dismissal constructs a replacement proposal list, writes it atomically, and assigns it to memory only after the write resolves. The test rejects the first store write, verifies in-memory and restarted state remain `open`, then verifies a retry persists `dismissed`.
- RED evidence (post-hoc controlled mutation): moved `this.proposals = nextProposals` before the store write, then ran `npx jest --runInBand src/__tests__/reviewCustomizationService.test.ts --testNamePattern='keeps a proposal open and retryable when dismissal persistence fails'`. The test failed with in-memory status `dismissed`. Ordering was restored immediately.

### 4. Explicit empty runtime directories do not fall back

- Files: `docker-entrypoint.sh`, `scripts/verify-entrypoint-safety.sh`, `scripts/verify-runtime-image-files.sh`, `scripts/verify-deepflow-image-files.sh`
- GREEN: `${VAR-default}` preserves an explicitly empty `DATA_DIR`, `LOG_DIR`, or `WORK_DIR`; the allow-list check rejects it before filesystem ownership changes. Static scripts require the exact assignments, and the entrypoint safety script exercises all three empty variables.
- RED evidence (post-hoc controlled mutation): changed only `DATA_DIR` to `${DATA_DIR:-/app/data}`, then ran `ENTRYPOINT_TEST_IMAGE=gitlab-claude-webhook:runtime-hardening bash scripts/verify-entrypoint-safety.sh`. It failed: `empty-data-dir` was accepted and the mock recorded ownership operations for default directories. The assignment was restored immediately.

### 5. `C#` normalizes case-insensitively to `csharp`

- Files: `src/admin/reviewLanguages.ts`, `src/__tests__/reviewLanguages.test.ts`
- GREEN: `normalizeReviewLanguageHint` lowercases input and maps `c#` to `csharp`; the table test includes `C#`.
- RED evidence (post-hoc controlled mutation): removed the `c#` alias, then ran `npx jest --runInBand src/__tests__/reviewLanguages.test.ts --testNamePattern='C#'`. The test failed with received value `null`. The alias was restored immediately.

### 6. Empty prompt version history uses the draft directly

- Files: `src/admin/reviewCustomizationService.ts`, `src/__tests__/reviewCustomizationService.test.ts`
- GREEN: the direct persisted `versions: []` fixture returns the enabled prompt's draft focus and instructions, retaining `currentVersion`.
- RED evidence (post-hoc controlled mutation): changed the no-version focus fallback to an empty array, then ran `npx jest --runInBand src/__tests__/reviewCustomizationService.test.ts --testNamePattern='falls back to the draft when an enabled published prompt has no versions'`. The test failed because the returned focus was empty. The existing fallback was restored immediately.

### 7. Claude/Codex permissions and sandbox are unchanged

- Files reviewed: complete diff from `da54642`; no Claude/Codex permission or sandbox configuration file changed.
- GREEN: the diff contains only the files listed above and the review/runtime hardening test changes.
- RED evidence: not applicable; intentionally no permission or sandbox mutation was made.

## Verification Results

| Command | Actual result |
| --- | --- |
| `npx jest --coverage --runInBand src/__tests__/gitlabReviewService.test.ts src/__tests__/runtimeConfigExecution.test.ts src/__tests__/reviewCustomizationService.test.ts src/__tests__/reviewLanguages.test.ts` | PASS, 4 suites, 85 tests |
| `npm run type-check` | PASS (`tsc --noEmit`) |
| `git diff --check` | PASS before review and again after this report was added |
| `bash scripts/verify-runtime-image-files.sh` | PASS |
| `bash scripts/verify-deepflow-image-files.sh` | PASS |
| `ENTRYPOINT_TEST_IMAGE=gitlab-claude-webhook:runtime-hardening bash scripts/verify-entrypoint-safety.sh` | PASS on rebuilt base image |
| `docker build --cache-from gitlab-claude-webhook:runtime-hardening -t gitlab-claude-webhook:runtime-hardening .` | PASS; local cache used and application rebuilt |
| `docker build --cache-from gitlab-claude-webhook-deepflow:runtime-hardening -f Dockerfile.deepflow -t gitlab-claude-webhook-deepflow:runtime-hardening .` | PASS; local cache used and application rebuilt |
| `docker run --rm -e DATA_DIR= gitlab-claude-webhook:runtime-hardening true` | Expected rejection: `Refusing unsupported runtime directory configuration` |
| `docker run --rm gitlab-claude-webhook:runtime-hardening sh -c 'test "$(id -u)" = 1001 && test "$(id -g)" = 1001 && id'` | PASS: `uid=1001(claude) gid=1001(claude)` |
| DeepFlow temporary-volume smoke | PASS: UID/GID 1001; `cargo`, `rustc`, `go`, `protoc`, `clang`, and `rg` present; all cache/work mounts writable |

## Concerns

- The Jest command passes, but `ts-jest` emits its existing hybrid Node module-kind warning about `isolatedModules`. It is unrelated to this change and did not affect results.
- RED evidence above was collected after taking over the interrupted work by controlled mutation and immediate restoration. It is evidence that the tests detect the stated regressions, not a claim that the original changes were written test-first.

## Follow-up: Proposal Mutation Concurrency Review

- Review base SHA: `b61c3bb7f49e9814a9f3b50e3b2015aa724d302c`
- Files changed: `src/admin/reviewCustomizationService.ts`, `src/__tests__/reviewCustomizationService.test.ts`
- No Claude/Codex permission, sandbox, Docker, or unrelated module changed.

### Root Cause

`analyzeFeedback`, `applyProposal`, and `dismissProposal` previously read and changed `this.proposals` outside a shared critical section. Deferred `proposalStore.write` calls therefore allowed two callers to create independent snapshots from the same old array. A later completion could overwrite a prior status; an Apply started while Dismiss was waiting could still observe `open`.

### RED

Before the queue implementation, the following command deterministically failed:

```bash
npx jest --runInBand src/__tests__/reviewCustomizationService.test.ts --testNamePattern='serializes concurrent dismissals|serializes a dismiss and apply race'
```

- Concurrent Dismiss test: first proposal returned to `open` after the second deferred write completed from an old snapshot.
- Dismiss/Apply race: both operations fulfilled; Apply did not reject after Dismiss had begun persisting.

### GREEN

The service now uses a private single-process Promise tail for proposal mutations. `analyzeFeedback`, `applyProposal`, and `dismissProposal` enter it before locating and validating proposal state; each writes a complete replacement snapshot and assigns in-memory state only after required writes resolve. The tail converts each operation outcome to `void`, so a rejected write rejects only that caller and cannot poison later work.

The following focused GREEN command passed after correcting an assertion that treated an already-captured `Error` object as a matcher callback:

```bash
npx jest --runInBand src/__tests__/reviewCustomizationService.test.ts --testNamePattern='serializes concurrent dismissals|serializes a dismiss and apply race|keeps a proposal open and retryable when dismissal persistence fails'
```

Results: 3 passed. The existing failed-write/retry case proves the queue continues after a rejected mutation.

### Final Follow-up Verification

| Command | Actual result |
| --- | --- |
| `npx jest --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts` | PASS, 2 suites, 45 tests |
| `npm run type-check` | PASS (`tsc --noEmit`) |
| `git diff --check` | PASS |
| Persistence suite discovery | No separate `reviewCustomizationServicePersistence` test file exists in this repository; coverage is in `reviewCustomizationService.test.ts` and restart assertions. |

### Self-review

- Deadlock: no queued mutation calls another queued public mutation; each critical section waits only for storage operations.
- Error propagation and recovery: callers receive the original store error; `run.then(() => undefined, () => undefined)` restores the queue tail after either outcome.
- State ordering: status is re-read after queue entry; all successful proposal transitions write their full snapshots before updating in-memory proposals. The Dismiss/Apply race test verifies a dismissed proposal cannot be applied or reopened in memory or after restart.

## Follow-up: Recoverable Prompt/Proposal Apply Transaction

### Root Cause

`applyProposal()` updates `review-prompts.json` and `prompt-proposals.json` as one
state transition, but the two `JsonStore` writes have separate atomic rename
boundaries. A process failure or rejected second write could therefore leave a
new Prompt draft with an open or dismissed Proposal. The single-process mutation
queue prevents concurrent lost updates but cannot make two files atomic.

### Implementation

- `prompt-proposal-transaction.json` is a write-ahead log containing the previous
  Prompt and Proposal snapshots for a prepared Apply.
- Apply writes the WAL, writes both next snapshots, then clears the WAL. Clearing
  the WAL is the commit point.
- Initialization and every queued Prompt/Proposal mutation recover a prepared WAL
  before doing new work. Recovery restores both before-images and only then clears
  the WAL, so it is idempotent across repeated process failures.
- Prompt creation, update, publish, rollback, feedback analysis, Apply, and Dismiss
  share one FIFO mutation queue. Public methods re-read state inside the critical
  section and assign memory only after persistence succeeds.
- The admin documentation lists the recovery log as a service-managed file that
  operators must not edit.

### Regression Coverage

- Proposal store failure after the Prompt write restores both files, leaves the
  Proposal open, survives restart, and leaves the queue usable.
- Startup recovers when only the next Prompt snapshot exists and when both next
  snapshots exist but the WAL was not cleared.
- Successful Apply survives restart with an applied Proposal and updated draft,
  and the WAL is null.
- Concurrent Apply followed by Prompt update preserves the committed operation
  order without losing either state.
- A failed Prompt update leaves memory unchanged and a later retry succeeds.

### WAL Verification

| Command | Actual result |
| --- | --- |
| `npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts` | PASS, 1 suite, 25 tests |
| `npm test -- --runInBand src/__tests__/adminRoutes.test.ts` | PASS, 1 suite, 26 tests |
| `npm run type-check` | PASS (`tsc --noEmit`) |
| `npx prettier --check src/admin/reviewCustomizationService.ts src/__tests__/reviewCustomizationService.test.ts docs/admin-console.md docs/admin-console-design.md` | PASS after formatting |

The existing `ts-jest` hybrid module warning remains non-fatal. The management
route test required execution outside the restricted sandbox because Supertest
binds a temporary local listener; it did not start or modify the production
service.
