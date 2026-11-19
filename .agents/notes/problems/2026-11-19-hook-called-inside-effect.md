# 在副作用里调用 Hook：Invalid hook call 被当成业务失败

## 现象

弹窗底部余额显示「查询失败 `Minified React error #321`」，但卡片与其他功能正常。

## 根因

`useAccess` 是 Hook，被写在 `loadBalance`（`useCallback`）里，而 `loadBalance` 由 `useEffect` 调用。渲染期之外调用 Hook，React 抛 `#321 Invalid hook call`；这个异常被 `loadBalance` 的 `catch` 捕获，写进业务错误文案，于是界面显示成「接口查询失败」。

## 修法

- Hook 只在组件或 Hook 的顶层调用：把 `useAccess('account/watch')` 提到组件体，算出布尔值 `canReadAccount`。
- 回调里只读这个布尔值，并把它列入 `useCallback` 依赖。
- `catch` 不吞框架异常：React 渲染期错误应交给 ErrorBoundary 上抛。

## 可复用的检查

- 名字以 `use` 开头的一律是 Hook，只能在渲染期调用；effect、事件回调、定时器里只能读已算好的值。
- 看到 `Minified React error #xxx`，先按 React 错误码表定位（`#321` 即 Invalid hook call），不要往接口或权限方向查。
- 业务 `catch` 里要能区分框架异常与业务失败，否则真正的崩溃会被写成「查询失败」并掩盖一整天。
