# Restore Direct Non-Root Container Startup

## Goal

恢复引入运行时 ownership 修复前的容器启动方式。镜像直接以 `claude`
用户运行，不在容器启动时创建目录、修改 ownership 或切换用户。

## Changes

- 删除 `docker-entrypoint.sh`。
- 基础镜像不再安装 `su-exec`，DeepFlow 镜像不再安装 `gosu`。
- 两个 Dockerfile 都在构建阶段准备镜像内目录，然后通过 `USER claude`
  直接运行 Node。
- 保留当前 `LOG_DIR`、Compose 环境变量、挂载路径和业务功能。
- 不修改现有 bind mount 或 named volume 的内容及 ownership。
- 文档不再声称容器会自动修复挂载目录权限。

`claude` 用户继续使用现有 UID/GID `1001:1001`，因为 Claude Code 的
`bypassPermissions` 模式不能以 root 运行。UID 1001 不是入口脚本或运行时
ownership 修复的理由。

## Deployment

部署前只读检查现有挂载目录可由 UID/GID 1001 使用。检查失败时停止部署，
不自动修复权限。新部署者需要在部署侧保证 bind mount 可写；容器本身不修改
宿主机权限。

## Verification

- 静态检查要求两个 Dockerfile 包含 `USER claude`，且不包含运行时
  `ENTRYPOINT`、`su-exec` 或 `gosu`。
- 临时基础镜像和 DeepFlow 镜像验证 PID 1 为 UID/GID `1001:1001`。
- 临时容器验证 `/health`、`/admin`、日志和缓存目录。
- 更新生产前记录现有挂载目录 ownership；更新后确认 ownership 未变化，并
  验证启动不再扫描缓存卷。
