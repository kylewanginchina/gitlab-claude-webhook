# Task 6 Report: Proposal Dismiss

## Commit

- SHA: `368ea315ad05feadf98402250f235a94de24d64c`
- Base: `bbc109f`
- Commit message: `feat: dismiss prompt optimization proposals`

## RED

Added service and route tests before production changes, then ran:

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts
```

Result: failed as expected. The service test reported missing `dismissProposal`; the route test received `404 Not Found` for the missing dismiss endpoint.

## GREEN and Frontend Checks

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Result: 40 focused backend tests passed; frontend typecheck and Vite production build passed. Jest emitted the existing ts-jest hybrid-module `isolatedModules` warning.

## Visual Verification

Started the brief's local app configuration on port 3101 with `DATA_DIR=/tmp/gitlab-claude-webhook-plan-admin`, created feedback and analyzed it into one proposal, then used Chromium DevTools Protocol with `gitlab_claude_admin_key=test`.

- Desktop open state: `/tmp/task6-dismiss-desktop-open.png`
- Desktop dismissed state: `/tmp/task6-dismiss-desktop-dismissed.png`
- Mobile dismissed state: `/tmp/task6-dismiss-mobile-dismissed.png`

At 1440x900, Apply occupied x=1237.06-1327 and Dismiss x=1335-1371 within the proposal row x=861.5-1384. At 390x844, Apply occupied x=210.06-300 and Dismiss x=308-344 within the row x=33-357. The controls did not overlap. Clicking Dismiss changed the status from `open` to `dismissed`; both controls reported `disabled=true` afterward in both viewports.

## Files

- `src/admin/reviewCustomizationTypes.ts`
- `src/admin/reviewCustomizationService.ts`
- `src/admin/adminRoutes.ts`
- `src/__tests__/reviewCustomizationService.test.ts`
- `src/__tests__/adminRoutes.test.ts`
- `frontend/src/types.ts`
- `frontend/src/api.ts`
- `frontend/src/pages/ReviewTuning.tsx`
- `frontend/src/index.css`

## Self-Review

- Dismiss only transitions `open` proposals, persists the change, and returns a clone.
- A dismissed proposal cannot be applied or dismissed again; the service and route tests cover the error contract.
- Dismiss never writes the prompt store, and the service test confirms the draft remains different from the suggested draft.
- Frontend types and API match the backend contract. The UI uses existing dark-page styles, keeps actions sibling controls, and disables both when the status is no longer open.
- `git diff --check` passed before commit.

## Concerns

- No feature-specific concerns. The focused Jest run retains an existing ts-jest `isolatedModules` configuration warning.

## Review Follow-up

### Persistence Regression Coverage

Added `persists a dismissed proposal across service restarts` in `src/__tests__/reviewCustomizationService.test.ts`. It creates and dismisses a proposal, initializes a second `ReviewCustomizationService` with the same `dataDir`, and asserts that the proposal ID remains `dismissed` with the exact original `dismissedAt` value.

Mutation verification was performed by temporarily removing `await this.proposalStore.write(this.proposals)` from `dismissProposal` and running:

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts -t "persists a dismissed proposal across service restarts"
```

Result: failed as required. After restart, the persisted proposal was `status: "open"` and lacked `dismissedAt`. The write was restored before the final validation.

### Final Commands

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Result: 41 focused backend tests passed; frontend typecheck and Vite production build passed. The existing ts-jest hybrid-module `isolatedModules` warning remains.

### Disabled-State Visual Verification

Chromium DevTools Protocol created and dismissed a fresh proposal after the production build, then captured:

- Desktop 1440x900: `/tmp/task6-review-desktop-dismissed-disabled.png`
- Mobile 390x844: `/tmp/task6-review-mobile-dismissed-disabled.png`

At desktop, Apply was x=1237.06-1327 and Dismiss x=1335-1371 within the row x=861.5-1384. At mobile, Apply was x=210.06-300 and Dismiss x=308-344 within the row x=33-357. Neither action overflowed or overlapped. Both buttons had `disabled=true`, `cursor: not-allowed`, and `opacity: 0.6` after dismissal in both viewports.
