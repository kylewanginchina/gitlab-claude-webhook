# Task 1 Report: Add RunQueue

## Summary
Implemented a standalone `RunQueue` for GitLab webhook processing in `src/services/runQueue.ts` and added focused tests in `src/__tests__/runQueue.test.ts`.

## TDD Evidence

### RED
Command:
```bash
npm test -- src/__tests__/runQueue.test.ts
```

Observed failure:
```text
FAIL src/__tests__/runQueue.test.ts
  ● Test suite failed to run

    src/__tests__/runQueue.test.ts:1:53 - error TS2307: Cannot find module '../services/runQueue' or its corresponding type declarations.
```

### GREEN
Command:
```bash
npm test -- src/__tests__/runQueue.test.ts
```

Observed result:
```text
PASS src/__tests__/runQueue.test.ts
Tests: 4 passed, 4 total
```

Note: Jest emitted an existing ts-jest warning about hybrid module kind and `isolatedModules`; it did not affect the test result.

## Files Changed

- `src/services/runQueue.ts`
- `src/__tests__/runQueue.test.ts`

## Self-Review

- The queue enforces global concurrency and resource-level serialization.
- Rejections propagate to the queued promise, and the drain loop continues after failure.
- Resource-key generation prefers merge request iid, then issue iid, then a fallback based on the event object.
- Scope stayed limited to the task files requested.

## Concerns

- The test run still prints the repository's existing ts-jest module-kind warning. I did not change tsconfig in this task because the brief limited scope to the queue files.

## Fix Follow-Up

Addressed the review finding on `globalConcurrency` validation in `src/services/runQueue.ts`.

### What Changed

- Invalid or missing `globalConcurrency` values now fall back to `2`.
- Positive finite values still get floored, with a minimum effective concurrency of `1`.
- Added a regression test covering `0`, negative numbers, and `NaN`, proving that two different resource keys can start concurrently under the fallback value.

### Verification

Command:
```bash
npm test -- src/__tests__/runQueue.test.ts
```

Result:
```text
PASS src/__tests__/runQueue.test.ts (7/7 tests passed)
```
