# Claude Session Cache Implementation Plan

> **For agentic workers:** Execute this approved, single-task fix inline with test-driven-development and verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Claude SDK query a stable gateway session header so successive model requests can reuse the same prompt-cache partition.

**Architecture:** Generate a fresh UUID when `runClaudeWithSDK` starts. Pass it to both the SDK's `sessionId` option and `createClaudeExecutionEnvironment`, which merges a `Session-Id` header into `ANTHROPIC_CUSTOM_HEADERS`. The environment belongs to one query and is reused for all its turns; concurrent queries and review passes receive different IDs.

**Tech Stack:** TypeScript, Node.js `crypto.randomUUID`, Claude Agent SDK, Jest.

## Global Constraints

- Change gitlab-claude-webhook only; the user approved the webhook-side adapter.
- Preserve existing custom headers except case-insensitive `Session-Id` entries, which must use the new query's ID.
- Preserve provider credential isolation and runtime configuration behavior.
- Do not modify production runtime configuration or interrupt running webhook tasks.
- Verify actual SDK headers against a local mock endpoint without paid API calls.

---

### Task 1: Bind each Claude query to one gateway session

**Files:**

- Modify: `src/services/streamingClaudeExecutor.ts`
- Modify: `src/utils/providerEnvironment.ts`
- Test: `src/__tests__/providerEnvironment.test.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`
- Document: `README.md`

**Interfaces:**

- `createClaudeExecutionEnvironment(authToken: string, baseUrl: string, sessionId: string): Record<string, string>` returns a fresh environment with the query's `Session-Id` in `ANTHROPIC_CUSTOM_HEADERS`.
- `runClaudeWithSDK` generates `sessionId` once with `randomUUID()` and passes the same value to the environment builder and `query({ options: { sessionId } })`.

- [x] Add regression tests for a generated UUID in SDK options, an identical `Session-Id` header, distinct IDs across concurrent queries, preservation of unrelated custom headers, replacement of inherited session headers regardless of case, and no mutation of the cached base environment.
- [x] Run the focused tests with `--testNamePattern=binds` and verify that all four new assertions fail because session binding is missing.
- [x] Implement the environment merge: split inherited `ANTHROPIC_CUSTOM_HEADERS` on `/\r?\n/`, remove empty lines and lines whose name before the first colon trims and lowercases to `session-id`, then append `Session-Id: ${sessionId}` and join with `\n`.
- [x] Import `randomUUID` from `crypto` in the Claude executor, generate one ID per `runClaudeWithSDK` invocation, and use it for both the environment builder's third argument and the SDK's `sessionId` option.
- [x] Document the automatic per-query header and its lifecycle in the README.
- [x] Re-run the focused regression tests, then run `npm test -- --runInBand --silent`, `npm run type-check`, `npm run lint`, and the formatter check for changed TypeScript files.
- [x] Exercise two turns and two independent queries through the real installed SDK and a local Anthropic SSE mock. Confirm stable IDs within a query, different IDs between queries, agreement with `X-Claude-Code-Session-Id` and metadata, and preserved unrelated custom headers.
- [x] Review the final diff, verify a clean whitespace check, and report the change and verification results without claiming production cache improvement before deployment.

## Verification Results

- Baseline: 48 tests passed across the two affected suites.
- Red phase: all four new regressions failed for missing session binding.
- Green phase: 52 tests passed across the two affected suites.
- Full suite: 16 suites and 243 tests passed.
- Type check and server build passed.
- Lint: 0 errors; 272 existing warnings. Changed TypeScript files passed Prettier.
- The changed compiled executor and environment builder were loaded into a separate diagnostic process using the installed SDK 0.3.204. Two concurrent queries each made two requests to a local SSE mock. Each query retained one distinct `Session-Id`, matching its SDK-specific header and metadata; an unrelated custom header was preserved. No upstream model calls were made.
- Independent read-only review found no blocking or actionable correctness issues.
- Built and deployed the DeepFlow production image on 2026-10-26 at 16:51 (Asia/Shanghai): `gitlab-claude-webhook-deepflow:session-cache-20261026-164219`, image `sha256:2527a513162533c1b72229ad2ba0a93d1a52dcdd54d34fd42d23d901240d49df`.
- Waited for all running webhook tasks to finish before recreating the container. Preserved the running environment, six persisted JSON data files, published port 3001, and work/cache volumes.
- Production verification: expected image and source hashes matched, Docker health was healthy with zero restarts, `/health`, authenticated `/api/admin/status`, `/admin`, and its JavaScript asset returned 200. Runtime configuration loaded successfully; startup logs contained no errors.
- Retained `gitlab-claude-webhook-deepflow:rollback-session-cache-20261026-164219` for rollback. Removed the isolated staging container and copied staging/build data after validation.
- The fix applies to new Claude queries. Actual upstream cache-hit improvement has not yet been measured against production traffic.
