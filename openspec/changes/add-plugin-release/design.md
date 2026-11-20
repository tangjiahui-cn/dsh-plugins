# Design

## Context

- 仓库是 pnpm 11 / Node 24 monorepo，根包 `private`，子包位于 `plugins/*`，当前只有 `plugins/useage`。发布工具需要读遍所有子包，但不属于其中任何一个。
- `plugins/useage/package.json` 当前 `private: true`，`files` 未包含 `today.js`。`npm pack --dry-run --json` 实测 tarball 只有 11 个文件，`index.js` 的 `./today.js` 导入在安装后会失败。
- 仓库当前没有 git tag，也没有子包 `CHANGELOG.md`；触及 `plugins/useage` 的提交有 3 个。发布要求工作区干净，因此 changelog 必须在提交前生成，不能放进发布命令。
- 现有发布命令只有 `release:publish`；没有交互式流程，中断后没有可清理的状态文件。
- 本机 npm 11.19 与 pnpm 11.26 的默认 registry 都指向非官方私有镜像，具体地址不写入仓库文档；`~/.npm` 缓存还有 root 权限文件，`npm pack` 直接报 `EPERM`。`pnpm-lock.yaml` 中 3 个包的 `tarball` 地址也指向该私有镜像，仅改 registry 不会清除它们。
- 官方 npm 当前提供锁文件里全部依赖的相同版本：`@deepseek-ai/schemastery@3.19.0`、`@deepseek-ai/cosmokit@1.9.0`、`@standard-schema/spec@1.1.0`、`zod@4.6.7`，因此可以切到官方源后重新生成锁文件。
- DSH 的插件管理器通过 pnpm 从 registry 安装 bundle；安装契约见 `dsh-doc` 的 `host-plugin.md`：`dsh.bundle.patch`、导出的 locale/icon、`files` 覆盖运行文件。发布工具不替代安装器，只保证包满足该契约。
- 现有 spec 只有 `conversation-cost`，没有发布相关能力。

## Goals / Non-Goals

**Goals:**

- 在仓库根提供可重复的发布入口，不新增 workspace 子包。
- 仓库内的安装与发布只访问 `https://registry.npmjs.org/`，不落回私有镜像。
- 把“可安装”与“已提交”变成发布前可机械判定的条件，而不是发布说明里的提醒。
- 多包发布有确定的顺序、失败边界和可核对的报告。
- 每个发布版本有对应的 changelog 段落与可追溯的 git tag。
- 一条命令完成从版本询问到 tag 推送的交互流程，中断后可清理重来。
- 为后续插件市场留出适配器接口，当前只实现 npm。

**Non-Goals:**

- 自动决定版本号；一键流程只询问并应用操作者选择的版本。
- 搭建 CI 发布流水线；`release:publish --yes` 可供 CI 调用，流水线配置不在本次范围。
- 创建 GitHub Release 或发布到 npm 之外的插件市场。
- 为仓库根生成 changelog；只生成各子包的 `CHANGELOG.md`。
- 支持私有 registry 或多 registry 回退。
- 配置用户级 `~/.npmrc` 或 DSH profile 的 registry；仓库根 `.npmrc` 只作用于本仓库内执行的命令。
- 自动执行 `npm unpublish`；失败回滚只落盘命令。

## Decisions

### 1. 工具放仓库根 `scripts/release/`，不建子包

工具用 Node ESM 编写，入口 `scripts/release/cli.mjs`，根 `package.json` 只增加命令映射：

```json
"release": "node scripts/release/cli.mjs release",
"release:publish": "node scripts/release/cli.mjs publish",
"release:changelog": "node scripts/release/cli.mjs changelog",
"release:tag": "node scripts/release/cli.mjs tag",
"release:clean": "node scripts/release/cli.mjs clean",
"release:plan": "node scripts/release/cli.mjs publish --dry-run",
"release:withdraw": "node scripts/release/cli.mjs withdraw"
```

`release` 是默认的一键交互入口；`release:publish`、`release:tag`、`release:changelog` 保留为低层命令。

不建 `tools/release` 子包：它不应被发布，也不需要独立依赖；新增 workspace 目录只会让 `pnpm-workspace.yaml` 与发布发现逻辑多一层区分。备选方案是根脚本直接写成一个文件，但校验、编排、报告、目标适配器的职责差异大，单文件难以测试。

根 `package.json` 没有 `"type": "module"`，因此脚本与测试统一使用 `.mjs` 扩展名，避免被当作 CommonJS 解析。

### 2. 包发现与顺序

- 候选包：读取 `plugins/*/package.json`，名称匹配 `@tjh/dsh-plugin-*`。
- 选择：`--package <name>` 可重复；未指定时选择全部通过校验的包。未知包名直接终止并列出候选。
- 顺序：在候选集合内，用 `dependencies` 与 `optionalDependencies` 中指向本地候选包的边做 Kahn 拓扑排序；同层按包名排序，保证输出稳定。出现环时报出环上的包并终止。
- 不把 `peerDependencies` 作为顺序边：peer 不参与安装顺序，且语义上是消费方约束。

### 3. 发布前校验分阶段执行，全部通过才进入计划

顺序如下，任一阶段失败即终止，且尚未调用 registry 写接口：

1. **官方源**：根 `.npmrc` 存在且 `registry`、`@tjh:registry` 都等于 `https://registry.npmjs.org/`；`npm config get registry` 与 `pnpm config get registry` 在仓库根返回同一地址；`pnpm-lock.yaml` 中所有 `tarball` 地址的主机都是 `registry.npmjs.org`。任一不符即终止。
2. **工作区**：`git status --porcelain --untracked-files=all` 必须为空。已忽略文件不列出，因此 `.tmp/`、`node_modules/` 不触发失败。
3. **清单**：名称前缀、semver、非 `private`、`files` 非空、`license` 与 `LICENSE` 文件、`repository`、`publishConfig.access === "public"`、`publishConfig.registry` 与目标 registry 一致、`dsh.bundle.patch` 存在。
4. **打包内容**：`npm pack --dry-run --json` 取 tarball 文件列表。检查 `exports` 每个目标、`dsh.bundle.patch`、locale 与 icon 都在列表内；从 tarball 内的 `.js` 文件出发，扫描相对导入（`from './x.js'`、`import './x.js'`）并递归，任何解析不到或不在列表内的目标都报错。`today.js` 这类漏项由该检查拦住。
5. **已提交**：tarball 内每个路径都执行 `git ls-files --error-unmatch -- <包相对路径>`。`files` 指向被忽略的构建产物时在这里失败。
6. **changelog 与 tag**：`CHANGELOG.md` 在 tarball 内，且按当前 tag 范围重新渲染的当前版本段落与文件内容一致（范围末尾跳过只改版本或 changelog 的发布提交）；tag 在本地与 `origin` 都不存在；`origin` 可访问。任一不符即终止。
7. **检查与测试**：对每个包执行 `pnpm --filter <name> run --if-present check` 与 `test`。`--skip-checks` 可跳过，仅供调试。
8. **版本可用性**：通过目标适配器查询 `<name>@<version>`。不存在视为可发布；其他错误终止；已存在说明该版本已发布，终止并提示改版本号。
9. **认证**：通过目标适配器执行 `whoami`。失败时提示 `npm login --registry https://registry.npmjs.org/` 或配置 automation token。

`npm pack --dry-run` 会执行包自身的 `prepack`/`prepare` 生命周期脚本；这是生成 tarball 的必要行为。工具只用于本仓库，脚本已在 git 中且发布前通过测试。

### 4. 发布动作与 npm 参数

每个包在其目录内执行一次：

```text
npm publish --access public --registry https://registry.npmjs.org/ --tag latest
            --cache <repo>/.tmp/release/npm-cache --json [--otp <code>]
```

- 使用 npm 而非 pnpm：发布目标是 npm registry，`npm publish` 的 `--json` 输出可直接取 `integrity`；本仓库没有 `workspace:` 依赖，不需要 pnpm 的改写。
- registry 写死在目标适配器里，不读取用户 npm 配置；独立缓存避开本机 root 权限缓存导致的 `EPERM`。
- 2FA：`--otp` 参数或 `NPM_CONFIG_OTP` 环境变量；自动化场景用 automation token。
- `--json` 输出解析失败时，仍以退出码判断成败，报告标注 `integrity: null`。

### 5. 确认与 dry-run

- 发布前打印计划表：包名、版本、registry、顺序、changelog 当前版本状态、tag 状态。
- 计划锁定后询问确认；只接受 `y`。标准输入不是 TTY 时必须提供 `--yes`，否则终止。
- `--dry-run` 打印同一张计划表后退出 0，不进入认证与发布阶段。计划内容与真实发布一致，便于在 CI 里比对。

### 6. 失败报告只落盘，不自动撤销

发布失败时停止后续包，写入：

```text
.tmp/release/<YYYYMMDDTHHMMSSZ>/
  report.json
  rollback.sh
  summary.md
```

`report.json` 结构：

```json
{
  "schemaVersion": 1,
  "target": "npm",
  "registry": "https://registry.npmjs.org/",
  "startedAt": "2026-11-20T02:00:00.000Z",
  "finishedAt": "2026-11-20T02:01:00.000Z",
  "exitCode": 1,
  "plan": [{ "name": "@tjh/dsh-plugin-useage", "version": "0.1.0", "order": 1 }],
  "results": [
    { "name": "@tjh/dsh-plugin-useage", "version": "0.1.0", "status": "published", "integrity": "sha512-...", "url": "https://www.npmjs.com/package/...", "releaseCommit": "abc123", "tag": "@tjh/dsh-plugin-useage@0.1.0", "tagPushed": true, "changelogMissing": false }
  ],
  "rollback": {
    "windowHours": 72,
    "commands": [
      "npm unpublish '@tjh/dsh-plugin-useage@0.1.0' --force --registry https://registry.npmjs.org/ --cache \"$(git rev-parse --show-toplevel)/.tmp/release/npm-cache\"",
      "git tag -d '@tjh/dsh-plugin-useage@0.1.0'",
      "git push origin :refs/tags/@tjh/dsh-plugin-useage@0.1.0"
    ],
    "note": "命令未执行；超过 72 小时改用 npm deprecate"
  }
}
```

`rollback.sh` 带 shebang 与 `set -euo pipefail`，以 `CACHE="$(git rev-parse --show-toplevel)/.tmp/release/npm-cache"` 解析缓存目录，再写入已成功发布与 `published-uncertain` 版本的 `npm unpublish ... --force --registry ... --cache "$CACHE"`、`git tag -d <tag>` 与 `git push origin :refs/tags/<tag>` 命令，权限 0755，生成后不执行。`.tmp/` 已被 `.gitignore` 忽略，报告不进入版本库。

失败包先查询一次 registry：查不到记为 `failed`；查得到记为 `published-uncertain` 并加入撤销命令；查询本身失败记为 `unknown`，报告中打印手动核对命令。`npm publish` 超时后可能已落库，仅凭退出码会漏掉需要撤销的版本。

选择“报告 + 人工执行”而非自动撤销：npm 的撤销受 72 小时、依赖者与 2FA 限制，自动调用会在部分成功时制造更复杂的中间状态；报告让操作者先确认影响。

### 7. 单包撤回：先检查影响，再确认执行

`release:withdraw <name>@<version>`：

1. 解析 scoped 名称（从最后一个 `@` 之后切版本）。
2. 目标包必须在候选清单中，版本必须出现在 `npm view <name> time --json` 的 `time` 表。
3. 从 `time[version]` 计算是否在 72 小时内。超出时拒绝执行，输出 `npm deprecate '<name>@<version>' "withdrawn: <reason>"` 让操作者选择。
4. 输出影响：版本、发布时间、被 `latest` 等 dist-tag 指向的情况、对应 tag、lockfile 中已引用该版本的消费者会安装失败。依赖者数量没有可靠的 npm CLI 查询，报告不做估算。
5. 交互终端要求输入完整的 `<name>@<version>`；`--yes` 跳过。随后执行 `npm unpublish ... --force`。
6. 执行后轮询 `npm view <name>@<version> version` 最多 3 次，间隔 2 秒；E404 视为成功，仍返回版本号则报告 “registry 尚未反映撤回”，非零退出。
7. 版本确认消失后，删除本地 tag `<name>@<version>`；本地存在时 `git tag -d`，远程存在时 `git push origin :refs/tags/<tag>`。tag 不存在时跳过；删除失败报告并以非零退出，但不重新发布版本。

撤回与失败回滚的差别是操作者显式点名版本并在确认提示里复述，因此允许执行；失败回滚只输出命令。

### 8. 目标适配器接口

编排层只依赖以下接口，npm 是第一个实现：

```js
/**
 * @typedef {object} ReleaseTarget
 * @property {string} id
 * @property {string} registry
 * @property {() => Promise<{ user: string }>} checkAuth
 * @property {(pkg: { name: string, version: string, withTime?: boolean }) => Promise<
 *   { state: 'absent' } |
 *   { state: 'published', publishedAt: string | null, gitHead: string | null }
 * >} inspectVersion
 * @property {(pkg: { name: string, version: string, dir: string }, opts: { otp?: string }) =>
 *   Promise<{ integrity: string | null, url: string }>} publish
 * @property {(pkg: { name: string, version: string }) =>
 *   { executable: true, commands: string[], note: string } |
 *   { executable: false, commands: string[], note: string }} withdrawPlan
 * @property {(pkg: { name: string, version: string }) => Promise<void>} withdraw
 */
```

- `scripts/release/targets/index.mjs` 导出 `{ npm }` 与 `getTarget(id)`。
- npm 适配器负责 72 小时规则、`--force`、registry 与缓存参数；编排层不拼 npm 命令。发布预检传 `withTime: false`，避免拉取只供撤回使用的发布时间。
- 后续市场新增 `scripts/release/targets/<id>.mjs`，实现同一接口，编排、校验、确认、报告不改。市场的准备动作（例如额外 manifest）通过适配器可选的 `prepare(pkg)` 钩子实现，不进入编排层。

### 9. `plugins/useage` 清单修正

```json
{
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/tangjiahui-cn/dsh-plugins.git",
    "directory": "plugins/useage"
  },
  "keywords": ["dsh", "deepseek-harness", "dsh-plugin", "usage", "cost"],
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": [
    "index.js", "client.js", "projection.js", "today.js",
    "cordis.patch.yml", "locale/*.json", "README.md", "CHANGELOG.md", "LICENSE", "icon.svg", "assets"
  ]
}
```

- 根目录新增 MIT `LICENSE`，`plugins/useage/LICENSE` 放同一份文本，版权行写 `Copyright (c) 2026 dsh-plugins contributors`。npm 只读取包目录内的 LICENSE，根目录副本不会被装入 tarball；不使用软链接，避免打包工具对链接的处理差异。
- `plugins/useage/CHANGELOG.md` 由 `release:changelog` 生成首版 0.1.0 内容并提交；`files` 必须包含它，否则发布前 tarball 校验失败。
- `private` 直接删除，不写 `false`；两者语义相同，删除更明确。
- 不新增 `engines.dsh`：本包只在 DSH `0.2.2-rc.5` 验证过，声明未验证的范围会让其他版本的安装被拒绝。兼容范围留给插件 README 的验证表。

### 10. 测试策略

- `scripts/release/test/` 用 `node:test`，覆盖：官方源预检、清单校验、相对导入闭包、拓扑排序与环、git 状态解析、changelog 范围与分类、tag 创建/推送/删除、一键流程与清理、报告与 `rollback.sh` 命令生成、`withdraw` 的 72 小时判定。
- npm 调用通过 `RELEASE_NPM_BIN` 注入假脚本，测试不访问 registry；git tag 与 push 测试使用临时 bare remote，不访问真实 origin。
- 端到端手工验证：`pnpm release:plan` 输出计划；`pnpm release:publish -- --dry-run` 不调用 registry；在干净 profile 中安装已发布版本。

### 11. 官方 npm 源固定在仓库根

根 `.npmrc` 只写源配置，不写 token：

```ini
registry=https://registry.npmjs.org/
@tjh:registry=https://registry.npmjs.org/
```

- npm 与 pnpm 都读取项目 `.npmrc`，优先级高于用户级 `~/.npmrc`；显式写 `@tjh:registry` 防止用户级 scope 配置把待发布包指到私有源。
- 凭据仍来自用户级 `.npmrc`、`NPM_TOKEN` 或 automation token，仓库文件不保存认证信息。
- 现有 `pnpm-lock.yaml` 的 3 处 `tarball` 地址指向私有镜像。切换源后删除锁文件并重新执行 `pnpm install`，再确认锁文件不含非 `registry.npmjs.org` 的 `tarball` 地址。官方源提供相同版本，版本号不变。
- 发布前检查 `.npmrc`、`npm config get registry`、`pnpm config get registry` 与锁文件；环境变量 `NPM_CONFIG_REGISTRY` 能压过项目配置，检查失败时报告生效值，不静默继续。
- `npm publish` 仍显式传 `--registry https://registry.npmjs.org/`，命令行参数优先于环境与配置文件；预检查负责让“配置被改”显式失败。
- 仓库 `.npmrc` 不作用于 DSH profile 的安装目录；profile 的 registry 由用户配置，README 说明安装前确认该源能解析官方包。

备选方案是只在发布工具里传 `--registry`，不改 `.npmrc` 与锁文件；这样仓库内 `pnpm install` 仍从私有镜像下载，锁文件也继续固定私有地址，不满足“只使用官方源”。把 token 写进项目 `.npmrc` 会让凭据进入版本库，直接排除。

### 12. Changelog 从 git tag 生成

- 命令：`release:changelog`，默认处理全部候选子包，`--package` 可重复选择。
- 文件：`plugins/<目录>/CHANGELOG.md`，加入该包 `files`，随 tarball 发布。
- 范围：用 `git describe --tags --abbrev=0 --match '<包名>@*' HEAD` 找最近可达 tag；有 tag 时取 `<tag>..HEAD`，没有 tag 时取 `HEAD` 全部历史；从末尾跳过只修改 `package.json` 版本或 `CHANGELOG.md` 的发布提交（可连续），只保留触及 `pkg.relDir` 的提交，排除 merge。
- 分类：解析 `type(scope)!: subject`。`feat` 新功能、`fix` 修复、`perf` 性能、`refactor` 重构、`docs` 文档、`test` 测试；带 `!` 的进入破坏性变更；其余与不匹配 Conventional Commits 的进入维护。
- 格式：`## <version> - <YYYY-MM-DD>`，日期用 `Asia/Shanghai`；条目写 `- <subject> (<short-hash>)`。旧版本段落按原文保留，当前版本文本重写。
- 幂等：重跑同一版本不产生重复段落；tag 到 HEAD 之间没有触及该包的提交时不修改文件，并报告“没有可写入的提交”。
- 内容校验：`release:publish` 预检重新渲染当前版本段落（不写文件），与文件中的当前段落逐字比较；从范围末尾排除只修改 `package.json` 版本或 `CHANGELOG.md` 的发布提交（可连续多个），避免首版 changelog 提交与一键发布提交进入自身内容；不一致时要求重跑 `release:changelog`。
- 版本号与 changelog 建议放在同一个提交。分开提交时，内容校验会跳过末尾的纯 `CHANGELOG.md` 提交与版本提交，仍能比较生成内容；但新增的非发布提交会让校验失败。
- 不在 `release:publish` 内生成：发布前要求工作区干净，生成 changelog 会修改已跟踪文件；必须在提交前完成。

### 13. 子包 tag 生命周期与 `release:tag`

- 名称：`<包名>@<版本>`，例如 `@tjh/dsh-plugin-useage@0.1.0`；annotated tag，消息与名称相同。
- 发布前检查：`git rev-parse -q --verify refs/tags/<tag>` 必须失败；`git ls-remote --tags origin refs/tags/<tag>` 必须无输出；`git remote get-url origin` 必须成功。
- 创建时机：发布前记录 `releaseCommit = git rev-parse HEAD`；包发布成功后在该 commit 创建 tag，并 `git push origin <tag>`。push 最多重试 2 次，仍失败停止后续包并写报告。tag 不指向 push 时的当前 `HEAD`。
- 修复命令：`release:tag <name>@<version> [--at <commit>]`，用于已发布版本的 tag 缺失或本地/远程不同步。
  - 目标 commit 解析顺序：session 的 `releaseCommit` → npm `gitHead` → 显式 `--at`。都不可用时终止，禁止回退到 `HEAD`。
  - 目标 commit 必须存在于本地，且 `package.json` 版本等于已发布版本；否则拒绝。
  - 状态处理：none 创建并 push；local-only 校验后 push；remote-only `git fetch origin tag <tag>` 后校验并视为完成；both 校验一致；任何不一致终止，不 force。
  - 目标 commit 缺 `CHANGELOG.md` 时仍完成 tag 修复，报告中标记 `changelogMissing`；历史 tarball 无法补 changelog。
- 撤回：`release:withdraw` 在 unpublish 后删除本地 tag；远程存在时 push 删除。tag 不存在时跳过。
- 备选方案“先打 tag 再发布”被排除：发布失败会留下指向未发布版本的 tag。轻量 tag 被排除：缺少创建者与消息，无法区分发布 tag 与普通引用。用版本号变更历史猜 commit 被排除：多解时会打错 tag，宁可要求 `--at`。

### 14. 一键交互流程

`release` 是一个顺序状态机，每步失败即停止并保留 session：

1. 获取 `.tmp/release/lock`（陈旧锁先清除）；若 session 存在，终止并提示先执行 `release:clean`；否则要求工作区干净，检查 official source、origin、npm 认证。
2. 发现子包，按当前版本查 registry 与 tag 状态，分为：已完成、只补 tag（none/local-only/remote-only）、tag 冲突、未发布。
3. 让操作者选择要处理的包，默认全选可处理的包。
4. 对未发布的包逐个询问版本：patch、minor、major、custom 或 keep current；显示旧版本与新版本；未发布且已有版本号的包默认 keep current。已发布包不询问版本。
5. 写入新版本号。
6. 对选中且未发布的包执行 changelog 生成。
7. 展示版本号与 changelog 的 diff 统计，询问提交信息；默认 `chore(release): <包名>@<版本>, ...`。只 `git add` 本次修改的 `package.json` 与 `CHANGELOG.md`，然后提交。
8. 运行共享预检；展示计划并确认。
9. 顺序发布；每个包成功后按第 13 项规则在 `releaseCommit` 创建并 push tag。
10. 写报告；删除 session；释放 lock。

- 只补 tag 的包走 `release:tag` 的目标解析与状态规则；无法定位发布 commit 时停止，不使用 `HEAD`。
- 版本号与 changelog 没有变化时跳过提交；版本未发布时继续预检与发布，避免重启后重复提交。
- 已发布版本缺 changelog 时完成 tag 修复并告警；本次新发布版本缺 changelog 时在发布前失败。
- `runPublish` 返回非零后立即停止，不继续 tag-only 修复或后续包。
- 初始工作区必须干净，保证第 7 步只提交发布文件；提交失败时不发布。
- `release` 不自动恢复或继续未完成的 session；恢复统一由 `release:clean` 完成。
- 取消发生在提交前则不写文件；发生在计划确认处时，发布提交已存在但不发布，下次运行会识别当前版本未发布并提供 keep current。
- 不在 `release` 内自动决定版本号，所有版本变化来自操作者选择。

### 15. 中断状态与 clean 恢复

- 状态文件：`.tmp/release/session.json`，记录阶段、`baseHead`、`releaseCommit`、包与版本、计划、生成文件 hash 与已完成的 tag/发布结果；临时目录 `.tmp/release/session/`。
- `release` 获取锁后若发现 session，直接终止并提示先执行 `release:clean`；不自动恢复、不继续发布。
- 在发布确认处取消时，session 保留为 `cancelled`，不再直接删除；这样 `release:clean` 能恢复发布前快照。
- `release:clean` 的语义是“撤销本次 release 在本地产生的全部改动”：
  - 没有 session 时只清临时目录与陈旧锁。
  - 有 session 时先检查 session 里的包版本是否已发布、tag 是否存在；任一存在则拒绝，并提示 `release:withdraw`。
  - `HEAD` 必须等于 `baseHead` 或 `releaseCommit`；存在额外提交，或工作区有生成文件之外的改动时拒绝。
  - `HEAD` 等于 `releaseCommit` 时 `git reset --hard baseHead`；等于 `baseHead` 时只恢复 hash 匹配的生成文件。
  - 成功后删除 session、临时目录与锁；历史报告与 `npm-cache` 保留。
- 清理不删除 `.tmp/release` 下的历史报告与 `npm-cache`。
- 重启不依赖 session 恢复：registry 上已存在的版本跳过发布，缺 tag 按第 13 项规则补建；版本已提交但未发布时，版本询问提供 keep current。
- 选择“clean 恢复快照”而非 resume：发布前所有本地改动都由本次 release 产生，恢复到 `baseHead` 比校验半完成状态更简单；已发布版本不允许 clean，必须 withdraw。

### 16. 报告与回滚增加 tag

- `results` 每项增加 `releaseCommit`、`tag`、`tagPushed`、`tagError`、`changelogMissing`。
- 失败报告的回滚命令包含已发布版本的 `npm unpublish`、`git tag -d <tag>`，以及已推送时的 `git push origin :refs/tags/<tag>`。
- `rollback.sh` 顺序为先 unpublish，再删本地 tag，再删远程 tag；脚本仍只落盘，不自动执行。
- 摘要表增加 tag、push 状态与 changelog 缺失标记。
- 已发布版本补 tag 时若目标 commit 缺 changelog，命令以 0 结束并告警；本次新发布版本缺 changelog 时在发布前失败。

### 17. 发布锁

- 文件：`.tmp/release/lock`，JSON `{ pid, command, startedAt }`。
- `release`、`release:publish`、`release:changelog`、`release:tag`、`release:withdraw` 在写文件、registry 或 git ref 前创建锁；命令退出时在 `finally` 中删除。
- 锁存在时读取 pid，用 `process.kill(pid, 0)` 判断存活：存活则终止并报告；已退出则报告陈旧锁，下一次 `release` 启动时或 `release:clean` 删除。
- `release:clean` 删除陈旧锁；不删除仍在运行的锁。
- 锁由 CLI 入口获取；`release` 内部调用 changelog/publish/tag 函数时不重复获取，避免自锁。
- `release` 先获取锁，再读取并清理 session；避免两个进程同时清理同一份状态。
- 备选方案“只靠 npm 版本检查”被排除：两个进程可能同时通过版本检查，再竞争 tag 与 changelog 提交。

## Risks / Trade-offs

- **npm 撤销窗口**：超过 72 小时或存在依赖者时 `npm unpublish` 会被拒绝 → 报告与撤回命令都标注窗口，超出时给 `npm deprecate`；首次发布前先确认 scope 权限。
- **本机 registry 是私有镜像**：直接 `npm publish` 会发错源，缓存还可能 `EPERM` → 根 `.npmrc` 固定官方源，所有 npm 调用显式传 `--registry https://registry.npmjs.org/` 与 `--cache .tmp/release/npm-cache`。
- **环境变量压过项目配置**：`NPM_CONFIG_REGISTRY` 会让 `pnpm install` 与发布预检查之外的命令回到私有源 → 发布预检查比较生效值并终止；README 提示检查该变量。普通安装无法由仓库拦截，属于用户环境。
- **锁文件重新生成改变解析结果**：删除锁文件后 `pnpm install` 会在 semver 范围内重新选版 → 审查 diff，版本变化时重跑 `plugins/useage` 的 check 与 test；官方源当前提供相同版本，预计只去掉 `tarball` 字段。
- **官方源可达性**：强制官方源后，网络受限环境可能下载变慢或失败 → 这是“只使用官方源”的代价，不提供回退；失败时保留 pnpm 原始错误。
- **仓库 `.npmrc` 不覆盖 profile**：DSH 从 profile 目录安装插件，不读取本仓库配置 → README 写明安装前确认 profile 的 registry 能解析 `@tjh/dsh-plugin-*`。
- **发布不可重试**：同一版本号第二次发布会失败 → 预检查 `npm view`；一键流程按 registry 跳过已发布版本，只补 tag。
- **changelog 范围依赖 tag**：tag 缺失、移动或不在当前历史路径上会让范围出错 → 首版显式使用该包目录全部提交；发布前要求目标 tag 不存在；报告显示使用的上一个 tag。
- **非约定提交**：不匹配 Conventional Commits 的提交归入「维护」，不丢失；破坏性变更只有 subject 带 `!` 时才进入该分组。
- **tag push 失败**：包已发布但 tag 未推送 → 重试 2 次仍失败则报告并停止；报告给出 `git push origin <tag>`，不自动撤销包。
- **补 tag 目标不明确**：历史版本缺 session 与 `gitHead` 时无法确定发布 commit → 拒绝自动补 tag，要求 `--at <commit>`；不使用 HEAD，不猜版本提交。
- **历史 changelog 缺失**：已发布 tarball 无法补文件 → 完成 tag 修复并标记 `changelogMissing`，下一版本必须包含；不重发同版本。
- **并发执行**：两个进程可能同时通过版本检查并竞争 tag/提交 → `.tmp/release/lock` 拒绝并发，陈旧锁由下一次 `release` 或 `release:clean` 清除。
- **一键流程自动提交**：只 `git add` 版本号与 `CHANGELOG.md`；pre-commit hook 可能修改其他文件，随后预检会因工作区不干净而终止。开始前必须干净，提交失败不发布。
- **中断后清理重来**：已发布版本按 registry 跳过，缺 tag 按发布 commit 修复；已提交但未发布的版本在下一次版本询问中提供 keep current；提交前中断仅在文件 hash 匹配时自动恢复，否则停止。
- **不使用 changesets**：tag-based changelog 不提供多包版本联动或依赖范围自动升级；当前子包相互独立，出现本地依赖时再评估 changesets。
- **`npm pack` 执行生命周期脚本**：脚本在仓库内且发布前经过测试 → 只在受信任的本仓库使用；`--skip-checks` 只跳过 check 与 test，不跳过打包检查。
- **静态导入扫描的边界**：只识别字面量相对路径，动态 `import()` 与条件导出无法覆盖 → 当前包没有这类用法；新增时由人补充 `files` 并在测试中加断言。
- **tarball 体积**：`assets` 两张截图约 570 KB → 可接受；若后续需要，改为压缩图并单独评估，不影响本次发布流程。
- **2FA 与 token**：交互式 OTP 无法在后台任务中完成 → 提供 `--otp`、`NPM_CONFIG_OTP`，CI 使用 automation token。
- **DSH 兼容范围未声明**：其他 DSH 版本可能加载失败 → README 写明已验证版本；后续按 `dsh-doc` 的升级指引补 `engines.dsh`。

## Migration Plan

1. 先切换源：新增根 `.npmrc`，删除现有 `pnpm-lock.yaml`，在仓库根执行 `pnpm install` 生成新锁文件；确认 `npm config get registry`、`pnpm config get registry` 返回官方源，锁文件没有非官方 `tarball` 地址。
2. 落地 `scripts/release/`、根 `package.json` 命令、两份 LICENSE、`plugins/useage/package.json` 与 `CHANGELOG.md` 修正。
3. 对 `plugins/useage` 执行 `pnpm release:changelog` 生成 0.1.0 段落，提交全部改动；确认 `CHANGELOG.md` 进入 tarball。
4. 执行 `pnpm install --frozen-lockfile`，再执行 `pnpm release:plan` 确认 changelog、tag 缺失状态与计划只含 `@tjh/dsh-plugin-useage@0.1.0`。
5. 确认已登录 npmjs、对 `@tjh` scope 有发布权限、origin 可写，执行 `pnpm release`（或 `pnpm release:publish`）。
6. 确认 npm registry 上出现该版本，本地与 origin 上出现 `@tjh/dsh-plugin-useage@0.1.0` tag。
7. 在干净 DSH profile 中按 README 安装该版本，确认插件行出现并可打开弹窗。
8. 回滚：72 小时内执行 `pnpm release:withdraw @tjh/dsh-plugin-useage@0.1.0`；超过窗口执行报告给出的 `npm deprecate`，并发布修正版本。

## Open Questions

- 是否以及从哪个版本开始声明 `engines.dsh`：需要先在其他 DSH 版本上验证 `sessionProjections` 与 `remote.account.getBalance`，不阻塞本次发布。
