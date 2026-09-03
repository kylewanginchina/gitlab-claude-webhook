---
name: security-review
description: Reviews merge request changes for concrete, exploitable security defects - injection, missing authorization on new endpoints, unsafe deserialization, secret leakage, path traversal, weak crypto, SSRF, and unsafe shell or SQL construction. Activated when the diff touches request handlers, auth code, database access, shell execution, file paths, or configuration.
metadata:
  review-passes: "bug-scan"
  review-globs: "**"
---

# Security review of a merge request

Report only vulnerabilities with a concrete attack path through code this merge request adds or changes. Generic hardening advice is not a finding.

## Checklist by change type

**New or modified request handlers, webhooks, RPC methods**
- Is authentication and authorization enforced on the new route, consistently with sibling routes? A new endpoint that skips the middleware the others use is a finding.
- Is signature or token verification constant-time and applied before any side effect?
- Are inputs bounded in size and validated before use? Where do untrusted values flow?

**Database, search, or query construction**
- String-built SQL, NoSQL filters, LDAP, or query DSL with untrusted input. Confirm the input is untrusted by tracing it to a request, webhook, file, or environment boundary.

**Shell, process, and file system**
- `exec`, `spawn` with `shell: true`, backticks, `os.system`, `subprocess` with `shell=True`, or command strings assembled from variables.
- Paths joined from user input without normalisation and prefix checks. Archive extraction without path validation.
- Temporary files created predictably or with permissive modes.

**Secrets and logging**
- Tokens, keys, passwords, cookies, or full authorization headers written to logs, error messages, comments posted to external systems, or committed files.
- Secrets read from a place where they are exposed to less-trusted code, for example passed on a command line.

**Deserialization and parsing**
- `eval`, `pickle`, `yaml.load` without safe loader, `unserialize`, prototype-polluting deep merges, `JSON.parse` of untrusted data followed by property-keyed writes.

**Network**
- Outbound requests to URLs derived from user input (SSRF). TLS verification disabled. Redirect targets taken from parameters.

**Crypto and randomness**
- Non-cryptographic random for tokens or IDs that gate access. Home-grown comparison of secrets. MD5 or SHA-1 for integrity or passwords.

**Automation and AI agent contexts**
- Untrusted content (issue text, commit messages, file contents) forwarded into a prompt or command with elevated permissions without clear trust boundaries. Report only when the merge request widens what untrusted content can trigger.

## Verification standard

Name the source of untrusted input, the sink, and the missing control. If you cannot identify all three, the confidence must be 25 or lower. Use category `security`. Do not report issues on unchanged lines.
