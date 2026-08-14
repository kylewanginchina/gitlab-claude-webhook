# Runtime Credential Isolation Design

## Goal

Make Claude and Codex credentials saved in the admin console authoritative for new tasks without mutating `process.env`, restarting the container, interrupting active tasks, or leaking credentials between concurrent tasks.

## Architecture

The service captures a credential-free base child-process environment once at startup. Each execution reads one immutable runtime configuration snapshot and overlays only that provider's current credentials and endpoint onto the cached base environment.

Claude receives only `ANTHROPIC_AUTH_TOKEN`; inherited `ANTHROPIC_API_KEY` and OAuth credentials are absent. Codex receives the same current key in both `OPENAI_API_KEY` and `CODEX_API_KEY`, and its per-execution provider configuration explicitly selects `OPENAI_API_KEY`. This accommodates the Codex SDK injection path and the configured custom provider without allowing a stale environment key to win.

## Configuration Flow

1. The admin API validates and persists the patch.
2. `RuntimeConfigService` atomically replaces its in-memory configuration.
3. Running tasks keep their existing configuration and credential snapshot.
4. A new task reads the latest runtime configuration exactly once.
5. The executor creates its child SDK process with the cached clean environment plus that snapshot.

No credential update triggers a container restart. Existing restart-required behavior remains limited to process-level settings such as the listening port and work directory.

## Cache Behavior

Rebuilding a local environment object does not alter the credential value, account, model, or request prefix, so it does not invalidate provider-side prompt caches. A real credential change may select another account or project and therefore another cache namespace regardless of whether the service restarts.

## Safety

- Never mutate global `process.env` after startup.
- Never log credential values or fingerprints.
- Strip inherited Claude, OpenAI, and Codex authentication variables from the base child environment.
- Keep credential snapshots task-local so concurrent tasks cannot overwrite one another.
- Preserve unrelated environment variables required by tools and child processes.

## Verification

Automated tests must prove that:

- A stale inherited Claude token cannot coexist with or override the runtime Claude token.
- A stale inherited OpenAI/Codex key cannot override the runtime Codex key.
- Codex receives an explicit runtime provider definition whose `env_key` resolves to the current runtime key.
- A Claude fallback remains on the task's initial credential snapshot after an admin update.
- A task already in progress keeps its initial snapshot while the next task uses the updated configuration.
- Existing runtime model, endpoint, reasoning, timeout, and prompt behavior still passes.
