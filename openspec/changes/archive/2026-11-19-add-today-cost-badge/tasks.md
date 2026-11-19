# Tasks

## 1. 包骨架与版本记录

- [x] 1.1 在 `plugins/useage` 创建 `package.json`（`type: module`、`dsh.bundle.patch`、`dsh.client` 指向 `./client.js`、`exports` 含 `.`、`./client`、`./locale/*.json`），执行 `pnpm install` 后确认工作区链接建立
- [x] 1.2 创建 `cordis.patch.yml`、`index.js`（`export function apply(ctx, config)`、`export const inject`、`export const Config`）、`client.js` 占位模块与 `locale/{en,zh}.json`，确认 `pnpm --filter @tjh/dsh-plugin-useage exec node --check client.js` 通过
- [x] 1.3 在 README 写入「开发与验证环境」段，记录 `@deepseek-ai/dsh 0.2.2-rc.5`、Desktop `app.asar` 安装形态与验证日期，确认 `grep -n "0.2.2-rc.5" README.md` 命中

## 2. Host 投影与计价

- [x] 2.1 实现 `conversationCost` 投影骨架（`key`、`stateSchema`、`stateVersion`、`init`、`apply`），对无关事件返回同一引用，确认单测断言引用相等
- [x] 2.2 折叠 `assistant/message` 与 `assistant/attempt` 的 usage 到当日桶与累计桶，确认单测的数字与输入 usage 一致
- [x] 2.3 处理 `llm/retry-started` 的替换语义，确认单测中重试只计一次且与 `tokenUsage` 同语义
- [x] 2.4 按 `request/header` 记录当前 step 的 `provider/model`，按 `Config.prices` 计算金额并累加 `microCny`，确认单测覆盖命中与未命中价格两种分支
- [x] 2.5 实现 `wire.view` 输出 `{ today, total, days, currency, costComplete, usageMissingCount }`，确认单测校验金额字符串与桶拆分
- [x] 2.6 在 README 写明价格表字段与单位（每百万 token）并给出填写示例，确认示例可直接粘进 `cordis.patch.yml`

## 3. Client 胶囊与弹窗

- [x] 3.1 注册到 `conversation.session.header.utilities`，用 `useProjection('conversationCost')` 取数，确认页面出现胶囊且不刷新即可更新
- [x] 3.2 实现胶囊「此对话 + 累计金额」（不展示 token），金额用等宽数字，确认浅色与深色主题下均可读
- [x] 3.3 实现弹窗两张卡片：此对话今日总花费在上、此对话总花费在下，各含输入/输出/合计 token 行，两卡始终展示，确认与设计稿 `placement-a-utilities` 布局一致
- [x] 3.4 实现打开/关闭与键盘行为（点击切换、`Escape` 关闭、焦点回到胶囊），确认手测两条路径
- [x] 3.7 底栏三段（余额、今日总花费、前往平台）固定宽度与 40px 行高，确认加载与失败切换时布局不跳动
- [x] 3.5 文案走 Client locale 服务（中英各一份），确认切换语言后文案改变
- [x] 3.6 客户端产物可被 loader 加载（`window.__ModuleLoader__.load`），确认刷新页面后无控制台报错

## 4. 余额与降级

- [x] 4.1 展开弹窗时读取账户余额并在底栏显示金额与币种，确认与设置页账户余额一致
- [x] 4.2 未登录、超时或失败时余额显示「查询失败」与重试，底栏行保留，确认断网状态下两张卡仍正常渲染
- [x] 4.3 usage 缺失只计入诊断计数、界面不提示，确认构造缺 usage 的会话不出现额外文案

## 5. 今日总花费（本机聚合）

- [x] 5.1 注册同源路由 `GET /plugin/useage/today`，用 `curl` 验证返回 `{ amount, tokens, sessions }` 且响应体不含凭证
- [x] 5.2 按日志 mtime 枚举当天会话并包含子会话，确认单测覆盖日界与跨零点
- [x] 5.3 汇总多模型 token 并按北京时间峰谷分桶计价，确认单测用固定桶数据得到确定金额
- [x] 5.4 客户端在展开时请求该路由，实现加载态、失败态与点击数值重试，确认接口 500 时两张卡与余额不受影响
- [x] 5.5 README 写明本机口径（不含网页端与其他设备）、单次约 0.4–0.5s 与失败降级，确认文档与接口字段一致

## 6. 安装与集成验证

- [x] 6.1 通过插件管理器安装并在新会话中启用，确认胶囊出现且投影无重复注册报错
- [x] 6.2 触发一次对话，确认每个 step 结束后弹窗金额与 token 增加一次（不是整轮才变）
- [x] 6.3 重载页面与切换会话后数值保持一致，确认投影冷读生效
- [x] 6.4 把窗口缩到窄宽度，确认标题省略而胶囊不溢出，底栏三段不换行，`⋯` 与面板按钮仍在原位
- [x] 6.5 停用插件，确认胶囊消失、控制台无残留监听、会话日志文件未被写入

## Workflow follow-up

- 归档变更前确认 `openspec validate add-today-cost-badge --strict` 通过。
- 归档后在主 spec 中确认 `conversation-cost` 的 Purpose 已随归档写入。
