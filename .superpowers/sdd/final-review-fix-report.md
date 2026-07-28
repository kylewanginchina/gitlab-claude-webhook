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
