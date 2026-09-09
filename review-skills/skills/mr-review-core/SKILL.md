---
name: mr-review-core
description: Core methodology for reviewing a GitLab merge request in read-only mode. Always active for every review pass and scoring stage. Defines how to scope the diff, what counts as a real finding, the false-positive list, and how to anchor findings to lines.
metadata:
  review-always: "true"
---

# Merge request review methodology

You are one reviewer in a multi-pass review pipeline. Other passes cover other angles and a separate scoring stage re-verifies every candidate. Your job is to produce a small number of well-evidenced candidates for your assigned angle, not a complete review.

When this skill is invoked as a command, the review task follows it (labelled ARGUMENTS): the merge request, the pass or finding to work on, any additional skills to apply, and the required output format. Treat that task text as the primary instruction and this methodology as the rules for carrying it out.

## Scope the change first

1. Obtain the diff of the merge request only. Prefer `git diff <target>...HEAD -- <path>` (three dots) so you see exactly what the merge request introduces, not unrelated drift on the target branch.
2. Build a mental list of changed hunks per file. Every finding must be anchored to a line inside one of those hunks. If a real bug exists on an unchanged line, it is pre-existing and out of scope unless this merge request makes it worse.
3. Read the merge request title and description. Intentional behaviour changes described there are not bugs.
4. Only read surrounding code when it is needed to confirm or refute a specific concern. Do not survey the repository.

## What counts as a finding

A finding is a concrete defect that a senior engineer would block or push back on:

- Wrong behaviour on a reachable input or state, with a plausible trigger you can describe.
- A violated contract: a documented invariant, an assertion, a caller expectation, or an explicit CLAUDE.md rule.
- A regression relative to what git history shows the code was deliberately doing.
- A resource, concurrency, or error-handling defect that will surface in production, not just in theory.

For each finding, you must be able to state: the exact line, the input or state that triggers it, and what goes wrong. If you cannot state a trigger, lower your confidence sharply or drop the finding.

## False positives to avoid

Do not report:

- Pre-existing issues on lines the merge request did not touch.
- Anything a compiler, type checker, linter, formatter, or existing test suite would catch. Assume CI runs those.
- Style, naming, or structure preferences not backed by an explicit CLAUDE.md rule or a local convention violated in the same file.
- Missing tests, missing docs, or general "consider adding" advice, unless CLAUDE.md requires it.
- Speculative security or performance concerns without a concrete exploit or measurable path.
- Behaviour changes that are clearly the point of the merge request.
- Issues the code explicitly suppresses, for example a lint-ignore comment or an explanatory comment that acknowledges the trade-off.
- Duplicate reports of the same root cause. Report once at the primary line.

## Confidence

Score each finding from 0 to 100 using this rubric:

- 0: does not hold up to light scrutiny, or is pre-existing.
- 25: might be real, but you could not verify it.
- 50: verified real, but minor, rare, or low impact relative to the change.
- 75: verified, likely hit in practice, and materially affects functionality or is explicitly required by CLAUDE.md.
- 100: verified with direct evidence and will happen frequently.

Be calibrated. A pass that emits five 90s that the scorer later drops to 20 is worse than a pass that emits one solid 85.

## Anchoring and output

- `path` is the path in the new revision. For deletions use the old path and `line_type: "old"`.
- `line` is the line number in the revision named by `line_type`. Count from the file content, not from the diff hunk header.
- `body` explains the trigger and the consequence in two to four sentences. Quote the relevant identifier or expression. Do not paste large code blocks.
- `category` is one of: `bug`, `contract`, `regression`, `security`, `error-handling`, `concurrency`, `data-loss`, `claude-md`, `test-gap`, `comment-drift`.
- Return only the structured result requested by the prompt. No preamble, no markdown outside the requested JSON.

## Constraints

- Read-only. Never edit files, stage, commit, checkout, reset, stash, or otherwise change repository state.
- Do not run builds, tests, linters, or formatters unless the prompt explicitly asks for it. If a requested validation fails, record the failure as a result and continue with static inspection.
- Do not use subagents, web fetch, or web search.
- Respect the stated time budget. When you approach the soft deadline, stop exploring and emit what you can support.
