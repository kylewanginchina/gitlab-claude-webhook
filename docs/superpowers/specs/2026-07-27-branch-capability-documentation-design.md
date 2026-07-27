# 分支能力文档更新设计

## 目标

根据 `codex/admin-console-runtime-config` 相对 `main` 的全部已实现变更，
更新面向用户和运维人员的文档。文档只描述当前代码已经具备的能力，不把
规划中或不可用的功能写成现有能力。

## 事实来源

文档以当前代码实现为准，重点核对：

- 运行时配置类型、默认值、校验和重启判定
- Express 路由注册和管理接口认证
- Webhook 指令解析和执行模式选择
- 任务队列调度和资源键
- Claude 与 Codex 执行器配置
- 多轮 Review 编排和 GitLab 输出格式
- Prompt Template、Review Prompt、Skill、反馈和优化建议的持久化
- Docker 和 DeepFlow 镜像定义

提交记录和设计文档只能用于定位变更，不能代替当前代码作为行为依据。

## 文档结构

### `README.md`

README 作为能力总览和主要使用入口，将说明：

- Claude Agent SDK 和 OpenAI Codex SDK 执行能力
- 显式 mention、模型选择和超时时间覆盖语法
- 普通编辑模式与 MR 只读 Review 模式
- `/code-review` 多轮 Review 流程
- 全局任务并发和相同资源串行化
- 排队状态与进度评论
- 管理页面访问方式
- 运行时配置和凭据隔离
- Prompt、Skill 和反馈管理
- 可选 DeepFlow 构建工具镜像
- 当前 HTTP 接口和项目结构

处理流程将明确区分两类任务：Review 不发布文件修改；普通编辑任务可以创建
分支和 Merge Request。

### `docs/CONFIG.md`

配置指南作为完整配置参考，将记录每一个由环境变量初始化的运行时字段，
包括默认值、允许值以及热更新或重启要求。

同时说明：

- 持久化运行时配置的优先级
- 首次启动初始化过程
- 密钥更新语义
- 运行时 provider 凭据与进程继承凭据的隔离
- 单次执行器调用的配置快照
- 运行时配置重新加载
- Docker 数据持久化
- DeepFlow 镜像构建参数和缓存

管理 API 只会把 `webhook.port` 和 `workDir` 报告为需要重启的运行时字段。
Docker volume 和 network 变更属于部署配置，不是管理页面中的运行时配置字段。

### `docs/admin-console.md`

管理页面指南作为详细运维手册，将说明：

- `/admin` 访问方式和 `X-Admin-Key` 认证
- Dashboard、Runtime Settings 和 Review Tuning 页面
- 密钥脱敏和替换行为
- 热更新与重启配置
- 内置 Prompt Template 目录及变量
- Review Prompt 的草稿、发布和回滚流程
- 当前执行路径使用所有已启用的 Review Prompt，Prompt provider 作为保存的元数据
- Skill 按启用状态、当前 Review 匹配 provider、Prompt ID、文件 glob 和优先级匹配
- 反馈分析与优化建议应用流程
- 所有已实现的 `/api/admin` 路由
- Provider 测试接口只检查配置状态，不发起远程连通性请求

### `.env.example`

环境变量模板将补齐所有已实现配置，包括任务并发数和全部 Review 控制参数。

### `docs/gitlab-setup.md`

GitLab 配置指南将在 Webhook 安装说明之外补充：

- 支持的事件和显式 `@claude`、`@codex` 指令
- `/code-review` 用法和可选 Review 关注点
- MR 自然语言 Review 识别
- 排队确认和每个 MR/Issue 的串行处理
- Review 汇总、行内讨论和源码链接

## 行为边界

文档采用以下明确行为描述：

- 每个 Webhook 请求入队后立即返回确认，AI 任务在后台异步执行。
- 默认全局并发数为 `2`。
- 同一项目下相同 MR 或 Issue 的任务串行执行。
- 不同资源的任务可以在全局并发上限内并行执行。
- `/code-review` 使用配置的多轮 Review provider。
- MR 中的自然语言 Review 请求使用 mention 明确指定的 provider，并进入只读模式。
- 非 Review 普通请求进入编辑模式，可以发布修改。
- Review 模式不发布文件变更，并限制 Claude 可用工具。
- 多轮 Review 根据运行时设置跳过不符合条件的 MR，合并候选问题、重新评分，
  最后只发布保留的问题。
- 部分 Review 或评分阶段失败时，只要其他阶段完成，就输出覆盖不完整的结果。
- 超时时间既由执行器强制执行，也作为时间预算注入 Prompt。
- 运行时 Claude 和 Codex 凭据会覆盖新执行任务继承到的 provider 凭据。
- 每次执行器调用只捕获一次运行时配置快照；后续管理页面修改不会改变正在运行的调用。
- Prompt Template 草稿和 Review Prompt 的 focus 草稿只有发布后才影响执行；已发布
  Review Prompt 的 `systemInstructions` 为空时会回退到 draft 值。应用优化建议只修改
  Review Prompt 草稿，仍需人工检查并发布。
- Skill 保存、启用或停用后，无需发布步骤即可影响后续 Review 匹配。
- 当前多轮 Review 以 `claude` 作为 Skill 匹配 provider，因此实际命中
  `any` 或 `claude` Skill。

## 准确性约束

- 不描述未实现的 provider、插件或集成。
- 不声称 Provider 测试接口会执行实时网络检查。
- 不声称每个请求都会创建分支或 Merge Request。
- 不把启动时生成的 `config.toml` 描述成 Codex 运行时 provider 配置的唯一来源；
  任务执行时会传入独立的 SDK 配置。
- 所有本次更新的用户文档统一使用中文；代码标识、环境变量、API 路径和界面实际
  标签保持原样。
- Docker 命令统一使用 `docker compose`。

## 校验

提交文档更新前执行以下核对：

1. 对照 `RuntimeConfigService` 检查每个环境变量和默认值。
2. 对照 `adminRoutes.ts` 检查每个管理接口。
3. 对照 `webhook.ts` 和 `eventProcessor.ts` 检查指令与 Review 行为。
4. 对照 `runQueue.ts` 和 `webhookServer.ts` 检查队列行为。
5. 对照 Dockerfile 和 Compose 文件检查镜像命令与工具列表。
6. 运行仓库可用的 Markdown 格式、链接检查；如果修改了文档相关模板，
   同时运行项目测试和类型检查。
