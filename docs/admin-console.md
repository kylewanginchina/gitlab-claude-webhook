# Admin Console

The admin console is available at `/admin`.

It provides two operator views:

- `Dashboard` for service status, current runtime defaults, and masked secret status
- `Settings` for editing runtime configuration used by new tasks

## Authentication

Set `ADMIN_TOKEN` to a long random value before exposing the admin console outside local development.

The browser stores the value you enter in local storage and sends it as `X-Admin-Key` on requests to `/api/admin/*`.

If `ADMIN_TOKEN` is not configured, the admin API fails closed with HTTP `503`.

## Runtime Configuration

The service stores runtime configuration in `${DATA_DIR}/runtime-config.json`.

On first startup, if that file does not exist, the service creates it from the current environment variables and defaults. After that, the persisted admin runtime config in `${DATA_DIR}/runtime-config.json` becomes the source of truth and overrides environment variables and code defaults on later starts, while updates made in the admin console are written back to the same file.

The current implementation hot-applies these settings to new tasks immediately after save:

- Default AI provider
- Claude base URL, token, default model, and default timeout
- Codex base URL, API key, default model, reasoning effort, and default timeout
- GitLab base URL and token
- Webhook secret
- Review enabled state
- Review provider
- Review confidence threshold
- Review candidate and final finding caps
- Review pass and scoring concurrency
- Review skip flags
- Review allowed commands
- Log level

The current implementation reports these changes as restart-required:

- `webhook.port`
- `workDir`
- Docker volume settings and Docker network settings that are managed in deployment or compose configuration outside the current admin UI

Changing those deployment-level settings requires a service or container restart, or a redeploy of the stack.

When a save does not require restart, the UI reports:

`Saved. Hot-applied fields are active for new tasks immediately.`

When a save changes a restart-required field, the UI reports the exact fields that require restart, and the same `requiresRestart` detail is also returned by the `PUT /api/admin/config` response.

## Operator Notes

- `GET /api/admin/status` returns service uptime, version, timestamp, and whether runtime config loaded successfully.
- `GET /api/admin/config` returns the public runtime configuration with secrets exposed only as `{ configured, masked }`.
- `PUT /api/admin/config` updates runtime configuration and returns `requiresRestart` for fields that need a process restart.
- `POST /api/admin/test/gitlab`, `POST /api/admin/test/claude`, and `POST /api/admin/test/codex` report whether the backend currently considers the relevant secret configured.
- The current admin UI does not expose prompt management, skill management, or CodeRabbit integration.

## Manual Test Checklist

1. Open `/health` and verify the JSON response includes `"status":"healthy"`.
2. Open `/admin` and enter the value from `ADMIN_TOKEN`.
3. Confirm the dashboard loads current status and only masked secret values are shown.
4. Open `Settings` and change the Claude default model to a test value.
5. Save settings and verify the success message says hot-applied fields are active for new tasks immediately.
6. Refresh the page and verify the Claude model value persists.
7. Run `Test GitLab` and verify the result reports either configured or missing token status.
8. Run `Test Claude` and `Test Codex` and verify each result reflects whether its secret is configured.
9. Change the webhook port and save. Verify the UI save message or the API response reports `webhook.port` under `requiresRestart`.
10. Change `workDir` and save. Verify the UI save message or the API response reports `workDir` under `requiresRestart`.
