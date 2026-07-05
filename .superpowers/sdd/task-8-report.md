# Task 8 Report: Manual Verification And Release Notes

## Summary

Task 8 completed on branch `codex/admin-console-runtime-config` from base commit `fdef0df`.

Delivered:

- New operator guide at `docs/admin-console.md`
- New `README.md` Configuration subsection linking the admin console guide
- Full verification run
- Local smoke test against the built app on port `3099`
- Commit with the required message

## Files Changed

- `docs/admin-console.md` (new)
- `README.md`

Unrelated untracked files were left untouched:

- `docker-compose.yml.bak`
- `docs/admin-console-design.md`
- `docs/superpowers/`

Generated smoke-test output `data/runtime-config.json` was removed before commit so the change set stayed scoped to the task.

## Documentation Notes

The operator guide was adapted to match the implemented behavior instead of copying the brief verbatim where the code differs:

- Admin key is stored by the frontend in browser local storage and sent as `X-Admin-Key`
- Admin API fail-closed behavior is HTTP `503` when `ADMIN_TOKEN` is missing
- Restart-required fields currently implemented are `webhook.port` and `workDir`
- Public config responses expose secrets only as `{ configured, masked }`
- Prompt management, skill management, and CodeRabbit integration are explicitly noted as not part of the current UI

## Commands Run And Results

### Build

Command:

```bash
npm run build:all
```

Result:

- Passed
- TypeScript backend build succeeded
- Admin frontend Vite build succeeded
- Output written under `dist/public/admin`

### Type Check

Command:

```bash
npm run type-check
```

Result:

- Passed

### Tests

Command:

```bash
npm test
```

Result:

- Passed
- 9 test suites passed
- 72 tests passed

## Smoke Test

### Server Start

Command:

```bash
ADMIN_TOKEN=local-admin \
GITLAB_TOKEN=glpat-test \
WEBHOOK_SECRET=webhook-test \
ANTHROPIC_AUTH_TOKEN=anthropic-test \
PORT=3099 \
npm start
```

Result:

- Server started successfully on port `3099`

### Endpoint Checks

Commands:

```bash
curl -fsS http://127.0.0.1:3099/health
curl -fsS -H 'X-Admin-Key: local-admin' http://127.0.0.1:3099/api/admin/status
curl -fsS -H 'X-Admin-Key: local-admin' http://127.0.0.1:3099/api/admin/config
```

Results summary:

- `/health` returned JSON including `"status":"healthy"`
- `/api/admin/status` returned JSON including `"status":"ok"` and `"configLoaded":true`
- `/api/admin/config` returned masked secret objects for:
  - `claude.authToken`
  - `codex.apiKey`
  - `gitlab.token`
  - `webhook.secret`
- Verified the `/api/admin/config` response did **not** include raw test secrets:
  - `glpat-test`
  - `webhook-test`
  - `anthropic-test`

Observed masking examples from the response:

- GitLab token: `********test`
- Webhook secret: `********test`
- Claude token: `**********test`

### Server Stop

Action:

- Sent `SIGINT` to the local server after smoke verification

Result:

- Server shut down cleanly

## Commit

Created commit with the required message:

```bash
docs(admin): document admin console runtime config
```

## Self-Review

- The new guide is English, per the task requirement, and focused on operator-facing behavior.
- The README change is scoped under the existing `Configuration` section and links to the new guide.
- Documentation wording reflects the implemented routes and UI text rather than planned-but-unshipped behavior.
- The change set does not include prompt/skill management or CodeRabbit documentation.
- No unrelated user changes were reverted or overwritten.

## Concerns

None.

## Fix Follow-Up

Updated `docs/admin-console.md` to clarify that `${DATA_DIR}/runtime-config.json` overrides environment variables and code defaults after first startup, while first boot initializes the file from current env/defaults. Expanded the restart-required section to include Docker volume and Docker network settings that live outside the current admin UI and require restart or redeploy when changed. Clarified the manual checklist so restart-required feedback can be checked either in the UI save message or in the `PUT /api/admin/config` response.

Commands run:

```bash
rg -n "restart|required|runtime config|webhook\\.port|workDir|Docker volume|Docker network|manual checklist|save message|API response" docs/admin-console.md
rg -n "runtime|restart|required|Docker volume|Docker network|requiresRestart" docs/admin-console.md
```
