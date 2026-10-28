---
name: typescript-review
description: Language-specific review knowledge for TypeScript and JavaScript merge requests - async and promise pitfalls, nullish handling, type narrowing that lies at runtime, Node.js stream and event patterns, and module boundary mistakes. Activated when the diff contains .ts, .tsx, .js, .jsx, .mjs or .cjs files.
metadata:
  review-passes: "bug-scan,history-context,comments-and-contracts"
  review-languages: "typescript,javascript"
---

# TypeScript and JavaScript review notes

Assume `tsc` and the linter run in CI. Do not report type errors or lint. Look for defects that pass the type checker.

## Async and promises

- Missing `await` on a promise whose result or rejection matters, especially inside `try` blocks (the `catch` will not catch it) and inside `forEach` callbacks (the loop does not wait).
- `Promise.all` where one rejection should not cancel the others, or `Promise.allSettled` where a failure is then ignored.
- Async work started in a constructor or module top level with no error path.
- Timers and intervals created without a matching clear on every exit path, including the error path.
- `AbortController` signals that are created but never checked, or aborted after the work already committed side effects.
- Event emitters and async iterators: listeners added per call without removal, `for await` loops that never break on a terminal message.

## Nullish and truthiness

- `||` used as a default where `0`, `''`, or `false` are valid values. `??` was intended.
- Optional chaining that silently turns a programming error into `undefined` that flows onward.
- `Array.prototype.find` results used without a check, `Map.get` results used directly.
- `JSON.parse` of external data followed by property access without validation. Types from `as` casts are not runtime guarantees.

## Type narrowing that lies

- `as` casts and non-null assertions (`!`) added by the merge request on values that come from I/O, config, or user input.
- Exhaustive `switch` on a union where a new member was added elsewhere in the diff but this switch was not updated and has no `never` default.
- Enums or string unions compared against literals with different casing.

## Node.js specifics

- `process.env` values are strings; numeric or boolean comparisons against them are bugs.
- `child_process` with user-assembled command strings. Prefer argument arrays.
- `fs` operations on paths derived from input without `path.resolve` and containment checks.
- Stream errors not handled (`stream.on('error')` missing) leading to unhandled rejections or crashes.
- Using `require` results as singletons across tests where module state leaks.

## Module and API boundaries

- Mutating an object that was passed in or returned from a shared store, when callers expect a copy.
- Exported function signature changed but a call site in the diff or an obvious sibling not updated in a way the type checker cannot see (for example, positional arguments of the same type swapped).
- Default exports renamed or re-exported so that `import x from` and `import { x } from` diverge.

## Express and webhook services

- Route handlers that are `async` without an error wrapper, so a thrown error hangs the request.
- Reading the body twice, or verifying a signature on the parsed body instead of the raw bytes.
- Responding after the response was already sent, or returning before responding on some branch.
