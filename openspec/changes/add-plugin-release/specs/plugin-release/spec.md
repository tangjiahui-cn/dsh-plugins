# Spec Delta

## Purpose

定义仓库级发布流程对外可观察的行为：官方 npm 源固定、发布前校验、changelog 与 git tag、一键交互发布、多包发布、失败回滚报告、单包撤回，以及发布目标的扩展边界。

## ADDED Requirements

### Requirement: 发布前拒绝未提交的工作区

发布命令 MUST 在调用 registry 写接口前检查工作区：存在已暂存、未暂存或未跟踪的文件时终止，不发布任何包。检查 MUST 覆盖即将进入 tarball 的每个文件，确认其已被 git 跟踪。

#### Scenario: 工作区存在未跟踪文件

- **WHEN** 仓库中存在未被 `.gitignore` 忽略的未跟踪文件
- **THEN** 命令列出这些文件，终止并退出非零，registry 上没有新增版本

#### Scenario: tarball 包含未跟踪文件

- **WHEN** `files` 匹配到某个被 git 忽略或未被 git 跟踪的文件
- **THEN** 命令指出该文件与所属包，终止且不发布

#### Scenario: 工作区干净

- **WHEN** `git status --porcelain` 无输出，且 tarball 内每个文件都由 `git ls-files` 列出
- **THEN** 该检查通过，命令继续执行后续校验

### Requirement: 仓库与发布只使用官方 npm 源

仓库根 MUST 提供 `.npmrc`，把 `registry` 与 `@tjh` scope 固定为 `https://registry.npmjs.org/`，且 MUST NOT 包含认证凭据。发布命令 MUST 在发布前验证根 `.npmrc`、实际生效的 npm 与 pnpm registry、以及 `pnpm-lock.yaml` 中所有 `tarball` 地址都指向官方源；任一不符时终止且不发布。

#### Scenario: 项目配置固定官方源

- **WHEN** 在仓库根执行 `npm config get registry` 与 `pnpm config get registry`
- **THEN** 两者都返回 `https://registry.npmjs.org/`

#### Scenario: 锁文件包含私有 tarball

- **WHEN** `pnpm-lock.yaml` 中任一 `tarball` 地址的主机不是 `registry.npmjs.org`
- **THEN** 命令列出该地址与锁文件路径，终止且不发布

#### Scenario: 环境变量覆盖为私有源

- **WHEN** `NPM_CONFIG_REGISTRY` 或 pnpm 等价配置把生效 registry 指向非官方地址
- **THEN** 命令报告生效值，终止且不发布

#### Scenario: 全部使用官方源

- **WHEN** 根 `.npmrc`、生效 registry 与锁文件 tarball 地址都指向官方源
- **THEN** 该检查通过，命令继续执行后续校验

### Requirement: 可发布子包满足 npm 安装契约

发布前 MUST 校验每个候选子包：名称为 `@tjh/dsh-plugin-*`、版本为合法 semver、未标记 `private`、`files` 覆盖入口与全部运行时文件、`dsh.bundle.patch` 指向存在的文件、导出的 locale 与 icon 文件存在、`publishConfig.access` 为 `public`。任一包校验失败时终止本次发布。

#### Scenario: 子包仍标记 private

- **WHEN** 候选包 `private` 为 `true`
- **THEN** 命令报告该包不可发布并终止，不发布任何包

#### Scenario: files 漏掉运行时文件

- **WHEN** 入口或运行时代码引用的文件未包含在 `files` 中，且未出现在 `npm pack --dry-run` 的文件列表里
- **THEN** 命令报告缺失文件与所属包并终止

#### Scenario: 全部清单合格

- **WHEN** 所有候选包通过清单校验，且 `npm pack --dry-run` 能列出 tarball 内容
- **THEN** 这些包进入发布计划

### Requirement: 一次发布多个子包并按依赖顺序执行

命令 MUST 支持一次发布多个子包；未指定包名时选择全部可发布子包；按本地包之间的 `dependencies` 与 `optionalDependencies` 做拓扑排序；前一个包发布成功后才发布下一个；某个包失败后不发布剩余包。

#### Scenario: 发布全部子包

- **WHEN** 用户执行发布命令且未指定包名
- **THEN** 所有通过校验的子包按拓扑顺序依次发布，报告逐包结果

#### Scenario: 本地依赖决定顺序

- **WHEN** 子包 A 的依赖中包含同仓库子包 B
- **THEN** 发布计划中 B 排在 A 之前

#### Scenario: 中途失败停止后续发布

- **WHEN** 计划中的第 2 个包发布失败
- **THEN** 第 3 个及之后的包保持未尝试状态，命令退出非零

#### Scenario: 指定不存在的包名

- **WHEN** 参数中的包名不属于任何候选子包
- **THEN** 命令列出可用包名并终止，不发布任何包

### Requirement: 写入 registry 前展示发布计划并确认

命令 MUST 在发布前列出每个包的名称、版本、registry 与执行顺序。交互终端 MUST 等待确认后才发布；非交互环境未提供 `--yes` 时 MUST 终止。`--dry-run` MUST 只输出计划并以 0 退出，不调用发布接口。

#### Scenario: dry-run 不产生发布

- **WHEN** 用户以 `--dry-run` 执行
- **THEN** 命令输出完整计划并退出 0，registry 上无新增版本

#### Scenario: 交互确认被拒绝

- **WHEN** 用户在确认提示输入否定
- **THEN** 命令退出且不发布任何包

#### Scenario: 非交互环境缺少 --yes

- **WHEN** 标准输入不是 TTY 且未提供 `--yes`
- **THEN** 命令终止并提示补充 `--yes`

### Requirement: 发布失败生成回滚报告且不自动撤销

任一包发布失败时，命令 MUST 记录已成功、失败、结果不确定与未尝试的包及其 tag 状态，并把机器可读报告与可直接执行的撤销脚本写入 `.tmp/release/<时间戳>/`。撤销脚本 MUST 包含已发布版本的 `npm unpublish` 命令及其 tag 删除命令。命令 MUST NOT 自动调用 `npm unpublish` 或删除 tag。报告 MUST 标注 npm 的 72 小时撤销窗口，以及超出窗口时改用 `npm deprecate` 的替代做法。

#### Scenario: 第一个包即失败

- **WHEN** 发布计划中的第一个包失败，且 registry 上仍查不到该版本
- **THEN** 报告包含失败原因与空的可撤销列表，命令退出非零

#### Scenario: 发布失败但版本已落库

- **WHEN** `npm publish` 以非零状态退出，但随后查询 registry 发现该版本存在
- **THEN** 报告把该包标记为结果不确定，并把它加入撤销命令列表

#### Scenario: 部分成功后失败

- **WHEN** 第 1 个包成功并已打 tag、第 2 个包失败
- **THEN** 报告列出第 1 个包对应的 `npm unpublish <name>@<version>`、`git tag -d <tag>` 与远程 tag 删除命令，且这些命令未被执行

#### Scenario: 撤销脚本仅落盘

- **WHEN** 回滚报告生成完成
- **THEN** 命令打印报告路径与摘要，不调用 registry 的撤销接口，也不删除 tag

### Requirement: 单包撤回先输出影响再确认执行

撤回命令 MUST 校验目标包属于本仓库、目标版本已发布，并输出将执行的 `npm unpublish` 命令、受影响的包与版本、发布时间、tag 与 72 小时窗口判定。只有交互确认或提供 `--yes` 后才执行；执行后 MUST 从 registry 查询确认该版本已不存在，并删除本地 tag、push 远程 tag 删除。tag 不存在时跳过删除。发布时间超过 72 小时时必须拒绝执行，并输出 `npm deprecate` 命令。

#### Scenario: 目标不属于本仓库

- **WHEN** 目标包名不在当前仓库的子包清单中
- **THEN** 命令拒绝执行并列出可撤回的包

#### Scenario: 目标版本未发布

- **WHEN** registry 上不存在该包版本
- **THEN** 命令报告无需撤回并以非零退出

#### Scenario: 用户取消撤回

- **WHEN** 用户在确认提示输入否定
- **THEN** 命令退出且不调用 registry 撤销接口，也不删除 tag

#### Scenario: 确认后撤回成功

- **WHEN** 用户确认撤回，且版本发布时间在 72 小时内
- **THEN** 命令执行 `npm unpublish`，确认版本不可再查询，并删除本地与远程 tag

#### Scenario: tag 不存在

- **WHEN** 目标版本已撤回，但对应 tag 不存在
- **THEN** tag 删除被跳过，撤回仍以成功结束

#### Scenario: 超出撤销窗口

- **WHEN** 目标版本的发布时间超过 72 小时
- **THEN** 命令拒绝撤回，并输出对应的 `npm deprecate` 命令

### Requirement: 子包 changelog 由 git tag 自动生成

`release:changelog` MUST 为每个选中的子包写 `plugins/<目录>/CHANGELOG.md`，提交范围从上一条 `<包名>@<版本>` tag 到 `HEAD`，只包含触及该包目录的非合并提交；范围末尾 MUST 跳过只修改 `package.json` 版本或 `CHANGELOG.md` 的发布提交。每条提交 MUST 按 Conventional Commits 分组：破坏性变更、新功能、修复、性能、重构、文档、测试、维护；条目包含 subject 与短 hash。文件 MUST 保留旧版本段落、替换当前版本段落；无新提交时 MUST 不修改文件并报告。首版没有 tag 时 MUST 使用该包目录的全部提交。

#### Scenario: 首次生成

- **WHEN** 子包没有任何 `<包名>@<版本>` tag
- **THEN** changelog 使用该包目录下的全部非合并提交

#### Scenario: 后续生成

- **WHEN** 子包已有上一条 tag
- **THEN** changelog 只使用该 tag 到 `HEAD` 之间触及该包目录的提交

#### Scenario: 发布提交被跳过

- **WHEN** 范围末尾存在只修改 `package.json` 版本或 `CHANGELOG.md` 的提交
- **THEN** 这些提交不进入 changelog 条目

#### Scenario: 重跑不重复

- **WHEN** 同一版本连续执行两次 `release:changelog` 且提交未变化
- **THEN** 当前版本文本不变，旧版本段落保留

#### Scenario: 非约定提交

- **WHEN** 提交 subject 不匹配 Conventional Commits
- **THEN** 该条归入「维护」，不丢条目

#### Scenario: 没有新提交

- **WHEN** 当前 tag 到 `HEAD` 之间没有触及该包目录的提交
- **THEN** 命令不修改 changelog，并报告没有可写入的提交

### Requirement: 发布前校验 changelog 与 tag

`release:publish` MUST 在写入 registry 前确认：`CHANGELOG.md` 在 tarball 内，且按当前 tag 范围重新渲染的当前版本段落与文件内容一致；重渲染 MUST 从范围末尾排除只修改 `package.json` 版本或 `CHANGELOG.md` 的发布提交，避免发布提交进入自身 changelog。tag `<包名>@<版本>` 在本地与 `origin` 都不存在；`origin` 可访问。任一不符 MUST 终止且不发布。

#### Scenario: changelog 缺失

- **WHEN** 子包没有 `CHANGELOG.md` 或文件未进入 tarball
- **THEN** 命令报告缺失并提示先执行 `release:changelog`

#### Scenario: changelog 缺少当前版本

- **WHEN** `CHANGELOG.md` 没有 `## <当前版本>` 段落
- **THEN** 命令终止，不发布

#### Scenario: changelog 与提交不一致

- **WHEN** 按当前 tag 范围重新渲染的当前版本段落与文件内容不一致
- **THEN** 命令终止，要求重跑 `release:changelog`

#### Scenario: 发布提交不进入 changelog

- **WHEN** 范围末尾存在只修改 `package.json` 版本或 `CHANGELOG.md` 的发布提交
- **THEN** 重新渲染跳过这些提交，发布提交本身不产生 changelog 条目

#### Scenario: tag 已存在

- **WHEN** tag 在本地或 `origin` 已存在
- **THEN** 命令报告冲突 tag，终止且不发布

#### Scenario: 全部通过

- **WHEN** changelog、tag 与 origin 检查都通过
- **THEN** 命令继续执行发布

### Requirement: 发布成功后创建并推送子包 tag

每个包发布成功后，命令 MUST 在发布前记录的 `releaseCommit` 创建 annotated tag `<包名>@<版本>`，消息为同名，并 push 到 `origin`；tag MUST NOT 默认指向 push 时的当前 `HEAD`。push 失败时 MUST 最多重试 2 次；仍失败 MUST 停止后续包、写入报告并退出非零。

#### Scenario: 发布成功并打 tag

- **WHEN** 包发布成功且 origin 可写
- **THEN** 本地与 origin 都存在指向 `releaseCommit` 的 annotated tag

#### Scenario: 发布期间 HEAD 前进

- **WHEN** 发布命令执行期间本地 `HEAD` 已不是发布时的提交
- **THEN** tag 仍指向发布前记录的 `releaseCommit`

#### Scenario: tag 推送失败

- **WHEN** 发布成功但 tag push 重试 2 次后仍失败
- **THEN** 报告记录 tag 错误、命令退出非零，后续包标记为未尝试

### Requirement: 一键发布进入交互流程

`release` MUST 在单个命令内完成：读取并清理陈旧临时状态、发现并选择子包、逐包询问版本、生成 changelog、提交版本与 changelog、预检、展示计划并确认、发布、创建并推送 tag、写报告。开始前 MUST 要求工作区干净；提交 MUST 只包含本次生成的版本号与 `CHANGELOG.md`。每个关键步骤 MUST 写入 `.tmp/release/session.json`；成功发布后 MUST 删除 session；在发布确认处取消时 MUST 保留 session 并标记为 `cancelled`，供 `release:clean` 撤回。对 registry 上已存在的版本 MUST 跳过发布、不重写 changelog，并按 `release:tag` 的 commit 解析与 tag 状态规则补建缺失的 tag，不得默认使用 `HEAD`。已发布版本缺 changelog 时 MUST 完成 tag 修复并在报告中告警；本次新发布版本缺 changelog 时 MUST 在发布前失败。

#### Scenario: 单包一键发布

- **WHEN** 用户执行 `pnpm release` 并选择单个子包
- **THEN** 命令询问版本、生成 changelog、提交、发布并推送 tag，结束时删除 session

#### Scenario: 多包逐个询问

- **WHEN** 用户选择多个子包
- **THEN** 每个包分别询问版本，changelog 与提交按包生成

#### Scenario: 版本已发布但缺 tag

- **WHEN** 当前版本已在 registry 存在但 tag 缺失，且 session 或 `gitHead` 能确定发布 commit
- **THEN** 命令跳过重新发布，在发布 commit 上补建并推送 tag

#### Scenario: 已发布版本无法确定 commit

- **WHEN** 版本已发布但 session、`gitHead` 与 `--at` 都没有提供目标 commit
- **THEN** 命令停止并报告需要人工指定，不使用 `HEAD`

#### Scenario: 已发布版本缺 changelog

- **WHEN** 已发布版本的目标 commit 没有 `CHANGELOG.md`
- **THEN** 命令完成 tag 修复，报告中标记 `changelogMissing`，不重新发布

#### Scenario: 用户取消

- **WHEN** 用户在发布确认处取消
- **THEN** 命令不调用发布接口，保留 `cancelled` session，供 `release:clean` 恢复发布前快照

#### Scenario: 初始工作区不干净

- **WHEN** 开始执行时存在未提交改动
- **THEN** 命令终止，不写版本号、不生成 changelog、不发布

### Requirement: release:clean 恢复到发布前快照

`release:clean` MUST 读取 session 的 `baseHead`、`releaseCommit`、包与生成文件列表，把本地状态恢复到本次 release 开始前的 `baseHead`。执行前 MUST 确认所有 release 包版本都未发布、tag 都不存在；任一已发布或 tag 已存在时 MUST 拒绝，提示先执行 `release:withdraw`。`HEAD` 必须是 `baseHead` 或 `releaseCommit`；存在额外提交或生成文件之外的未提交改动时 MUST 拒绝。`HEAD` 等于 `releaseCommit` 时 MUST `git reset --hard baseHead`；等于 `baseHead` 时 MUST 只恢复 hash 匹配的生成文件。完成后 MUST 删除 session、临时目录与锁，并保留历史报告和 `npm-cache`。没有 session 时 MUST 只清理临时状态，并以 0 退出。

#### Scenario: 取消后清理恢复快照

- **WHEN** 用户在发布确认处取消，随后执行 `pnpm release:clean`，且版本未发布、tag 不存在
- **THEN** 命令把 `HEAD` 恢复到 `baseHead`，删除 release 提交与临时状态

#### Scenario: 已发布版本拒绝清理

- **WHEN** session 中任一包版本已发布或 tag 已存在
- **THEN** 命令拒绝 `git reset`，提示先 `release:withdraw`

#### Scenario: 存在额外提交或改动

- **WHEN** 当前 `HEAD` 既不是 `baseHead` 也不是 `releaseCommit`，或工作区有生成文件之外的改动
- **THEN** 命令拒绝清理并列出冲突，不修改 git 历史

#### Scenario: 提交前中断

- **WHEN** session 的 `releaseCommit` 为空、`HEAD` 等于 `baseHead` 且生成文件 hash 匹配
- **THEN** 命令恢复生成文件并删除 session

#### Scenario: 没有 session

- **WHEN** 不存在 session
- **THEN** `pnpm release:clean` 只清理临时目录与陈旧锁，以 0 退出

### Requirement: 已发布版本可修复缺失 tag

`release:tag` MUST 接受 `<包名>@<版本>` 与可选 `--at <commit>`。目标 commit MUST 按 session 的 `releaseCommit`、npm 的 `gitHead`、显式 `--at` 的顺序解析；三者都不可用时 MUST 终止，不得默认使用 `HEAD`。目标 commit MUST 在本地存在，且其 `package.json` 版本等于已发布版本。Tag 状态 MUST 按以下规则处理：本地与远程都没有时创建并 push；只有本地时校验后 push；只有远程时 fetch 校验后视为完成；两边都有时校验一致；任何不一致 MUST 终止且不 force。

#### Scenario: 用 session 定位发布 commit

- **WHEN** 版本已发布且 session 记录了 `releaseCommit`
- **THEN** tag 创建在该 commit，并与本地 `package.json` 版本核对

#### Scenario: 用 gitHead 定位发布 commit

- **WHEN** session 不存在但 npm registry 的 `gitHead` 存在
- **THEN** tag 创建在 `gitHead` 指向的 commit

#### Scenario: 无法定位发布 commit

- **WHEN** session、`gitHead` 与 `--at` 都不可用
- **THEN** 命令终止，输出需要 `--at <commit>` 的提示，不使用 `HEAD`

#### Scenario: 只有本地 tag

- **WHEN** 本地 tag 存在且指向发布 commit，远程不存在
- **THEN** 命令 push 该 tag

#### Scenario: 只有远程 tag

- **WHEN** 远程 tag 存在且指向发布 commit，本地不存在
- **THEN** 命令 fetch 并校验后视为完成

#### Scenario: 本地与远程 tag 都已存在

- **WHEN** 本地与远程 tag 都存在且都指向发布 commit
- **THEN** 命令只做校验并以 0 结束，不重复 push

#### Scenario: tag 指向冲突

- **WHEN** 本地或远程 tag 指向的不是发布 commit
- **THEN** 命令终止，不 force、不移动 tag

#### Scenario: 版本号与目标 commit 不一致

- **WHEN** 目标 commit 的 `package.json` 版本不等于已发布版本
- **THEN** 命令拒绝补 tag，说明发布时工作区可能未提交

#### Scenario: 已发布版本缺 changelog

- **WHEN** 目标 commit 没有 `CHANGELOG.md`
- **THEN** 命令完成 tag 修复，报告中标记 `changelogMissing`，并以 0 结束

### Requirement: 发布命令互斥

`release`、`release:publish`、`release:changelog`、`release:tag` 与 `release:withdraw` MUST 在写文件、registry 或 git ref 前获取 `.tmp/release/lock`；锁记录 pid、命令与开始时间。已有存活进程持锁时 MUST 终止；陈旧锁 MUST 由下一次 `release` 启动清理或 `release:clean` 清除。命令结束 MUST 释放锁。

#### Scenario: 并发发布被拒绝

- **WHEN** 另一个发布命令正持有 lock
- **THEN** 新命令终止并报告持锁进程，不写文件、不发布

#### Scenario: 陈旧锁

- **WHEN** lock 记录的 pid 已不存在
- **THEN** 下一次 `release` 清除陈旧锁并继续，或由 `release:clean` 清除

#### Scenario: 清理锁

- **WHEN** 用户执行 `release:clean`
- **THEN** 陈旧 lock、session 与临时目录被删除

#### Scenario: 正常释放

- **WHEN** 命令成功或失败退出
- **THEN** 它持有的 lock 被删除

### Requirement: 发布目标通过适配器扩展

发布编排 MUST 通过发布目标适配器访问 registry；当前只实现 npm。新增插件市场时 MUST 只新增适配器，发布前校验、顺序编排、确认与报告逻辑保持不变。未知目标 MUST 被拒绝并列出可用目标。

#### Scenario: 默认使用 npm 目标

- **WHEN** 用户未指定目标
- **THEN** 命令使用 npm 适配器，registry 为 `https://registry.npmjs.org/`

#### Scenario: 指定未知目标

- **WHEN** 用户指定未注册的目标名
- **THEN** 命令终止并列出可用目标

### Requirement: 发布成功输出可核对的报告

所有目标包发布成功后，命令 MUST 输出每个包名、版本、tarball 完整性值、registry URL、tag 名称与 tag push 状态，并把同样的结果写入报告目录；全部成功时以 0 退出。

#### Scenario: 全部发布成功

- **WHEN** 计划中的每个包都发布成功且 tag 已推送
- **THEN** 命令输出逐包结果、tag 与报告路径，退出 0
