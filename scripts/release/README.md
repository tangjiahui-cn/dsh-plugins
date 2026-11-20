# 发布工具

仓库级发布流程的实现说明。命令入口与参数见根 `README.md`，行为契约见 `../../openspec/changes/add-plugin-release/specs/plugin-release/spec.md`。

## 目录

| 文件 | 职责 |
| --- | --- |
| `cli.mjs` | 参数解析、命令分发、交互确认 |
| `config.mjs` | registry、缓存、路径、可执行文件 |
| `packages.mjs` | 子包发现、选择、拓扑排序、清单校验 |
| `git.mjs` | 工作区干净与 tarball 文件已跟踪校验 |
| `pack.mjs` | `npm pack --dry-run` 与 tarball 内容校验 |
| `source.mjs` | 官方 registry 与锁文件来源校验 |
| `changelog.mjs` | 提交采集、Conventional Commits 分类、CHANGELOG 合并与校验 |
| `tags.mjs` | 子包 tag 的检查、创建、push、删除与目标 commit 解析 |
| `session.mjs` | 发布锁、session、生成文件 hash 与中断恢复 |
| `flow.mjs` | `release` 一键交互流程 |
| `changelog-command.mjs` | `release:changelog` 命令 |
| `tag-command.mjs` | `release:tag` 命令 |
| `clean-command.mjs` | `release:clean` 命令 |
| `publish.mjs` | 发布计划、顺序发布、tag、失败对账 |
| `report.mjs` | `report.json`、`summary.md`、`rollback.sh` |
| `withdraw.mjs` | 单包撤回与 tag 删除 |
| `targets/` | 发布目标适配器 |

## 发布目标接口

`targets/index.mjs` 的 `getTarget(id)` 返回适配器。npm 适配器位于 `targets/npm.mjs`，字段如下。

```js
{
  id: 'npm',
  registry: 'https://registry.npmjs.org/',
  checkAuth(): Promise<{ user: string }>,
  inspectVersion({ name, version }):
    Promise<{ state: 'absent' } | { state: 'published', publishedAt: string | null, gitHead: string | null }>,
  publish({ name, version, dir, otp? }):
    Promise<{ integrity: string | null, url: string }>,
  withdrawPlan({ name, version }):
    { executable: boolean, commands: string[], note: string },
  withdraw({ name, version, otp? }): Promise<{ command: string }>,
  distTags(name): Promise<Record<string, string>>,
  prepare?(pkg): Promise<void>
}
```

- `publish` 在包目录执行 npm publish，`integrity` 解析失败时为 `null`，但仍以退出码判断成败。
- `withdrawPlan` 读取发布时间；超过 72 小时或无法读取时返回 `executable: false` 并给出 `npm deprecate` 命令。
- `distTags` 只用于撤回影响清单，失败时返回空对象。
- `prepare` 是可选钩子；发布编排在打包前调用，供后续市场补充自己的清单文件。npm 适配器未实现该钩子。

## 新增发布目标

1. 新建 `targets/<id>.mjs`，实现上面的接口。registry 由适配器负责，编排层不拼目标命令。
2. 在 `targets/index.mjs` 注册该适配器。
3. 在 `test/` 增加适配器测试，至少覆盖认证、版本查询、发布、撤回计划与执行。
4. 不修改 `publish.mjs` 的校验、顺序、确认与报告逻辑；如果确需新钩子，先更新设计文档。

## npm 限制

- 版本发布后不可覆盖；同一版本重复发布会失败，只能提升版本号。
- `npm unpublish` 只在发布后 72 小时内、且没有依赖者时可用；超出窗口改用 `npm deprecate`。
- 交互式 2FA 使用 `--otp` 或 `NPM_CONFIG_OTP`；CI 使用 automation token。
- registry 固定为 `https://registry.npmjs.org/`，不读取用户级 registry 配置；凭据仍来自用户环境。
- DSH profile 的安装 registry 不受本仓库 `.npmrc` 影响。

## 测试

```sh
pnpm test:release
```

测试通过 `RELEASE_NPM_BIN` 注入假 npm，不访问 registry。
