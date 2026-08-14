# Admin Prompt Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-managed prompt catalog for ordinary Claude/Codex execution and review shell prompts while preserving general-purpose ordinary task behavior.

**Architecture:** Extend `ReviewCustomizationService` with a versioned prompt-template store. Executors resolve prompt text through a new template renderer with built-in defaults as fallback. The admin API and React admin UI expose prompt templates and editable skills.

**Tech Stack:** TypeScript, Express, Jest, React, Vite, JSON file stores under `data/`.

## Global Constraints

- Ordinary non-review Claude/Codex requests remain general-purpose agent executions.
- Natural-language merge request review requests remain read-only review mode.
- Draft prompt edits do not affect execution until published.
- Missing prompt catalog data must fall back to built-in defaults.
- Admin changes must affect new tasks without a service restart.

---

### Task 1: Add Prompt Template Domain Model

**Files:**
- Modify: `src/admin/reviewCustomizationTypes.ts`
- Modify: `src/admin/reviewCustomizationService.ts`
- Test: `src/__tests__/reviewCustomizationService.test.ts`

**Interfaces:**
- Produces: `PromptTemplate`, `PromptTemplatePatch`, `PublishedPromptTemplate`, `getPromptTemplate(id)`, `listPromptTemplates()`, `updatePromptTemplate(id, patch)`, `publishPromptTemplate(id, changelog)`, `rollbackPromptTemplate(id, version, changelog)`, `renderPromptTemplate(id, variables, fallback)`.

- [ ] Write failing tests for default prompt template initialization and publish/rollback.
- [ ] Run `npm test -- src/__tests__/reviewCustomizationService.test.ts --runInBand` and confirm the new tests fail.
- [ ] Implement prompt template types, defaults, JSON storage, validation, and render helper.
- [ ] Run `npm test -- src/__tests__/reviewCustomizationService.test.ts --runInBand` and confirm pass.

### Task 2: Expose Prompt Templates Through Admin API

**Files:**
- Modify: `src/admin/adminRoutes.ts`
- Modify: `src/__tests__/adminRoutes.test.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Produces routes: `GET /api/admin/prompt-templates`, `GET /api/admin/prompt-templates/:id`, `PUT /api/admin/prompt-templates/:id`, `POST /api/admin/prompt-templates/:id/publish`, `POST /api/admin/prompt-templates/:id/rollback`.

- [ ] Write failing admin route tests for listing and updating prompt templates.
- [ ] Run `npm test -- src/__tests__/adminRoutes.test.ts --runInBand` and confirm fail.
- [ ] Implement API routes and validation error handling.
- [ ] Add frontend TypeScript types and API methods.
- [ ] Run `npm test -- src/__tests__/adminRoutes.test.ts --runInBand` and confirm pass.

### Task 3: Use Prompt Templates In Executors

**Files:**
- Modify: `src/services/streamingClaudeExecutor.ts`
- Modify: `src/services/codexExecutor.ts`
- Modify: `src/services/gitlabReviewService.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`
- Test: `src/__tests__/gitlabReviewService.test.ts`

**Interfaces:**
- Consumes: `reviewCustomizationService.renderPromptTemplate(id, variables, fallback)`.
- Produces: runtime prompt resolution for Claude, Codex, review pass shell, and scoring shell.

- [ ] Write failing tests showing Claude edit prompts include a published `claude.edit.system` override.
- [ ] Write failing tests showing Codex edit prompts include a published `codex.edit.instructions` override.
- [ ] Write failing tests showing review scoring can use a published `review.scoring.template` override.
- [ ] Run targeted tests and confirm fail.
- [ ] Replace hardcoded executor prompt strings with template rendering while keeping exact current defaults.
- [ ] Run targeted tests and confirm pass.

### Task 4: Update Admin UI

**Files:**
- Modify: `frontend/src/pages/ReviewTuning.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: frontend prompt template API methods.
- Produces: visible/editable prompt template section and editable skill rows.

- [ ] Add prompt-template list and editor state.
- [ ] Load prompt templates together with prompts, skills, feedback, and proposals.
- [ ] Add save draft, publish, and rollback actions.
- [ ] Add edit controls for existing skills.
- [ ] Run `npm --prefix frontend run build` and confirm pass.

### Task 5: Verification And Deployment

**Files:**
- Modify only if verification reveals defects.

- [ ] Run `npm run type-check`.
- [ ] Run `npm test -- --runInBand`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Commit the implementation.
- [ ] Build `gitlab-claude-webhook-deepflow:latest`.
- [ ] Recreate `gitlab-claude-webhook` on port `3001`.
- [ ] Verify `curl -fsS http://127.0.0.1:3001/health` returns healthy.
