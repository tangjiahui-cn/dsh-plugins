# 客户端插件点开后整块消失

## 现象

胶囊在会话标题行正常可见；点击后胶囊与弹窗一起消失，页面没有可见错误提示。

## 根因

1. **远程服务访问在 try 之外**。余额查询写在 `useEffect` 里，第一行是 `const account = remote?.account`，位于 `try` 之前。`remote` 是远程服务的代理对象，未授权时读取属性即抛错；异常从 effect 冒泡，React 卸载整个 slot entry，胶囊随之消失。
2. **把翻译函数当字典用**。`ctx.locale.bind(ns)` 返回的是 `t(key)` 函数，代码写成 `t.today`、`t.input`，取到 `undefined`，弹窗里的标签全为空。这不会让胶囊消失，但会让弹窗看起来没有内容。
3. **缺少兜底**。注册到 slot 的组件没有 ErrorBoundary，任何渲染期或 effect 期异常都会清空整块插槽。

## 定位过程

- 症状是「整块消失」而不是「弹窗没弹出来」。只有 slot entry 被卸载才会整块消失，据此把排查范围收到 effect 与渲染期抛错。
- SSR 渲染测试通过，说明 JSX 结构没有问题；真实环境与测试的差异只在 `remote` 代理和 `locale.bind` 的返回值。
- 结论：effect 里那句属性访问是唯一符合「点开才触发、触发即整块消失」的路径。

## 修复

- `getBalance` 全流程（取服务、取版本、调用）包进 `try/catch`；失败只隐藏余额行，卡片照常渲染。
- 文案改为 `t('key')`，字典只传给 `ctx.locale.register`。
- 增加 ErrorBoundary，兜底渲染一个最小胶囊并打印 `[useage] render failed`，单块异常不再清空插槽。

## 可复用的检查

- slot 组件里访问 `ctx.remote.*`、`ctx.slots`、`ctx.locale` 的属性，一律放进 `try`，失败降级为「该块不渲染」。
- `ctx.locale.bind(ns)` 是函数；字典对象只用于 `register`。
- 注册到 slot 的组件都包一层 ErrorBoundary。
- 验证顺序：先跑 SSR 渲染测试排除 JSX 问题，再查 effect 与服务访问；两者都排除后，才怀疑宿主插槽契约。

## 涉及文件

- `plugins/useage/client.js`
- `plugins/useage/test/client-render.test.js`
