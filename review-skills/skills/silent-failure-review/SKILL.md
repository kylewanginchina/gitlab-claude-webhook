---
name: silent-failure-review
description: Hunts for silent failures and inadequate error handling introduced by a merge request - swallowed exceptions, broad catches, fallbacks that hide problems, ignored return codes, and error paths that leave state inconsistent. Use on any change that adds or edits try/catch, error returns, retries, or fallback logic.
metadata:
  review-passes: "bug-scan,comments-and-contracts"
  review-globs: "**"
---

# Silent failure review

Focus only on error handling that the merge request adds or changes. Look at each new or modified `catch`, `except`, `rescue`, `recover`, `.catch(`, `on error`, `if err != nil`, `Result`/`Option` unwrap, and every fallback or default value that replaces a failed operation.

## Patterns that are findings

- **Swallowed errors.** A catch block that logs nothing, or logs at debug level, and continues as if the operation succeeded. Ask: will the caller believe this succeeded?
- **Broad catches hiding unrelated failures.** Catching the base exception type around a block where only one specific failure is expected, so programming errors, cancellation, or auth failures are also silenced.
- **Fallback to a default that masks the failure.** Returning an empty list, `null`, `0`, or a cached value when the real operation failed, without signalling the failure to the caller or the user.
- **Ignored results.** Return values or promises that indicate failure but are discarded. Unawaited async calls whose rejection goes nowhere.
- **Partial-state errors.** An operation that mutates state, then fails halfway, and the catch path does not roll back or mark the state as inconsistent.
- **Retries without bound or without surfacing the final failure.**
- **Error messages that lose the cause.** Rethrowing a new error without the original message or cause, so the root problem is undiagnosable in logs.
- **Mock, stub, or fake fallbacks in production paths.** Code that falls back to a fake implementation when the real one fails.

## What is not a finding

- Intentional best-effort behaviour that is documented in a nearby comment and where the caller genuinely does not need to know. Cleanup in `finally`, telemetry, and optional cache warms often qualify.
- Error handling that was already this way before the merge request.
- A broad catch at a true top-level boundary that logs the full error and reports a failure to the user.

## How to verify

For each candidate, trace the failure: what throws, who catches it, what the caller sees afterwards, and what a user or operator would observe. Only report it if the answer is "nothing, and they would be wrong to assume success". Quote the catch site line and name the swallowed error type in the finding body. Use category `error-handling`.
