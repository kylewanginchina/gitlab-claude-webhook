# Prompt, Skill, and Feedback Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build editable Prompt/Skill management and feedback-driven prompt optimization for the existing GitLab Claude Webhook admin console.

**Architecture:** Add a JSON-backed `ReviewCustomizationService`, expose authenticated admin routes, wire review execution to published prompts and enabled skills, then add a React `Review Tuning` page. Keep optimization safe by creating proposals that update drafts only after admin approval.

**Tech Stack:** TypeScript, Express, Jest, React, Vite, existing `JsonStore`.

## Global Constraints

- Store persistent data under `DATA_DIR`.
- Admin API stays under `/api/admin`.
- Admin UI stays under `/admin`.
- No database or queue in this slice.
- Prompt optimization must not auto-publish.
- New review tasks should pick up prompt and skill changes without restart.

---

### Task 1: JSON-Backed Review Customization Service

**Files:**
- Create: `src/admin/reviewCustomizationTypes.ts`
- Create: `src/admin/reviewCustomizationService.ts`
- Create: `src/utils/reviewCustomization.ts`
- Test: `src/__tests__/reviewCustomizationService.test.ts`

**Interfaces:**
- Produces: `ReviewCustomizationService.initialize(): Promise<void>`
- Produces: `listPrompts(): ReviewPrompt[]`
- Produces: `updatePrompt(id: string, patch: ReviewPromptPatch): Promise<ReviewPrompt>`
- Produces: `publishPrompt(id: string, changelog?: string): Promise<ReviewPrompt>`
- Produces: `rollbackPrompt(id: string, version: number, changelog?: string): Promise<ReviewPrompt>`
- Produces: `getPublishedReviewPasses(): PublishedReviewPassTemplate[]`
- Produces: `listSkills(): ReviewSkill[]`
- Produces: `listFeedback(): ReviewFeedback[]`
- Produces: `analyzeFeedback(): Promise<PromptOptimizationProposal[]>`
- Produces: `applyProposal(id: string): Promise<PromptOptimizationProposal>`

- [ ] Write failing Jest tests for default prompt initialization, prompt update/publish/rollback, skill enable/disable, feedback creation, proposal generation, and proposal apply.
- [ ] Run `npm test -- src/__tests__/reviewCustomizationService.test.ts --runInBand` and confirm it fails because the service does not exist.
- [ ] Implement the service with atomic JSON persistence through `JsonStore`.
- [ ] Run the focused Jest test and confirm it passes.

### Task 2: Admin Routes

**Files:**
- Modify: `src/admin/adminRoutes.ts`
- Modify: `src/server/webhookServer.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/adminRoutes.test.ts`
- Test: `src/__tests__/runtimeConfigIntegration.test.ts`

**Interfaces:**
- Consumes: `ReviewCustomizationService`
- Produces: authenticated `/api/admin/prompts`, `/api/admin/skills`, `/api/admin/feedback`, and `/api/admin/prompt-optimizer/*` routes.

- [ ] Add failing route tests for prompt list/update/publish, skill enable/disable, feedback create, proposal analyze/apply, `400` validation errors, and `404` missing IDs.
- [ ] Run focused route tests and confirm they fail.
- [ ] Mount the service in `createAdminRouter()`, initialize it in `src/index.ts`, and pass it through `WebhookServer`.
- [ ] Implement route handlers and error status mapping.
- [ ] Run route and integration tests and confirm they pass.

### Task 3: Review Execution Integration

**Files:**
- Modify: `src/services/gitlabReviewService.ts`
- Test: `src/__tests__/gitlabReviewService.test.ts`

**Interfaces:**
- Consumes: `getPublishedReviewPasses()`
- Consumes: `getMatchingSkills(context, passId, provider)`
- Produces: review pass prompts that include admin draft/published prompt content and matching skill instructions.

- [ ] Add failing tests showing `buildReviewPasses()` uses a custom published prompt and appends matching skill instructions.
- [ ] Run focused review service tests and confirm they fail.
- [ ] Replace the hardcoded pass template source with `ReviewCustomizationService`.
- [ ] Keep existing JSON output rules and scoring prompt behavior unchanged.
- [ ] Run focused review service tests and confirm they pass.

### Task 4: Frontend Review Tuning Page

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/components/Layout.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/index.css`
- Create: `frontend/src/pages/ReviewTuning.tsx`

**Interfaces:**
- Consumes: new admin API routes.
- Produces: `Review Tuning` page with prompt editor, skill editor, feedback form, and proposal list.

- [ ] Add frontend types and API client methods for prompts, skills, feedback, and proposals.
- [ ] Add `Review Tuning` route and sidebar item.
- [ ] Build a dense operational page with selectable prompts, save draft, publish, rollback, skill enable/disable, feedback entry, analyze feedback, and apply proposal controls.
- [ ] Run `npm --prefix frontend run typecheck` and `npm --prefix frontend run build`.

### Task 5: Verification and Deployment

**Files:**
- Modify: `docs/admin-console.md`
- Modify: `docs/CONFIG.md`
- Modify: `README.md`

**Interfaces:**
- Produces: documented `/admin` review tuning usage and JSON store files.

- [ ] Document Prompt/Skill/feedback stores and the safe proposal workflow.
- [ ] Run `npm run build:all`.
- [ ] Run `npm run type-check`.
- [ ] Run `npm test -- --runInBand`.
- [ ] Rebuild and restart Docker only after code verification passes.
- [ ] Verify `http://127.0.0.1:3001/admin` and `/api/admin/prompts` locally.
