# Proposal

## Why

仓库目前没有发布入口。`plugins/useage` 仍标记 `private`，`files` 漏掉运行时依赖的 `today.js`，直接执行 `npm publish` 会得到一个安装后报错的包。本机 npm 与 pnpm 的默认 registry 是私有镜像，`pnpm-lock.yaml` 也固定了私有源的 tarball 地址，安装与发布可能落到非官方源。发布只写 registry 时，版本与提交、变更记录之间没有可追溯关系；中断后也没有可清理的临时状态，只能重新拼分步命令。要让子包以 npm 包被 DSH 安装、让每个版本可追溯到提交与变更记录，并为后续插件市场预留通道，需要一条可重复、来源固定、发布前可校验、单命令可完成、失败后可定位的发布流程。发布工具属于仓库级设施，不新增子包。

## What Changes

- 新增仓库级发布工具 `scripts/release/`，在根 `package.json` 注册 `release:*` 命令。
- 新增 `release:changelog`：按子包上一条 git tag 到 `HEAD` 的提交生成 `plugins/<目录>/CHANGELOG.md`；首版没有 tag 时使用该包目录的全部提交。
- 新增 `release` 一键交互流程：清理陈旧临时状态、选择子包、逐包询问版本、生成 changelog、提交版本与 changelog、预检、确认、发布、创建并推送 tag、写报告。
- 新增 `release:clean`：按 session 把本地恢复到本次发布开始前的提交与文件；版本已发布或 tag 已存在时拒绝并提示 `release:withdraw`；无 session 时只清临时目录与陈旧 lock。
- 新增 `release:tag`：为已发布版本补建或修复 tag；目标 commit 按 session、npm `gitHead`、`--at` 顺序解析，不默认使用 HEAD。
- `release:publish` 保留为低层命令，发布前校验 changelog 内容与当前 tag 范围一致、tag 在本地与 origin 都不存在；发布成功后按发布前记录的 commit 创建 annotated tag 并 push 到 origin。
- 发布失败报告与 `release:withdraw` 同步输出或执行 tag 删除命令；已发布版本缺 changelog 时只补 tag 并标记 `changelogMissing`，不重发同版本。
- 所有写发布状态、registry 或 git ref 的命令使用 `.tmp/release/lock` 互斥。
- 根目录新增 `.npmrc`，把 `registry` 与 `@tjhaaa` scope 固定到 `https://registry.npmjs.org/`；重新生成 `pnpm-lock.yaml`，清除私有镜像的 tarball 地址。
- 发布前强制校验：git 工作区无未提交改动；tarball 内每个文件都被 git 跟踪；包清单满足 npm 安装要求；实际生效的 npm/pnpm registry 与锁文件都只指向官方源。
- 一次发布多个子包：默认发布全部可发布子包，支持按包名选择，按本地依赖拓扑排序，失败即停。
- 发布计划先展示，确认后执行；支持 `--dry-run` 只输出计划。
- 发布失败生成回滚报告：已发布、失败、未尝试的包，以及可直接执行的 `npm unpublish` 与 tag 删除命令。工具不自动撤销。
- 新增单包撤回命令：校验版本归属与已发布状态，输出影响清单；确认后执行 `npm unpublish` 并删除 tag。
- 发布目标抽象为适配器，当前实现 npm；后续插件市场实现同一接口即可接入。
- 修正 `plugins/useage/package.json`：移除 `private`，补 `files` 的 `today.js` 与 `CHANGELOG.md`，补 `license`、`repository`、`publishConfig`、`keywords`。
- 根 `README.md` 增加 npm 安装说明与简版发布命令。

## Capabilities

### New Capabilities

- `plugin-release`: 仓库级发布流程的官方源固定、发布前校验、changelog 生成、git tag、一键交互发布、多包发布、失败回滚报告、单包撤回与发布目标扩展。

### Modified Capabilities

（无）

## Impact

- 根 `package.json`：新增 `release`、`release:publish`、`release:changelog`、`release:tag`、`release:clean`、`release:plan`、`release:withdraw` 命令。
- 根 `.npmrc`：固定官方 npm 源，不含凭据。
- `pnpm-lock.yaml`：重新生成，移除私有镜像的 tarball 地址。
- 新增 `scripts/release/`：发布编排、npm 适配器、changelog、git tag、交互流程、session 恢复、发布锁、校验与报告。
- `plugins/useage/package.json` 与 `plugins/useage/CHANGELOG.md`：清单与首版变更记录，版本 `0.1.0` 首次发布。
- 根 `README.md`：安装说明与简版发布命令。
- 依赖：只使用 Node 内置模块与 npm/pnpm/git 命令，不新增运行时依赖。
- registry 固定为 `https://registry.npmjs.org/`；npm 缓存指向 `.tmp/release/npm-cache`，避开本机默认私有 registry 与 root 权限缓存。
- git tag 使用 `<包名>@<版本>`，annotated，并在发布成功后 push 到 `origin`；需要 origin 的写权限。
- npm 版本发布后不可覆盖；撤销依赖 `npm unpublish` 的 72 小时窗口，超出窗口只能 `npm deprecate`。
