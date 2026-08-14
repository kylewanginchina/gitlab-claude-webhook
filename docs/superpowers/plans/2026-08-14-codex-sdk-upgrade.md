# Codex SDK 0.147.0 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the webhook's obsolete Codex SDK/CLI `0.143.0` with stable `0.147.0` and prove that the candidate DeepFlow image contains and can start with the upgraded client.

**Architecture:** Keep the existing `CodexExecutor` and HTTPS Codex2API data flow unchanged. Upgrade the SDK dependency, which brings the matching CLI as an exact transitive dependency, then verify the dependency graph and a clean candidate image in an isolated worktree.

**Tech Stack:** Node.js 20, npm lockfile v3, TypeScript, Jest, Docker, `@openai/codex-sdk`, `@openai/codex`

## Global Constraints

- Use stable `@openai/codex-sdk` `0.147.0` and bundled `@openai/codex` `0.147.0`; do not use an alpha release.
- Do not change Codex2API source code or runtime settings.
- Do not modify `/root/.codex/config.toml`, host credentials, ownership, or permissions.
- Do not trigger a real GitLab review or paid model request.
- Do not restart or replace the production webhook container.
- Preserve the current checkout's unrelated uncommitted changes.
- Build the candidate image from an isolated worktree so unrelated changes are not included.

---

## File Structure

- Modify `package.json`: declare the stable Codex SDK version used by the webhook.
- Modify `package-lock.json`: lock the SDK, CLI wrapper, and platform packages to `0.147.0`.
- No executor source change is expected because the `0.147.0` public API is backward compatible with current usage.

### Task 1: Upgrade and Validate the Codex Dependency Pair

**Files:**
- Modify: `package.json:30`
- Modify: `package-lock.json`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**
- Consumes: `CodexExecutor` imports `Codex`, `ThreadEvent`, and `ThreadItem` from `@openai/codex-sdk`.
- Produces: an npm dependency graph where `@openai/codex-sdk@0.147.0` resolves exactly one matching `@openai/codex@0.147.0` CLI package.

- [ ] **Step 1: Create an isolated worktree from the confirmed design commit**

Run from `/home/gitlab-claude-webhook`:

```bash
git worktree add -b codex/codex-sdk-0.147.0 /home/gitlab-claude-webhook-sdk-0147 HEAD
```

Expected: a clean worktree at `/home/gitlab-claude-webhook-sdk-0147` on branch `codex/codex-sdk-0.147.0`; the original checkout remains dirty only in its pre-existing files.

- [ ] **Step 2: Install the baseline lockfile and run the failing version check**

Run from the isolated worktree:

```bash
npm ci --ignore-scripts
node - <<'NODE'
const fs = require('node:fs');
const expected = '0.147.0';
const sdk = JSON.parse(fs.readFileSync('node_modules/@openai/codex-sdk/package.json', 'utf8')).version;
const cli = JSON.parse(fs.readFileSync('node_modules/@openai/codex/package.json', 'utf8')).version;
if (sdk !== expected || cli !== expected) {
  console.error(`expected SDK/CLI ${expected}, got ${sdk}/${cli}`);
  process.exit(1);
}
NODE
```

Expected: the second command fails with `expected SDK/CLI 0.147.0, got 0.143.0/0.143.0`, reproducing the stale-client condition without an API request.

- [ ] **Step 3: Update the direct dependency declaration**

Change the dependency in `package.json` to:

```json
"@openai/codex-sdk": "^0.147.0"
```

- [ ] **Step 4: Regenerate only the npm dependency lock and install it**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
```

Expected: npm completes successfully and `package-lock.json` resolves the SDK, CLI wrapper, and platform-specific optional packages at `0.147.0`.

- [ ] **Step 5: Run the version check and inspect dependency resolution**

Run:

```bash
node - <<'NODE'
const fs = require('node:fs');
const expected = '0.147.0';
const sdk = JSON.parse(fs.readFileSync('node_modules/@openai/codex-sdk/package.json', 'utf8')).version;
const cli = JSON.parse(fs.readFileSync('node_modules/@openai/codex/package.json', 'utf8')).version;
if (sdk !== expected || cli !== expected) {
  console.error(`expected SDK/CLI ${expected}, got ${sdk}/${cli}`);
  process.exit(1);
}
console.log(`Codex SDK/CLI ${sdk}/${cli}`);
NODE
npm ls @openai/codex-sdk @openai/codex
./node_modules/.bin/codex --version
```

Expected output includes:

```text
Codex SDK/CLI 0.147.0/0.147.0
@openai/codex-sdk@0.147.0
@openai/codex@0.147.0
codex-cli 0.147.0
```

- [ ] **Step 6: Run focused and repository regressions**

Run each command independently:

```bash
npx jest --runInBand src/__tests__/runtimeConfigExecution.test.ts
npm run type-check
npm run build
npm test -- --runInBand
git diff --check
```

Expected: all commands exit zero. If the full test suite has a pre-existing unrelated failure, capture its exact test name and prove the focused Codex executor test, type check, and build still pass before proceeding.

- [ ] **Step 7: Commit the dependency upgrade**

```bash
git add package.json package-lock.json
git commit -m "fix: upgrade Codex SDK for gpt-5.6-sol"
```

Expected: the commit contains only `package.json` and `package-lock.json`.

### Task 2: Build and Verify an Isolated DeepFlow Candidate Image

**Files:**
- Read: `Dockerfile.deepflow`
- Read: `docker-entrypoint.sh`
- Test artifact: Docker image `gitlab-claude-webhook-deepflow:codex-0.147.0-test`

**Interfaces:**
- Consumes: the lockfile produced by Task 1 and the existing DeepFlow Dockerfile.
- Produces: a locally tagged, non-production candidate image with SDK/CLI `0.147.0` and a passing health endpoint.

- [ ] **Step 1: Build the candidate image from the clean worktree**

Run from `/home/gitlab-claude-webhook-sdk-0147`:

```bash
docker build --file Dockerfile.deepflow --tag gitlab-claude-webhook-deepflow:codex-0.147.0-test .
```

Expected: Docker build succeeds without changing `gitlab-claude-webhook-deepflow:latest`.

- [ ] **Step 2: Verify both installed package versions inside the image**

```bash
docker run --rm --entrypoint node gitlab-claude-webhook-deepflow:codex-0.147.0-test -e "const fs=require('node:fs'); for (const p of ['@openai/codex-sdk','@openai/codex']) console.log(p, JSON.parse(fs.readFileSync('/app/node_modules/'+p+'/package.json','utf8')).version)"
docker run --rm --entrypoint /app/node_modules/.bin/codex gitlab-claude-webhook-deepflow:codex-0.147.0-test --version
```

Expected:

```text
@openai/codex-sdk 0.147.0
@openai/codex 0.147.0
codex-cli 0.147.0
```

- [ ] **Step 3: Start an isolated container with dummy credentials**

```bash
docker run --detach --name gitlab-claude-webhook-codex-0147-test \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env GITLAB_TOKEN=test-gitlab-token \
  --env WEBHOOK_SECRET=test-webhook-secret \
  --env OPENAI_API_KEY=test-openai-key \
  gitlab-claude-webhook-deepflow:codex-0.147.0-test
```

Expected: only the isolated test container starts; no host port is published and no production volume is mounted.

- [ ] **Step 4: Verify startup and health without calling an AI endpoint**

```bash
docker exec gitlab-claude-webhook-codex-0147-test node -e "fetch('http://127.0.0.1:3000/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) }).catch(e => { console.error(e); process.exit(1) })"
docker logs gitlab-claude-webhook-codex-0147-test
```

Expected: `/health` returns HTTP 200, and logs show normal startup without an SDK import or CLI launch error.

- [ ] **Step 5: Remove the isolated test container**

```bash
docker rm --force gitlab-claude-webhook-codex-0147-test
```

Expected: the test container is removed; the candidate image remains available for inspection.

- [ ] **Step 6: Integrate only the dependency commit into the original checkout**

Run from `/home/gitlab-claude-webhook` using the isolated branch tip:

```bash
git cherry-pick codex/codex-sdk-0.147.0
git status --short
```

Expected: `package.json` and `package-lock.json` are committed on the original branch, while the four pre-existing unrelated modified files remain uncommitted and unchanged. Do not update the production image or container until the user gives a separate approval.
