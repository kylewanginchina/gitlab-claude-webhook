---
name: python-review
description: Language-specific review knowledge for Python merge requests - mutable defaults, exception handling idioms, asyncio misuse, resource management, typing that hides runtime errors, and common library pitfalls. Activated when the diff contains .py files.
metadata:
  review-passes: "bug-scan,history-context,comments-and-contracts"
  review-languages: "python"
---

# Python review notes

Assume ruff, mypy, or equivalent run in CI. Report only what they will not catch.

## Classic defects

- Mutable default arguments (`def f(items=[])`) added or now mutated.
- `except:` or `except Exception:` that swallows `KeyboardInterrupt`-adjacent control flow or hides programming errors, especially with `pass` or a bare log.
- `is` comparisons with literals other than `None`, `True`, `False`.
- Late-binding closures in loops (`lambda: i`).
- Modifying a list or dict while iterating over it.
- Integer division or float equality introduced by the change.
- String formatting of user input into SQL, shell, or format strings (`str.format` with untrusted templates can read attributes).

## Resources and context managers

- Files, sockets, sessions, database cursors, or locks opened without `with`, or released only on the happy path.
- `tempfile` used insecurely (`mktemp`).
- Threads or processes started without join and without a shutdown path.

## asyncio

- Calling a coroutine without `await` or without scheduling it (creates a never-run coroutine, often only a warning).
- `asyncio.create_task` results dropped, so exceptions are lost and tasks may be garbage collected mid-run.
- Blocking calls (`time.sleep`, `requests`, file I/O) inside `async def`.
- Sharing a client or session across event loops.

## Typing that does not protect at runtime

- `Optional` values dereferenced after a check that mypy accepts but that is not equivalent at runtime (for example, checking a different variable).
- `TypedDict` or dataclass fields assumed present when the object came from JSON.
- `cast()` on external data.

## Library-specific traps

- `requests` without `timeout`. `raise_for_status()` missing where an error response must not be treated as data.
- `subprocess.run(..., shell=True)` with variables. `check=True` missing where the exit code matters.
- `datetime.now()` without timezone compared against timezone-aware values.
- Pandas chained assignment or boolean indexing with `and`/`or` instead of `&`/`|`.
- Logging with f-strings that evaluate expensive or sensitive values eagerly, when the change adds secrets to the message.
