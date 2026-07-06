# DeepFlow Build Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Docker image profile for `gitlab-claude-webhook` that includes DeepFlow build and validation tools.

**Architecture:** Keep the default `Dockerfile` lean. Add `Dockerfile.deepflow` and `docker-compose.deepflow.yml` as an opt-in profile that operators can build when MR reviews need local DeepFlow compile/test commands such as `cargo`, `go`, `protoc`, `clang`, and `make`.

**Tech Stack:** Docker, Docker Compose, Debian-based Node 20, Rust/Cargo, Go, Clang/LLVM, protobuf, libpcap, libelf, bash/git/curl/ripgrep.

## Global Constraints

- Do not replace the default webhook image.
- Do not commit runtime `data/` files or secrets.
- Cache Cargo, Go, npm, and DeepFlow work directories through named volumes.
- Use configurable Debian mirror build args so operators can switch package mirrors without editing the Dockerfile.
- Verify the optional image can build before completion.

---

### Task 1: Structural Verification

**Files:**

- Create: `scripts/verify-deepflow-image-files.sh`

**Interfaces:**

- Produces: a shell script that exits non-zero if the optional image files are missing key commands, dependencies, or compose volume definitions.

- [ ] **Step 1: Write the failing verification script**

Create `scripts/verify-deepflow-image-files.sh` with checks for:

- `Dockerfile.deepflow`
- `docker-compose.deepflow.yml`
- tool commands: `node`, `npm`, `cargo`, `rustc`, `go`, `protoc`, `clang`, `make`, `pkg-config`, `rg`
- volumes: `deepflow-cargo-registry`, `deepflow-cargo-git`, `deepflow-go-cache`, `deepflow-npm-cache`, `deepflow-work`

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/verify-deepflow-image-files.sh`

Expected: FAIL because `Dockerfile.deepflow` does not exist.

### Task 2: Optional DeepFlow Image

**Files:**

- Create: `Dockerfile.deepflow`
- Create: `docker-compose.deepflow.yml`

**Interfaces:**

- Consumes: existing app source, `package-lock.json`, frontend package files, and runtime env vars used by `docker-compose.yml`.
- Produces: image target `gitlab-claude-webhook-deepflow` and service override that keeps port/env behavior compatible with the default service.

- [ ] **Step 1: Add `Dockerfile.deepflow`**

Use Node 20 Bookworm as a predictable Debian base, install Rust/Cargo, Go, Clang/LLVM, protobuf, libpcap, libelf, build tools, and existing app dependencies. Build backend and frontend exactly like the default Dockerfile, then run as non-root `claude`.

- [ ] **Step 2: Add `docker-compose.deepflow.yml`**

Override only build/image/volumes for `gitlab-claude-webhook`. Keep the same service name so operators can run:

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml up -d gitlab-claude-webhook
```

### Task 3: Documentation

**Files:**

- Modify: `docs/CONFIG.md`
- Modify: `README.md`

**Interfaces:**

- Produces: operator instructions for when to use the DeepFlow image, how to build it, and how to verify included tooling.

- [ ] **Step 1: Document opt-in usage**

Explain that the default image remains recommended unless reviews need DeepFlow compile/test commands.

- [ ] **Step 2: Document verification**

Include commands for `docker exec` checking `node`, `npm`, `cargo`, `rustc`, `go`, `protoc`, `clang`, `make`, and `pkg-config`.

### Task 4: Verification and Commit

**Files:**

- Verify all files from Tasks 1-3.

- [ ] **Step 1: Run structural verification**

Run: `bash scripts/verify-deepflow-image-files.sh`

Expected: PASS.

- [ ] **Step 2: Run project verification**

Run:

```bash
npm run type-check
npm test -- --runInBand
npm run build:all
```

Expected: all commands exit 0.

- [ ] **Step 3: Build optional Docker image**

Run:

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
```

Expected: build exits 0.

- [ ] **Step 4: Commit**

Commit message:

```bash
git commit -m "feat: add optional deepflow build image"
```
