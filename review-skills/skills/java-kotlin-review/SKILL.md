---
name: java-kotlin-review
description: Language-specific review knowledge for Java and Kotlin merge requests - equality and hashing contracts, nullability across the Java/Kotlin boundary, exception handling and checked-exception wrapping, concurrency utilities, resource handling, and framework lifecycle pitfalls. Activated when the diff contains .java, .kt or .kts files.
metadata:
  review-passes: "bug-scan,history-context,comments-and-contracts"
  review-languages: "java,kotlin"
---

# Java and Kotlin review notes

Assume the compiler and static analysis run in CI.

## Contracts

- `equals` changed without `hashCode`, or either changed on a class used as a map key or in a set elsewhere.
- `compareTo` inconsistent with `equals` for classes used in sorted collections.
- Mutable objects used as map keys or in hash sets after the change makes them mutable.
- `toString` or `hashCode` now touching lazily-initialised or remote state.

## Nullability

- Platform types crossing from Java into Kotlin treated as non-null (`!!`, implicit) when the Java side can return null.
- `Optional.get()` without `isPresent`, or `Optional` used as a field or parameter.
- `@Nullable` value dereferenced after a check on a different variable.
- Kotlin `lateinit` accessed on a path where initialisation is not guaranteed.

## Exceptions

- Catching `Exception` or `Throwable` and continuing, especially swallowing `InterruptedException` without restoring the interrupt flag.
- Checked exceptions wrapped in `RuntimeException` without the cause.
- `finally` blocks that return or throw, masking the original exception.
- Resources not in try-with-resources or Kotlin `use {}`.

## Concurrency

- Non-volatile field used for cross-thread signalling. Double-checked locking without `volatile`.
- `synchronized` on a mutable field or on a `String`/boxed literal.
- `ConcurrentHashMap` compound actions (`get` then `put`) that should be `compute`/`putIfAbsent`.
- `ExecutorService` created per call and never shut down. `CompletableFuture` exceptions never joined or handled.
- Kotlin coroutines: `GlobalScope` launch, `runBlocking` inside suspend or on a main thread, missing structured cancellation, `Dispatchers.IO` blocking calls inside `Default`.

## Frameworks

- Spring: field injection on a bean used in a `@Transactional` self-call (proxy bypass), `@Transactional` on a private or final method, checked exceptions that do not roll back by default.
- JPA/Hibernate: entity mutated outside a transaction, lazy collection accessed after session close, `equals` on entities using generated ids before persist.
- Jackson/Gson: new field without a default constructor path, `@JsonIgnore` removed exposing a secret.

## Kotlin specifics

- `data class` with mutable `var` properties used as keys.
- Extension shadowing a member with different semantics.
- `!!` added on values from I/O or external APIs.
- `when` on a sealed class or enum without `else` where a new subtype was introduced in the diff.
