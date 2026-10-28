---
name: go-review
description: Language-specific review knowledge for Go merge requests - error wrapping and shadowing, goroutine leaks, context propagation, loop variable capture, nil interfaces, slice aliasing, and sync misuse. Activated when the diff contains .go files.
metadata:
  review-passes: "bug-scan,history-context,comments-and-contracts"
  review-languages: "go"
---

# Go review notes

Assume `go vet`, `staticcheck`, and `gofmt` run in CI. Focus on logic the toolchain cannot see.

## Errors

- `err` shadowed by `:=` inside an inner scope so the outer check tests a stale value.
- Errors returned without wrapping (`fmt.Errorf("...: %w", err)`) where callers use `errors.Is`/`errors.As` on them elsewhere in the diff.
- Error checked, logged, and then execution continues with a zero value as if it succeeded.
- `defer f.Close()` on a writable file where the close error is the write error, silently dropped.
- Custom error types returned as a typed nil pointer, making the interface non-nil.

## Goroutines and concurrency

- Goroutine started with no way to stop it: missing `ctx.Done()` select, missing `WaitGroup`, channel never closed so a receiver blocks forever.
- Sending on an unbuffered channel with no guaranteed receiver, or `select` without a default or context case that can block a request handler.
- `sync.WaitGroup.Add` called inside the goroutine instead of before it.
- Maps written from multiple goroutines without a mutex. `sync.Mutex` copied by value (struct passed by value).
- Loop variables captured by goroutines or closures (pre-Go 1.22 semantics, or when the module still targets an older version).
- `time.After` in a loop leaking timers; `time.Tick` never stopped.

## Context

- `context.Background()` used inside a request path where a request context exists.
- Context stored in a struct instead of passed.
- Cancelled context not checked before an expensive or irreversible operation.

## Slices, maps, and values

- Sub-slices that alias the parent and are later appended to, corrupting the caller's data.
- `append` result discarded.
- Range over a map with order-dependent logic.
- Struct copied where a pointer was needed to see mutations, or vice versa.
- Comparing interfaces holding uncomparable types (panics at runtime).

## HTTP and I/O

- Response body not closed, or closed before being fully read when connection reuse matters.
- `http.Client` without timeout. Server handlers writing headers after the body.
- `json.Unmarshal` into a struct with fields silently ignored due to tag typos introduced in the diff.
