# Codex SDK 0.147.0 Upgrade Design

## Problem

`@codex review` fails before the agent starts with:

```text
invalid_request_error - The 'gpt-5.6-sol' model requires a newer version of Codex.
```

The production evidence for the failed request is:

- The running webhook image contains `@openai/codex-sdk` and `@openai/codex` `0.143.0`.
- Codex2API recorded both the downstream and upstream User-Agent as
  `codex_sdk_ts/0.143.0 ... (codex_exec; 0.143.0)`.
- The upstream returned HTTP 400 for that request.
- Requests using Codex `0.147.0` succeeded in the same time window.
- The current stable npm release of both packages is `0.147.0`.

This is a real client-version incompatibility. It is not a Claude SDK error, a
timeout, or a connection failure between the webhook and Codex2API.

## Considered Approaches

### 1. Upgrade the webhook SDK and bundled CLI (recommended)

Upgrade `@openai/codex-sdk` to stable `0.147.0`; its exact dependency upgrades
the bundled `@openai/codex` CLI to the same version. This changes the actual
client implementation and the version reported upstream.

The public TypeScript API diff from `0.143.0` to `0.147.0` is backward
compatible for this project. It only adds `usage.cache_write_input_tokens`,
which the current executor does not need to consume.

### 2. Raise Codex2API's minimum client version

Codex2API could rewrite the old client's User-Agent and `Version` header to
`0.147.0`. This is useful as a temporary compatibility policy, but it leaves the
actual CLI at `0.143.0`. A future model may require request behavior or protocol
fields that cannot be supplied by changing headers, so this does not fix the
source of the incompatibility.

### 3. Map `gpt-5.6-sol` to an older model

This avoids the version check but silently changes the requested model and its
behavior. It is not an acceptable default repair.

## Scope

The implementation will:

1. Update `@openai/codex-sdk` to stable `0.147.0` in `package.json`.
2. Regenerate only the npm lockfile entries required for the SDK and bundled
   platform-specific Codex CLI packages.
3. Keep `src/services/codexExecutor.ts` unchanged unless type checking proves a
   compatibility change is required.
4. Verify the application and a newly built image without making a real model
   request.

The implementation will not:

- Change Codex2API runtime settings or source code.
- Modify `/root/.codex/config.toml` or any host Codex credentials.
- Change file ownership or permissions.
- Restart or replace the production webhook container.
- Trigger a real GitLab review or another paid model request.
- Modify or discard unrelated uncommitted work already in the checkout.

## Data Flow After Upgrade

The existing flow remains unchanged:

```text
GitLab webhook
  -> CodexExecutor
  -> @openai/codex-sdk 0.147.0
  -> bundled codex-cli 0.147.0
  -> HTTPS /v1/responses on Codex2API
  -> upstream model
```

Codex2API remains in `auto` compatibility mode. Because the real client is now
`0.147.0`, it can preserve the client User-Agent without causing the model's
minimum-version check to fail.

## Error Handling

No runtime fallback will disguise this error. If a future model raises the
minimum Codex version again, the webhook will continue to report the upstream
error accurately. Operational verification must therefore include the SDK and
CLI versions embedded in each candidate image before deployment.

## Verification

The candidate change is acceptable only when all of the following pass:

1. `npm ls @openai/codex-sdk @openai/codex` resolves both to `0.147.0` without
   invalid or duplicate versions.
2. The existing TypeScript type check, build, and focused Codex executor tests
   pass.
3. The broader unit test suite passes, or any unrelated pre-existing failures
   are identified with evidence.
4. A newly built DeepFlow image reports SDK `0.147.0` and
   `codex-cli 0.147.0` from inside the container.
5. The image can run its normal startup/health check in an isolated test
   container without replacing production.

After these checks, production deployment remains a separate, explicit user
approval step.
