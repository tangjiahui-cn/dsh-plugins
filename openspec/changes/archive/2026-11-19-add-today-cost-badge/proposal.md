# Proposal

## Why

DSH 只在每条助手消息上给出单次 usage，会话级「今日花了多少、这个对话总共花了多少」需要用户自己累加并乘以单价。价格与余额都在平台侧，界面上没有一处能同时看到当前对话的钱和剩余额度。

## What Changes

- 新增 bundle 插件 `@tjh/dsh-plugin-useage`（`plugins/useage`），Host 侧注册会话投影 `conversationCost`，Client 侧在 `conversation.session.header.utilities` 槽渲染胶囊与弹窗。
- 胶囊展示今日对话金额与今日 token 总量；弹窗以两张卡展示「此对话花费」「今日总花费」，每张卡内含金额与输入/输出/合计 token，底部一行账户余额。两张卡始终展示，不做相同值合并。
- Host 投影折叠 `assistant/message`、`assistant/attempt` 的 provider usage，按 `event.time` 分日桶；按 `request/header` 中的 provider/model 查配置单价换算金额。
- 插件 Config 提供：模型价格表（输入/输出/缓存读/缓存写，每百万 token）、币种、时区、余额开关。
- 余额通过 `dsh-deepseek-account` 按需查询；失败时该行显示「查询失败」与重试入口，不隐藏整行。
- README 记录开发与验证所用的 DSH 版本：`@deepseek-ai/dsh 0.2.2-rc.5`（Desktop，`app.asar` 安装）。
- 本次不做：overlay 精确贴标签行、逐 token 实时估算、多币种换算、按对话搜索历史花费。

## Capabilities

### New Capabilities

- `conversation-cost`：当前对话的今日与累计花费、token 拆分、账户余额的展示规则，以及单价配置与计价边界。

### Modified Capabilities

无。

## Impact

- 新增子包 `plugins/useage`，根 `pnpm-workspace.yaml` 的 `plugins/*` 已覆盖，无需改工作区声明。
- 依赖 DSH 服务：`sessionProjections`（必需）、`llm`（可选，解析模型信息）、`account`/`credentials`（可选，余额）。
- 安装后会话标题行右侧多一个控件；窄窗口下标题被压缩，标题本身有省略号兜底。
- 不新增工具、不改 prompt、不写会话日志、不新增 Host API。
