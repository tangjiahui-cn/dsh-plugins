# 余额查询失败：绕过了授权范围直接调 owner-only 端点

## 现象

弹窗底部「账户余额」显示查询失败。同一时期又能看到一次正确余额（¥327.02），两种状态并存。

## 事实

- 余额不在会话投影里，只能通过账户服务的 `getBalance` 取。
- `remote.account` 是独立服务，不挂在 `remote` 上；设置页显式注入 `remote.account`。
- `account/watch` 是 owner-only 端点；设置页在 `ctx.remoteAccess.whenAccess('account/watch', …)` 的作用域内读余额。
- 用户 token 只存在 Host 侧，插件与浏览器都拿不到，也不能用它直接请求 Platform 的 HTTP 接口。

## 根因

插件客户端绕过授权范围直接调 `getBalance`，被拒；此前那次成功显示来自设置插件维护的 `accountUi` 快照（它走的是授权通道），不是插件自己查到的。

## 修法

1. 服务获取用 `ctx.get('remote.account')`，取不到时降级，不让插件整体不激活。
2. 调用前用 slot 的 `useAccess('account/watch')` 判定，无权就不发请求。
3. 失败回退 `accountUi.getSnapshot().details.balance`，有值先显示。
4. 每次展开仍发起一次实时查询，成功后覆盖兜底值。
5. 失败写 `[useage] balance unavailable <原因>` 到控制台，红字 `title` 带原因。

## 后续定位

- 修掉另一处 Hook 误用（见 [hook-called-inside-effect](./2026-11-19-hook-called-inside-effect.md)）后，查询才真正发出去；此前显示的失败有一部分是那个崩溃被 `catch` 吞成了业务错误。
- 现在的链路：`account/watch` 授权作用域内查询 → 直连 `remote.account.getBalance` → `accountUi` 快照兜底。
- 「余额只在点开设置页后才变」的原因是兜底快照只在设置页加载或账户状态变化时刷新，插件没有触发它刷新的入口。

## 未解决的边界

- 插件上下文里 `account/watch` 恒为 false 时，实时查询永远失败，只能读快照，数值可能滞后。
- 没有 `accountUi` 服务（未启用 settings-account）且实时查询被拒时，只能显示失败态。
- 根治需要 DSH 对第三方插件开放可读余额的 remote 端点，或允许插件在自己的授权作用域内调用。

## 涉及文件

- `plugins/useage/client.js`
