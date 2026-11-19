# 主题 token 语义误判导致弹窗透明

## 现象

弹窗内能看到背后的会话文字，卡片与面板都没有实底。

## 根因

把 `--dsw-alias-bg-skeleton` 当成"面板底色"用了。它在暗色主题下是 `rgba(255, 255, 255, 0.08)`，浅色主题下是 `rgba(0, 0, 0, 0.04)`，语义是骨架屏的淡色叠加，不是不透明表面。面板底色落在它上面，等于半透明。

## 正确的表面 token

- `--dsw-alias-card-fill`：卡片实底，浅色 `rgb(250,250,250)`、深色 `rgb(33,33,35)`，不透明。
- `--dsw-alias-bg-module-platform`：模块级实底，浅色 `rgb(245,246,247)`、深色 `rgb(53,54,56)`，不透明。
- `--dsw-alias-bg-skeleton`：半透明叠加，只用于占位与轻量 hover。

## 修法

面板用 `--dsw-alias-card-fill` 作底；卡片的层次用 `color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)` 叠在实底上，叠完仍是不透明。

## 可复用的检查

- 给浮层选底色前先确认 token 的值，不靠名字猜；`bg-skeleton`、`*-fill-hover` 这类多半带透明度。
- 需要"在实底上做层次"时，用 `color-mix` 叠在实底 token 上，不要直接叠加半透明背景。
