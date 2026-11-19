# Notes 索引

写代码或改文件前读一次本索引；命中条目先读对应文件，再决定方案。新增记录时同时更新本表。

| 文件 | 症状 | 何时读 |
| --- | --- | --- |
| [problems/2026-11-19-slot-component-vanishes-on-click.md](./problems/2026-11-19-slot-component-vanishes-on-click.md) | slot 组件点击后整块消失 | 写 DSH 客户端 slot 组件，或在组件里访问 `remote` / `locale` / `slots` 服务前 |
| [problems/2026-11-19-translucent-theme-token-selected-as-panel-fill.md](./problems/2026-11-19-translucent-theme-token-selected-as-panel-fill.md) | 弹窗/浮层透明，背后内容可见 | 给浮层选主题 token 作底色前 |
| [problems/2026-11-19-balance-query-bypassed-remote-access.md](./problems/2026-11-19-balance-query-bypassed-remote-access.md) | 余额查询失败或时有时无 | 在客户端插件里调用 `remote.*` 端点，尤其是 owner-only 端点前 |
| [problems/2026-11-19-hook-called-inside-effect.md](./problems/2026-11-19-hook-called-inside-effect.md) | 业务提示变成 `Minified React error #321` | 在 effect / 回调里调用 `use*` Hook，或把框架异常写进业务文案前 |
