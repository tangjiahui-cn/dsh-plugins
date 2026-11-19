# Design

## Context

见 `proposal.md - Why`。当前安装为 Desktop 形态的 `@deepseek-ai/dsh 0.2.2-rc.5`（`app.asar`）。已核对的既有能力：

- `dsh-token-meter` 注册 `tokenUsage` 投影，按整个日志累计 `uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`，但只有总数，没有按天与按对话的金额。
- `dsh-session-stats` 注册 `sessionStats`，提供轮次/步数与耗时，不含 token。
- `assistant/message` 携带 `usage?: TokenUsage`，`assistant/attempt` 的 usage 内嵌在 stream 中；`llm/retry-started` 划分替换范围。
- `request/header` 的 `header.config` 携带该次请求的 `provider` 与 `model`。
- 会话事件带 `seq` 与 `time`（epoch 毫秒），投影可据此分日。
- DSH 没有 token 单价字段，只有图片请求计价；余额来自 `dsh-deepseek-account`，异步且可能失败。
- 现有 UI 在标签行右侧没有插槽；`conversation.session.header.utilities` 是标题行右对齐的列表槽。

## Goals / Non-Goals

**Goals:**

- 金额与按天拆分在 Host 侧一次算清，Client 只渲染。
- 今日总花费在 Host 侧按需聚合本机会话，客户端只取结果。
- 单价、时区、币种可通过插件 `Config` 覆盖，改动后投影重算。
- 插件未配置价格、余额不可用时仍可用：只降级单项，不整体失效。

**Non-Goals:**

- 不做逐 token 的实时估算。
- 不做 overlay 绝对定位到标签行。
- 不做多币种换算；不做跨日历史汇总与全账号口径。
- 不写会话日志、不新增会话事件类型。

## Decisions

### 用会话投影承载金额，而不是客户端折叠日志

注册 `sessionProjections` 单元 `conversationCost`，`apply(state, event)` 纯函数折叠事实，`wire.view` 输出客户端视图。理由：DSH 的投影带检查点与变更推送，重载/分页后仍正确；客户端折叠整份日志与 `references/practices.md` 的增量机制相违背。

替代方案：客户端用 `useProjection('tokenUsage')` 自行乘单价。放弃是因为它拿不到按天拆分，且价格会散落到浏览器侧。

### 折叠范围：`assistant/message` + `assistant/attempt`，`llm/retry-started` 重置替换槽

与 `dsh-token-meter` 的替换语义保持一致，避免重试重复计数。usage 缺失的尝试按 0 计并累加 `usageMissingCount`，仅作为诊断数据输出，界面不展示。

替代方案：只折叠 `assistant/message`。放弃是因为重试与失败调用同样产生费用。

### 单价：内置 DeepSeek 标准价，`Config.prices` 覆盖

`Config.prices` 为 `Record<'<provider>/<model>', { input, output, cacheRead, cacheWrite }>`，单位「每百万 token」，币种由 `Config.currency` 指定。查找顺序：`provider/model` → `model` → 内置表；内置表只含 DeepSeek 官方标准价（低峰约为标准价一半，会在 README 标注）。三者都未命中的 step 不产生金额，`wire.view` 置 `costComplete: false`，卡片金额显示「—」。

最初打算只靠配置、不内置价格。改为内置是因为默认路径下金额一直是「—」，用户看不到任何数值；内置价让默认可用，可覆盖性保留。

### 金额用整数微单位存储

状态里金额存 `microCny`（1e-6），`wire.view` 再转成展示字符串，避免浮点累加误差。`stateVersion` 在字段或折叠语义变化时递增，旧检查点自动失效。

### 按 `event.time` 与配置时区分日

状态里保留最近 14 天的 `{ tokens, microCost }` 字典与累计值；客户端按本地时区挑「今天」的键，Host 按同一时区写入。跨零点不需要额外定时器，下一次事件即进入新桶；客户端每天重读一次投影以切换键。

替代方案：Host 只输出「今日」单值。放弃是因为零点切换会让客户端在午夜后显示昨天的数据。

### 位置用 `conversation.session.header.utilities`

该槽为标题行右对齐列表，胶囊排在 `⋯` 左侧，随窗口缩放回流。放弃 overlay 的理由：需要自算几何、header 换行时错位；放弃 `corner` 的理由：该槽为单值席位，且已被现有控件使用。

### 两张卡始终展示：今日在上、累计在下

弹窗固定渲染「此对话今日总花费」与「此对话总花费」，都来自会话投影，不按数值相等做合并；今日在上，与胶囊展示的累计值形成「今天 / 全部」的读法。

替代方案：把今日总花费放第一张。放弃是因为弹窗展开后第一眼应回答「今天这个对话花了多少」，累计值在胶囊上已能看到。

### 今日总花费：Host 路由按需聚合本机会话

底栏的「今日总花费」由 Host 的同源路由 `GET /plugin/useage/today` 在弹窗展开时计算：枚举今天有写动的会话日志（含子会话），折叠各会话的 provider usage，按模型与时段峰谷价换算，返回金额与 token 合计。客户端只发起一次请求并渲染结果。

当前实现不做缓存，每次请求都重新枚举并折叠当天会话；当天 15 个会话约 17MB 压缩日志，实测 0.4–0.5s。数据口径只含本机，不含网页端与其他设备。

替代方案：客户端直连平台用量接口。放弃是因为平台 token 不下发浏览器；替代方案二：Host 常驻增量缓存。暂缓是因为当前请求频率（仅展开与手动点击）还不需要。

### 余额走客户端既有账户详情服务，失败显示失败态

弹窗展开时按需读取余额：优先在 `account/watch` 授权作用域内调 `remote.account.getBalance`，失败回退设置页维护的 `accountUi` 快照。查询中显示加载态，失败显示「查询失败」与重试，底栏行始终保留。余额数值与今日总花费数值都可点击重新查询。

## Risks / Trade-offs

- 价格表需要用户维护 → 未配置的模型明确显示「—」，README 给出填写示例。
- 余额依赖登录与网络 → 失败显示「查询失败」与重试入口，卡片照常可用。
- token 单价随 provider 调整 → `Config` 可覆盖，无需发版。
- 投影 `stateVersion` 与 DSH 版本耦合 → README 记录验证版本，升级后按 `references/upgrading.md` 复核。
- 窄窗口挤压标题 → 标题已有省略号与渐隐，胶囊设 `flex: none` 不参与收缩。
- usage 缺失导致金额偏低 → 计入 `usageMissingCount` 但界面不提示，偏差记录在 README。
- 今日总花费每次展开都全量折叠当天会话 → 0.4–0.5s；展开频率高时可加 Host 增量缓存。
- 今日总花费只含本机 → 与平台用量页的全账号口径会有差异，README 标注。

## Migration Plan

1. 在 `plugins/useage` 建包并 `pnpm install` 建链接。
2. 通过插件管理器安装/启用 bundle；投影注册后胶囊出现。
3. 回滚：停用插件，投影注销、胶囊消失，会话日志不受影响。

## Open Questions

无。
