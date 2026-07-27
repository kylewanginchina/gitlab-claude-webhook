# Prompt, Skill, and Feedback Tuning Design

## Goal

Add the next admin-console slice: editable review prompts, configurable review skills, feedback capture, and safe prompt optimization proposals.

## Scope

This slice uses local JSON persistence under `DATA_DIR`, matching the existing runtime config model. It does not introduce a database, queue, scheduled job runner, or automatic prompt deployment.

## Backend Design

- Add `ReviewCustomizationService` backed by JSON stores:
  - `review-prompts.json`
  - `review-skills.json`
  - `review-feedback.json`
  - `prompt-proposals.json`
- Initialize prompt defaults from the current four hardcoded review passes.
- Keep a draft and version history for every prompt.
- Publishing a prompt creates a new immutable version.
- Rolling back creates a new version copied from an earlier version.
- Skills are enabled/disabled instruction bundles that can target providers, changed file globs, and prompt IDs. Language hints are stored as metadata but do not participate in matching.
- Feedback records are admin-entered first. GitLab-derived feedback can be added later without changing the API shape.
- Optimization proposals are deterministic and reviewable. The service analyzes feedback labels and notes, then writes proposals that update prompt drafts only when an admin applies them.

## API Design

All routes are under existing authenticated `/api/admin`.

- `GET /prompts`
- `POST /prompts`
- `GET /prompts/:id`
- `PUT /prompts/:id`
- `POST /prompts/:id/publish`
- `POST /prompts/:id/rollback`
- `POST /prompts/render`
- `GET /skills`
- `POST /skills`
- `PUT /skills/:id`
- `POST /skills/:id/enable`
- `POST /skills/:id/disable`
- `GET /feedback`
- `POST /feedback`
- `GET /prompt-optimizer/proposals`
- `POST /prompt-optimizer/analyze`
- `POST /prompt-optimizer/proposals/:id/apply`

## Review Execution Design

`GitLabReviewService.buildReviewPasses()` reads published prompt versions from `ReviewCustomizationService`. Enabled matching skills are appended to the prompt text as admin skill instructions. Runtime changes become effective for new review tasks without restarting the process.

## Frontend Design

Add a `Review Tuning` admin page using the current sidebar layout. It includes:

- Prompt list and editor.
- Draft focus lines and system instruction editing.
- Publish and rollback controls.
- Skill list and editor.
- Feedback entry form.
- Optimization proposal list with apply action.

The UI remains dense and operational rather than landing-page-like.

## Safety

- Admin auth remains `X-Admin-Key`.
- Optimization never auto-publishes.
- Invalid payloads return `400`.
- Unknown prompt, skill, feedback, or proposal IDs return `404`.
- JSON files are atomically written by the existing `JsonStore`.

## Verification

- Backend Jest tests cover defaults, prompt publishing, rollback, skills, feedback, optimizer proposals, admin routes, and review prompt rendering.
- Frontend TypeScript and Vite build verify the management page compiles.
- Docker build remains the deployment verification.
