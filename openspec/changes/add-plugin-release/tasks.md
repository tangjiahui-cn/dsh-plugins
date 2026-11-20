# Tasks

## 1. 发布入口与配置

- [x] 1.1 建立 `scripts/release/config.mjs` 与 `cli.mjs`：registry、npm 缓存目录、子包 glob、报告根目录集中配置；解析 `publish` / `withdraw` 子命令与 `--package`、`--dry-run`、`--yes`、`--otp`、`--target`、`--skip-checks`、`--report-dir`。验证：`node scripts/release/cli.mjs --help` 退出 0 并列出全部参数，未知子命令退出非零。
- [x] 1.2 在根 `package.json` 增加 `release`、`release:publish`、`release:plan`、`release:withdraw` 命令。验证：`pnpm run release:plan -- --help` 与 `pnpm run release:publish -- --help` 退出 0，输出包含发布参数说明。
- [x] 1.3 创建根 `.npmrc`，写入 `registry=https://registry.npmjs.org/` 与 `@tjh:registry=https://registry.npmjs.org/`，不写 token。验证：在仓库根执行 `npm config get registry` 与 `pnpm config get registry` 都返回 `https://registry.npmjs.org/`，且 `git check-ignore -v .npmrc` 不命中忽略规则。
- [x] 1.4 重新生成 `pnpm-lock.yaml`：删除现有锁文件后在仓库根执行 `pnpm install`。验证：锁文件中所有 `tarball` 地址的主机都是 `registry.npmjs.org`，`grep -Eo 'tarball: https?://[^/]+' pnpm-lock.yaml | grep -v 'registry.npmjs.org'` 无输出，`pnpm install --frozen-lockfile` 通过；版本若变化，重跑 `plugins/useage` 的 check 与 test。

## 2. 子包发现、清单校验与 useage 可发布

- [x] 2.1 实现 `packages.mjs`：从 `plugins/*/package.json` 发现候选包、按 `--package` 过滤、用本地 `dependencies` / `optionalDependencies` 做稳定拓扑排序，未知包名与依赖环报错；同时增加根 `test:release` 命令。验证：`pnpm test:release` 运行 `scripts/release/test/` 下的 `.test.mjs`，顺序、未知包、环三个用例通过。
- [x] 2.2 实现清单校验：名称前缀、semver、非 `private`、`files` 非空、`license` 与 `LICENSE` 文件、`repository`、`publishConfig.access` 与 registry、`dsh.bundle.patch`、`exports` 目标存在。验证：单测逐项构造失败包，断言错误文本包含包名与失败字段。
- [x] 2.3 修正 `plugins/useage/package.json`：移除 `private`，`files` 加入 `today.js` 与 `LICENSE`，补 `license`、`repository`、`keywords`、`publishConfig`；新增根 `LICENSE` 与 `plugins/useage/LICENSE`（同一份 MIT 文本）。验证：`npm pack --dry-run --json --cache .tmp/release/npm-cache` 的文件列表含 `today.js` 与 `LICENSE`，且 manifest 不再出现 `private`。
- [x] 2.4 更新 `plugins/useage/README.md` 的安装段落，写清从 npm 安装的两种方式与已验证的 DSH 版本。验证：安装命令中的包名与 `package.json` 的 `name` 一致，DSH 版本与 README 验证表一致。

## 3. 打包内容与已提交校验

- [x] 3.1 实现 `git.mjs`：解析 `git status --porcelain --untracked-files=all`，并要求 tarball 内每个路径由 `git ls-files --error-unmatch` 命中。验证：临时 git 仓库用例覆盖未跟踪、已暂存、被忽略但被打入 tarball 三种失败，以及干净仓库通过。
- [x] 3.2 实现 `pack.mjs`：调用 `npm pack --dry-run --json --cache <隔离缓存>`，校验 `exports` 目标、`dsh.bundle.patch`、locale、icon 在文件列表内，并从 tarball 内的 `.js` 递归解析字面量相对导入。验证：测试夹具故意漏掉被导入文件时失败；真实 `plugins/useage` 通过，且 2.3 之前漏掉 `today.js` 的清单会被同一检查判失败。
- [x] 3.3 实现检查脚本阶段：对每个包执行 `pnpm --filter <name> run --if-present check` 与 `test`，失败即终止；`--skip-checks` 只跳过该阶段。验证：单测注入退出非零的检查命令，断言预检抛错且不产出可发布计划。
- [x] 3.4 实现官方源预检：解析根 `.npmrc` 的 `registry` 与 `@tjh:registry`，在仓库根执行 `npm config get registry` 与 `pnpm config get registry`，扫描 `pnpm-lock.yaml` 的 `tarball` 地址；任一不等于 `https://registry.npmjs.org/` 或主机不是 `registry.npmjs.org` 时终止并输出实际值。验证：单测覆盖 `.npmrc` 缺失、地址错误、环境变量覆盖、锁文件私有地址四种失败，以及全部合规时通过。

## 4. npm 目标适配器

- [x] 4.1 建立 `targets/index.mjs` 与目标接口：`getTarget(id)` 返回适配器，未知目标报错并列出可用目标；默认 `npm`。验证：单测断言未知目标的错误文本与默认目标。
- [x] 4.2 实现 npm 适配器的 `checkAuth` 与 `inspectVersion`：`npm whoami` 与 `npm view <name>@<version> version` 显式传 registry 与隔离缓存；E404 映射为 `absent`，已发布返回版本与发布时间，其他错误保留 stderr。验证：假 npm 单测覆盖 E404、已存在、认证失败三种返回，并断言参数含 registry 与 cache。
- [x] 4.3 实现 npm 适配器的 `publish`、`withdrawPlan` 与 `withdraw`：`publish` 在包目录执行 `npm publish --access public --registry ... --cache ... --json` 并解析 `integrity` 与 URL；`withdrawPlan` 读取发布时间，72 小时内给出 `npm unpublish ... --force` 命令，超出窗口给出 `npm deprecate` 命令；`withdraw` 只执行计划内命令。验证：假 npm 单测断言 publish 参数、JSON 解析、窗口内与窗口外两条撤回计划、`withdraw` 只调用一次 `unpublish`。
- [x] 4.4 编写 `scripts/release/README.md`，记录适配器接口、新增市场的接入步骤与 npm 目标限制。验证：README 中的接口字段与 `targets/npm.mjs` 实际导出逐项一致。

## 5. 发布编排

- [x] 5.1 实现发布计划输出与确认：打印名称、版本、registry、顺序；TTY 下要求输入 `y`，非 TTY 缺少 `--yes` 时终止；`--dry-run` 只打印计划并退出 0。验证：单测覆盖确认、拒绝、非 TTY、dry-run 四条路径，断言 dry-run 后假 npm 没有 `publish` 调用。
- [x] 5.2 实现顺序发布与失败对账：逐个包调用适配器 `publish`，前一个成功后继续，失败即停；失败后查询一次该版本，区分 `failed`、`published-uncertain`、`unknown`；返回包含包名、版本、状态、`integrity`、URL 的结构化结果。验证：假 npm 测试断言调用顺序与包目录，失败后剩余包没有调用，并覆盖“退出非零但版本已存在”的用例。

## 6. 发布报告与失败回滚

- [x] 6.1 实现 `report.mjs` 的成功路径：写出 `report.json` 与 `summary.md`，包含目标、registry、计划、逐包结果、`integrity` 与 URL。验证：单测断言 JSON 字段与摘要中的包名、版本、registry。
- [x] 6.2 实现 `rollback.sh` 生成：命令包含已成功发布与 `published-uncertain` 的版本，带 `set -euo pipefail` 与 72 小时说明，文件权限 0755，生成过程不调用撤销接口。验证：单测断言脚本内容、权限与未执行标记。
- [x] 6.3 接入失败路径：任一包失败时停止后续发布、写报告、打印报告路径与 72 小时说明、退出非零。验证：三包计划中第 2 个失败的测试，断言第 3 个未调用、报告列出第 1 个包的 `npm unpublish` 命令、`rollback.sh` 未被执行。
- [x] 6.4 确认报告目录不进入版本库。验证：`git check-ignore -v .tmp/release/<任意时间戳>/report.json` 命中 `.tmp/` 规则。

## 7. 单包撤回

- [x] 7.1 实现 `withdraw.mjs` 的目标解析与归属校验：支持 scoped 包名，只接受当前仓库候选包，版本必须出现在适配器的发布时间查询中。验证：单测覆盖合法、非本仓库、未发布三种输入。
- [x] 7.2 实现影响清单与确认：打印版本、发布时间、dist-tag 与 lockfile 影响；要求输入完整 `<name>@<version>`，`--yes` 跳过。验证：单测断言取消时没有调用 `npm unpublish`，确认时命令参数与适配器计划一致。
- [x] 7.3 实现执行与复核：确认后调用适配器 `withdraw`，再轮询 `npm view` 最多 3 次，E404 视为成功，仍可查询则以非零退出。验证：假 npm 测试覆盖确认成功、撤回后仍可查询两条路径。

## 8. 集成与文档

- [x] 8.1 更新根 `README.md`：增加用户安装段与维护者发布段（`release:plan`、`release:publish`、`release:withdraw`），注明仓库 `.npmrc` 固定官方源、需要 npmjs 登录、72 小时撤销窗口，以及 DSH profile 需能解析官方包。验证：README 中每条命令的参数都能在 `node scripts/release/cli.mjs --help` 中找到，安装包名与 `plugins/useage/package.json` 一致。
- [x] 8.2 运行完整计划：`pnpm release:plan` 输出只含 `@tjh/dsh-plugin-useage@0.1.0`、顺序为 1、registry 为 npmjs；同时确认 `today.js` 已在 tarball 检查中列出。验证：命令退出 0，输出与上述三项逐项匹配。
- [x] 8.3 用假 npm 跑通双包成功与中途失败两条端到端路径，检查退出码、报告文件与未执行包。验证：`pnpm test:release` 全绿，且两条路径的临时报告目录包含预期文件。

## 9. Changelog 与 tag 基础

- [x] 9.1 实现 `tags.mjs`：tag 名为 `<包名>@<版本>`，检查本地与 origin 是否存在、创建 annotated tag、push、删除本地与远程 tag；git 命令可注入。验证：临时 bare remote 测试覆盖不存在、创建并 push、重复 tag、push 失败、删除成功与 tag 缺失五种情况。
- [x] 9.2 实现 `changelog.mjs` 的提交采集与分类：用 `git describe` 找上一条 `<包名>@*` tag，取该 tag 到 HEAD 之间触及包目录的非合并提交；从范围末尾跳过只修改 `package.json` 版本或 `CHANGELOG.md` 的发布提交（可连续）；解析 Conventional Commits，分组为破坏性变更、新功能、修复、性能、重构、文档、测试、维护。验证：单测覆盖首版无 tag、后续有 tag、非约定提交、merge 被排除、发布提交被跳过五种输入。
- [x] 9.3 实现 changelog 文件写入：`plugins/<目录>/CHANGELOG.md`，保留旧版本段落、替换当前版本段落，日期使用 `Asia/Shanghai`，重跑幂等；没有新提交时不改文件。验证：单测断言段落顺序、旧段落保留、重复执行内容不变、无提交时文件 mtime 不变。
- [x] 9.4 实现 `release:tag` 的 commit 解析与状态机：按 session `releaseCommit` → npm `gitHead` → `--at` 解析目标；都不可用时拒绝，不默认 HEAD；校验目标 commit 的 package.json 版本；处理 none/local-only/remote-only/both/conflict 五种状态，任何冲突不 force。验证：临时 bare remote 测试覆盖 session、gitHead、无目标、只有本地、只有远程、指向冲突、版本不一致七种情况。
- [x] 9.5 扩展 npm 适配器的 `inspectVersion`：查询 `gitHead`，存在时返回 commit，缺失时返回 null；现有调用方保持兼容。验证：假 npm 单测覆盖有 `gitHead`、无 `gitHead`、版本不存在三种返回。

## 10. 命令与发布集成

- [x] 10.1 增加 CLI 命令 `changelog`、`tag` 与 `clean`；`tag` 接受 `<name>@<version>` 与 `--at <commit>`；根 `package.json` 注册 `release:changelog`、`release:tag`、`release:clean`，并把 `release` 指向一键流程。验证：`node scripts/release/cli.mjs --help` 列出新命令，`release:changelog -- --help`、`release:tag -- --help` 与 `release:clean -- --help` 退出 0。
- [x] 10.2 `release:publish` 预检加入 changelog 与 tag：changelog 在 tarball 内且按当前 tag 范围重新渲染的当前段落与文件一致；重渲染跳过末尾只改 package.json 版本或 CHANGELOG.md 的发布提交；tag 在本地与 origin 都不存在；origin 可访问。验证：单测覆盖缺失 changelog、缺少当前版本、内容不一致、发布提交被跳过、版本与 changelog 分开提交仍能比较、本地 tag、远程 tag、origin 不可用八种情况，以及全部通过。
- [x] 10.3 发布成功后创建并 push tag：发布前记录 `releaseCommit`，每个包成功后在该 commit 打 annotated tag 并 push；push 最多重试 2 次，仍失败停止后续包，结果标记 tag 失败并退出非零。验证：临时 bare remote 测试断言 tag 指向 `releaseCommit`、远程存在；push 失败时后续包未调用 publish。
- [x] 10.4 失败报告与撤回同步 tag：回滚命令包含 `git tag -d` 与远程 tag 删除；报告记录 `releaseCommit`、`changelogMissing`；`release:withdraw` 在 unpublish 成功后删除本地与远程 tag，tag 缺失时跳过。验证：单测断言报告命令顺序与 changelogMissing 字段；撤回测试覆盖 tag 存在、tag 缺失、远程删除失败。
- [x] 10.5 实现 `release` 一键流程：读取并清理陈旧状态、获取 lock、检查干净工作区、分类已完成/只补 tag/冲突/未发布、逐包询问版本、生成 changelog、只提交版本与 changelog、预检、确认、发布、按 `releaseCommit` 打 tag。验证：假 TTY 测试覆盖单包、多包、取消、已发布只补 tag、无法定位发布 commit、初始工作区不干净六条路径。
- [x] 10.6 实现 session 与清理：运行中写 `.tmp/release/session.json`，记录 `baseHead`、`releaseCommit`、生成文件 hash 与结果；获取锁后读取 session，hash 与 HEAD 匹配则恢复提交前文件，否则停止；成功删除 session。`release:clean` 只删状态，不改工作区，不删报告与 npm 缓存。验证：单测断言中断后 session 存在、匹配时恢复、不匹配时停止、clean 幂等、报告与缓存保留。
- [x] 10.7 更新现有测试与端到端夹具，为临时仓库配置 bare origin、预置 tag 与 changelog。验证：`pnpm test:release` 全绿，成功与失败两条端到端路径都覆盖 tag 创建与回滚命令。
- [x] 10.8 实现发布锁：`.tmp/release/lock` 记录 pid、命令、开始时间；`release`、`publish`、`changelog`、`tag`、`withdraw` 获取并释放；存活进程冲突时拒绝，陈旧锁由下一次 `release` 或 `release:clean` 清除。验证：单测覆盖并发拒绝、陈旧锁自动清除、clean 清除、正常退出释放。
- [x] 10.9 处理已发布缺 changelog：在目标 commit 检查 `CHANGELOG.md` 与 `files`；缺失时仍补 tag，报告 `changelogMissing`，tag 命令以 0 结束并告警；新版本发布仍在预检失败。验证：单测覆盖历史版本缺 changelog 的 tag 修复、报告字段与新版本阻断。

## 11. 包与文档

- [x] 11.1 把 `CHANGELOG.md` 加入 `plugins/useage/package.json` 的 `files`，用 `release:changelog` 生成 0.1.0 首版段落。验证：`npm pack --dry-run --json` 列出 `CHANGELOG.md`，内容包含 `## 0.1.0` 与三个触及该包的提交。
- [x] 11.2 更新根 `README.md` 发布段：保留简版 `pnpm release:changelog` 与 `pnpm release`（或 `release:publish`）命令和关键步骤。`scripts/release/README.md` 只补新模块表（`changelog.mjs`、`tags.mjs`、`flow.mjs`、`session.mjs`），不写发布步骤。验证：README 中命令都能在 `node scripts/release/cli.mjs --help` 找到，包名与 `package.json` 一致；模块表与实际文件一致。
- [x] 11.3 集成验证：`pnpm release:plan` 输出 changelog 与 tag 状态；`pnpm release:clean` 删除 session/陈旧 lock 且保留报告；在临时 bare remote 上跑通一键流程与已发布缺 tag 修复。验证：`pnpm test:release` 全绿，`pnpm release:plan` 退出 0。

## Workflow follow-up

- 在 npmjs 登录、确认 `@tjh` scope 发布权限与 origin 写权限后执行 `pnpm release`，完成版本询问、changelog 提交、发布与 tag 推送。
- 确认 npm registry 上有版本，本地与 origin 上有对应 tag；在干净的 DSH profile 中安装该版本，确认插件行、标题行胶囊与弹窗可用。
- 按项目评审要求归档本 change，并复核归档后的 `plugin-release` 主 spec。
