# Runtime Credential Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure admin-configured Claude and Codex credentials are authoritative for every new task without global environment mutation or container restarts.

**Architecture:** Add a provider environment factory that captures a credential-free base environment once and returns task-local credential overlays. Pass those environments and an explicit runtime Codex provider definition into each SDK execution.

**Tech Stack:** TypeScript, Jest, Anthropic Claude Agent SDK, OpenAI Codex SDK

## Global Constraints

- Do not mutate `process.env`.
- Do not log secrets or secret fingerprints.
- Running tasks retain their starting credential snapshot; new tasks use the latest runtime configuration.
- Credential changes must not require a container restart.

---

### Task 1: Reproduce stale credential precedence

**Files:**
- Create: `src/__tests__/providerEnvironment.test.ts`
- Modify: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**
- Consumes: `StreamingClaudeExecutor.executeWithStreaming()` and `CodexExecutor.executeWithStreaming()`
- Produces: Regression expectations for task-local Claude and Codex SDK environments

- [x] **Step 1: Strengthen the Claude execution test**

Set stale `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` values in `process.env`, run an execution with a different runtime token, and assert:

```typescript
expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe('anthropic-runtime-token');
expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
```

- [x] **Step 2: Strengthen the Codex execution test**

Set stale `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` values, then assert the Codex constructor receives:

```typescript
expect.objectContaining({
  env: expect.objectContaining({
    OPENAI_API_KEY: 'openai-runtime-key',
    CODEX_API_KEY: 'openai-runtime-key',
  }),
  config: {
    model_provider: 'gitlab_webhook_runtime',
    model_providers: {
      gitlab_webhook_runtime: {
        name: 'gitlab_webhook_runtime',
        base_url: 'https://codex.runtime.example/v1',
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
      },
    },
  },
})
```

Also assert `CODEX_ACCESS_TOKEN` is absent.

- [x] **Step 3: Add deterministic startup sanitization coverage**

Call `sanitizeProviderEnvironment()` with a synthetic startup environment containing all supported stale provider credential and endpoint variables. Assert only unrelated variables such as `PATH` and `HOME` remain.

- [x] **Step 4: Add task snapshot and rotation coverage**

Simulate an admin update during a Claude fallback and during the Codex initial progress callback. Assert the active task keeps its starting snapshot and the next Codex task uses the updated configuration.

- [x] **Step 5: Run the focused tests and verify failure**

Run:

```bash
npx jest src/__tests__/runtimeConfigExecution.test.ts --runInBand
```

Expected: FAIL because Claude keeps inherited credentials and Codex does not receive an isolated environment or explicit runtime provider.

### Task 2: Add task-local provider environments

**Files:**
- Create: `src/utils/providerEnvironment.ts`
- Modify: `src/services/streamingClaudeExecutor.ts`
- Modify: `src/services/codexExecutor.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**
- Produces: `sanitizeProviderEnvironment(environment: NodeJS.ProcessEnv): Record<string, string>`
- Produces: `createClaudeExecutionEnvironment(authToken: string, baseUrl: string): Record<string, string>`
- Produces: `createCodexExecutionEnvironment(apiKey: string): Record<string, string>`
- Consumes: Runtime configuration snapshots read at task start

- [x] **Step 1: Implement the cached credential-free environment**

Create a module-level frozen base environment by copying defined `process.env` entries except:

```typescript
[
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
]
```

Return a new overlay object per task so concurrent executions never share mutable credential state.

- [x] **Step 2: Use the factory in the Claude executor**

Replace the direct `process.env` spread with:

```typescript
const env = createClaudeExecutionEnvironment(
  runtimeConfig.claude.authToken,
  runtimeConfig.claude.baseUrl
);
```

The result must set `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, without setting `ANTHROPIC_API_KEY`.

- [x] **Step 3: Use the factory and explicit provider in the Codex executor**

Construct Codex with:

```typescript
{
  apiKey: runtimeConfig.codex.apiKey,
  baseUrl: runtimeConfig.codex.baseUrl,
  env: createCodexExecutionEnvironment(runtimeConfig.codex.apiKey),
  config: {
    model_provider: 'gitlab_webhook_runtime',
    model_providers: {
      gitlab_webhook_runtime: {
        name: 'gitlab_webhook_runtime',
        base_url: runtimeConfig.codex.baseUrl,
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
      },
    },
  },
}
```

- [x] **Step 4: Capture one runtime configuration snapshot per task**

Read `RuntimeConfigService.getConfig()` at the start of each executor's public entry point. Pass that immutable snapshot through the Claude fallback path and into the Codex SDK call so an in-flight task never mixes configuration revisions.

- [x] **Step 5: Run focused tests**

Run:

```bash
npx jest src/__tests__/runtimeConfigExecution.test.ts --runInBand
```

Expected: PASS.

- [x] **Step 6: Run repository verification**

Run:

```bash
npm run type-check
npm test -- --runInBand
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-07-24-runtime-credential-isolation-design.md \
  docs/superpowers/plans/2026-07-24-runtime-credential-isolation.md \
  src/utils/providerEnvironment.ts \
  src/services/streamingClaudeExecutor.ts \
  src/services/codexExecutor.ts \
  src/__tests__/providerEnvironment.test.ts \
  src/__tests__/runtimeConfigExecution.test.ts
git commit -m "fix: isolate runtime provider credentials"
```
