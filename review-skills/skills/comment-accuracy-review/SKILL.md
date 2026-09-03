---
name: comment-accuracy-review
description: Verifies that comments, docblocks, README fragments, and inline documentation touched by a merge request match the code they describe, and that code changes did not leave nearby comments stale. Activated for the comments-and-contracts pass.
metadata:
  review-passes: "comments-and-contracts"
  review-globs: "**"
---

# Comment and documentation accuracy

Treat every comment near changed code as a claim to be checked.

## Findings

- **Stale comment after code change.** The merge request changes behaviour (parameters, return values, ordering, error semantics, defaults) but the docblock or inline comment above it still describes the old behaviour. Anchor the finding to the changed code line, not the comment, when the comment itself is unchanged and outside the diff. If the comment was edited, anchor to the comment.
- **Comment contradicts code.** A new comment states something the code does not do: wrong complexity, wrong null handling, wrong thread-safety claim, wrong unit.
- **Contract in a comment that the change violates.** Comments such as "must be called after X", "never returns null", "caller holds the lock", "idempotent", or "keep in sync with Y". Check whether the merge request honours them. This overlaps with contract review and is high value.
- **Misleading TODO or FIXME.** A TODO added that describes work already done, or a FIXME removed while the underlying problem remains.
- **Documentation examples that no longer run** because a signature or config key changed in this merge request.

## Not findings

- Missing comments on self-explanatory code.
- Comments that merely restate the code, unless CLAUDE.md prohibits them.
- Grammar or wording.

## Output

Use category `comment-drift` for stale or wrong comments and `contract` when a comment documents an invariant the change violates. Quote the exact comment phrase and the code fact that contradicts it.
