# Admin Prompt Catalog Design

## Goal

Expose every critical execution prompt used by `gitlab-claude-webhook` in `/admin`, allow draft editing, publishing, and rollback, and keep ordinary Claude/Codex requests on the current general-purpose agent path.

## Current State

Ordinary requests already use general-purpose execution:

- Claude edit mode runs the Claude Agent SDK with the `claude_code` preset tools and an edit-mode system prompt.
- Codex edit mode runs with `danger-full-access` and `approvalPolicy: never`.
- Natural-language merge request review requests are now classified as read-only review mode.
- `/code-review` uses a separate multipass review pipeline with admin-managed review prompts and skills.

The gap is visibility and configurability. Claude/Codex edit/review wrappers, MR context text, static review fallback text, and review scoring/pass shell prompts are still hardcoded in executors/services.

## Architecture

Add an admin-managed prompt catalog alongside the existing review prompt and skill stores. The catalog stores versioned prompt templates keyed by stable IDs such as `claude.edit.system`, `codex.edit.instructions`, and `review.scoring.template`. Execution code resolves templates at runtime with built-in defaults as fallback, so malformed or missing persisted data cannot stop task processing.

Existing review prompt and skill management remains compatible. The `/admin` UI is expanded so operators can see and edit both the prompt catalog and the current review prompts/skills from one tuning surface.

## Prompt Catalog

Default templates:

- `claude.edit.system`: Claude Agent SDK system prompt append for ordinary edit tasks.
- `claude.review.system`: Claude Agent SDK system prompt append for read-only review tasks.
- `claude.context.wrapper`: Context, MR analysis, execution mode, and request wrapper for Claude.
- `claude.review.fallback`: Static review fallback request after validation commands fail.
- `codex.edit.instructions`: Codex ordinary edit-mode instruction block.
- `codex.review.instructions`: Codex read-only review instruction block.
- `codex.context.wrapper`: Context, MR analysis, instruction block, and request wrapper for Codex.
- `review.pass.template`: Multipass review prompt shell used around each published review pass.
- `review.scoring.template`: Multipass review scoring prompt shell.

Templates use simple `{{token}}` replacement. Unknown tokens are left intact, making draft editing recoverable.

## Runtime Behavior

Ordinary requests must stay general-purpose. Admin prompt customization changes wording and constraints, but does not switch ordinary requests into review mode or remove agent capabilities by itself. Claude tool selection remains controlled by `context.mode`: edit mode uses `claude_code`, review mode uses read-only tools.

New task executions read the latest published prompt template versions. Draft edits do not affect execution until published.

## Admin UX

`/admin` should display prompt templates with provider and scope labels, current version, enabled state, draft body, publish note, version rollback, and the built-in/default text as reference. Review skills should be editable, not only creatable and toggleable.

## Error Handling

If the prompt catalog service is not initialized, a template ID is missing, or a published version is invalid, execution falls back to the built-in default template and logs a warning. Admin API validation returns `400` for malformed template payloads and `404` for missing template IDs.

## Testing

Tests must verify:

- Prompt catalog defaults initialize and can be updated/published/rolled back.
- Admin routes list and update prompt templates.
- Claude and Codex executors use published admin templates for ordinary edit requests.
- Existing review prompt/skill behavior remains compatible.
- Missing/unloaded prompt catalog falls back to defaults.
