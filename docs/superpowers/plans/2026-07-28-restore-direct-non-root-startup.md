# Restore Direct Non-Root Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 Docker 镜像直接以 `claude` 用户启动的原有方式，彻底移除容器启动时的 ownership 修改和用户切换。

**Architecture:** 两个 Dockerfile 继续在构建阶段创建并设置镜像内目录，但通过 `USER claude` 直接运行 Node。删除 root entrypoint 及其辅助程序，Compose 挂载和业务配置保持不变。

**Tech Stack:** Docker、Docker Compose、POSIX shell、Node.js 20

## Global Constraints

- 不修改现有 bind mount 或 named volume 的内容及 ownership。
- 不修改 Claude `permissionMode: 'bypassPermissions'` 或 Codex `sandboxMode: 'danger-full-access'`。
- 不修改业务代码和主机 `/root/.codex/config.toml`。
- 生产仍使用 DeepFlow Compose override 和端口 `3001`。

---

### Task 1: Replace Runtime Image Contracts

**Files:**
- Modify: `scripts/verify-runtime-image-files.sh`
- Modify: `scripts/verify-deepflow-image-files.sh`

**Interfaces:**
- Consumes: `Dockerfile` and `Dockerfile.deepflow` as text.
- Produces: static checks that require direct non-root startup and reject a runtime entrypoint.

- [ ] **Step 1: Replace the entrypoint assertions**

Add a rejection helper:

```bash
reject_text() {
  local file="$1"
  local text="$2"
  if grep -Fq "$text" "$file"; then
    echo "Unexpected '$text' in ${file#$ROOT_DIR/}" >&2
    exit 1
  fi
}
```

Require `USER claude` in both Dockerfiles. Reject `ENTRYPOINT`,
`docker-entrypoint.sh`, `su-exec`, and `gosu`. Remove all assertions that
inspect `docker-entrypoint.sh`.

- [ ] **Step 2: Run the static checks and verify RED**

Run:

```bash
bash scripts/verify-runtime-image-files.sh
bash scripts/verify-deepflow-image-files.sh
```

Expected: both fail because the current Dockerfiles still contain the runtime
entrypoint and helper packages.

- [ ] **Step 3: Check the test-only diff**

Run:

```bash
git diff --check -- scripts/verify-runtime-image-files.sh scripts/verify-deepflow-image-files.sh
```

Expected: exit `0`.

---

### Task 2: Restore Direct Non-Root Startup

**Files:**
- Modify: `Dockerfile`
- Modify: `Dockerfile.deepflow`
- Delete: `docker-entrypoint.sh`

**Interfaces:**
- Consumes: the `claude` user and build-time writable directories already created by each Dockerfile.
- Produces: images whose configured runtime user is `1001:1001` without a root entrypoint.

- [ ] **Step 1: Restore the base Dockerfile**

Remove `su-exec` from the Alpine package installation. Remove the
`docker-entrypoint.sh` copy, chmod, and `ENTRYPOINT`. Insert:

```dockerfile
USER claude
```

after the build-time directory ownership setup and before the runtime
environment/CMD section.

- [ ] **Step 2: Restore the DeepFlow Dockerfile**

Remove `gosu` from the Debian package installation. Remove the
`docker-entrypoint.sh` copy, chmod, and `ENTRYPOINT`. Insert:

```dockerfile
USER claude
```

after the build-time directory ownership setup and before the runtime
environment/CMD section.

- [ ] **Step 3: Delete the runtime entrypoint**

Delete `docker-entrypoint.sh`. Do not replace it with another startup wrapper.

- [ ] **Step 4: Run the static checks and verify GREEN**

Run:

```bash
bash scripts/verify-runtime-image-files.sh
bash scripts/verify-deepflow-image-files.sh
```

Expected: both pass.

---

### Task 3: Correct Deployment Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/CONFIG.md`
- Modify: `docs/admin-console-design.md`

**Interfaces:**
- Consumes: the direct non-root image contract from Task 2.
- Produces: deployment instructions that do not claim automatic ownership repair.

- [ ] **Step 1: Replace automatic repair claims**

Document that the Node process runs directly as UID/GID `1001:1001`, the
container does not modify mounted directory ownership, and deployment must
provide writable `data` and `logs` mounts. Keep all logging behavior and paths
unchanged.

- [ ] **Step 2: Verify documentation consistency**

Run:

```bash
rg -n "自动修复|入口脚本.*ownership|entrypoint.*ownership" README.md docs/CONFIG.md docs/admin-console-design.md
```

Expected: no matches.

Run:

```bash
git diff --check
```

Expected: exit `0`.

---

### Task 4: Verify Images Without Touching Production

**Files:**
- Test only; no source changes.

**Interfaces:**
- Consumes: base and DeepFlow image definitions.
- Produces: evidence that both images run directly as UID/GID `1001:1001`.

- [ ] **Step 1: Run repository verification**

Run:

```bash
npm test -- --runInBand
npm run type-check
npm run build
docker compose config --quiet
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml config --quiet
```

Expected: all commands exit `0`.

- [ ] **Step 2: Build isolated test images**

Run:

```bash
docker build -t gitlab-claude-webhook:direct-user-test .
docker build -f Dockerfile.deepflow -t gitlab-claude-webhook-deepflow:direct-user-test .
```

Expected: both builds exit `0`.

- [ ] **Step 3: Verify configured users and writable image directories**

Run each image with `--entrypoint sh` and execute:

```bash
test "$(id -u)" = "1001"
test "$(id -g)" = "1001"
touch /app/data/write-test
touch /app/logs/write-test
touch /tmp/gitlab-claude-work/write-test
```

For the DeepFlow image also touch:

```bash
touch /home/claude/.cargo/write-test
touch /home/claude/.cache/write-test
touch /home/claude/go/write-test
touch /home/claude/.npm/write-test
touch /tmp/deepflow-work/write-test
```

Expected: both temporary containers exit `0`.

---

### Task 5: Commit and Deploy the Existing DeepFlow Variant

**Files:**
- Commit all files changed by Tasks 1-3.
- Deploy with existing `docker-compose.yml` and `docker-compose.deepflow.yml`.

**Interfaces:**
- Consumes: verified DeepFlow image and existing production volumes.
- Produces: healthy production service on port `3001`.

- [ ] **Step 1: Record production ownership without changing it**

Record `stat` output for the bind mount paths and every mounted named-volume
root. Do not run `chown`, `chmod`, or commands that create files in those
locations.

- [ ] **Step 2: Commit the rollback**

Run:

```bash
git add Dockerfile Dockerfile.deepflow docker-entrypoint.sh \
  scripts/verify-runtime-image-files.sh scripts/verify-deepflow-image-files.sh \
  README.md docs/CONFIG.md docs/admin-console-design.md
git commit -m "fix: restore direct non-root container startup"
```

- [ ] **Step 3: Tag the verified DeepFlow image and update production**

Tag the exact tested DeepFlow image as
`gitlab-claude-webhook-deepflow:latest`, then run:

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml up -d --no-build gitlab-claude-webhook
```

- [ ] **Step 4: Verify production**

Verify:

```bash
curl -fsS http://127.0.0.1:3001/health
curl -fsS -o /dev/null http://127.0.0.1:3001/admin
docker inspect gitlab-claude-webhook --format '{{.State.Health.Status}}'
docker exec gitlab-claude-webhook sh -c 'test "$(id -u)" = 1001 && test "$(id -g)" = 1001'
```

Compare the recorded ownership with post-deployment `stat` output. Expected:
health is `healthy`, both HTTP requests succeed, PID 1 runs as `1001:1001`,
and ownership is unchanged.
