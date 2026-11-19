# AGENTS.md

本仓库用于开发和维护 **DeepSeekHarness（DSH）插件**。整体是 pnpm monorepo：根包只负责工作区管理，每个插件是 `plugins/` 下的独立子包。

## 运行环境

- Node.js **24.x**、pnpm **11.x**，版本已锁定在根 `package.json` 的 `engines` / `packageManager` / `volta` 中（Volta 原生支持 pnpm，同时兼容 nvm）。
- 统一使用 **pnpm**：不要用 npm / yarn 安装依赖，也不要提交它们生成的 lockfile。
- 装依赖时明确目标子包：`pnpm --filter <包名> add <依赖>`；根目录只放仓库级工具（如 prettier、typescript）。

## 目录结构

```text
.
├── package.json          # 工作区根包（private），只做版本与工作区管理
├── pnpm-workspace.yaml   # 工作区声明，当前为 plugins/*
├── plugins/
│   └── <plugin-name>/    # 插件子包，各自拥有独立 package.json
├── AGENTS.md             # 本文件（CLAUDE.md 是指向它的软链接）
└── README.md
```

- pnpm 11 不读取 `package.json` 里的 `workspaces` 字段，新增子包目录时确认 `pnpm-workspace.yaml` 的 glob 覆盖到它。

## 新增插件

1. 在 `plugins/<plugin-name>/` 下创建子包，`package.json`、入口和构建配置都放在子包内。
2. 回到根目录执行 `pnpm install`，让工作区链接生效。
3. 命令按子包实际 scripts 执行：`pnpm install`、`pnpm -r <script>`、`pnpm --filter <包名> <script>`。

## 约定

- 插件之间不要用相对路径互相引用；需要共享逻辑时抽成新的子包，通过包名依赖。
- 涉及 DSH 插件 API、清单字段、生命周期时，先以本机安装的 DSH 版本核对官方文档（或加载 `dsh-doc` skill），不要凭记忆猜测 API 与兼容版本。
- 提交前至少跑通所改子包的类型检查与构建（子包配置了对应 script 时）。
- 只修改 `AGENTS.md`，不要单独改 `CLAUDE.md`（软链接，保持单一来源）。

## Git 提交格式

遵循 Conventional Commits（团队简化版）。

- 单行：`type: subject`。
- type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`。
- subject：中文一句话，不超过 50 个汉字。
- 破坏性变更：`type!: subject`。

