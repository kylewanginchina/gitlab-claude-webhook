---
name: test-coverage-review
description: Evaluates whether the tests in a merge request actually protect the behaviour it changes. Finds tests that assert nothing meaningful, mock away the code under test, miss the failure path the change introduces, or were weakened to make the change pass. Activated when test files are part of the diff or when CLAUDE.md requires tests for the touched area.
metadata:
  review-passes: "comments-and-contracts,claude-guidelines"
  review-globs: "**/*.test.*,**/*.spec.*,**/*_test.*,**/test_*,**/tests/**,**/__tests__/**,**/spec/**"
---

# Test coverage review

Do not demand full coverage. Focus on whether the tests in this merge request would catch the regressions most likely to come from the code it changes.

## Findings to look for

- **Weakened or deleted assertions.** A test whose expectation was loosened, an assertion removed, or a case skipped or marked pending in this merge request without a stated reason.
- **Tests that cannot fail.** Assertions on constants, `expect(true)`, snapshot updates that blindly accept new output, or tests where the mock returns exactly what is asserted.
- **Mocking the unit under test.** The function or module the merge request changed is mocked in its own test, so the new logic never runs.
- **Missing failure-path coverage for new error handling.** The merge request adds a branch for an error, timeout, empty result, or invalid input, and no test exercises that branch. Point at the untested branch line in the production code and use `line_type: "new"`.
- **New public behaviour with no test at all**, only when CLAUDE.md or an adjacent test convention in the same directory clearly requires it.
- **Async tests that do not await.** Promise-returning tests that finish before the assertion runs.
- **Order or time dependence.** Tests relying on wall-clock time, real network, or shared mutable state introduced by this change.

## Not findings

- Line coverage percentages.
- Style of test names or structure.
- Missing tests for trivial getters, type definitions, or configuration plumbing.

## Output

Use category `test-gap`. In the body, state precisely which regression the missing or broken test would have caught. Findings must be anchored to a line changed by the merge request, either in the test file or in the production code whose new branch is untested.
