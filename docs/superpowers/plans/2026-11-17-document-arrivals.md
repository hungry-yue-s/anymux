# 文档后台进入窗口侧栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 文档到达时加入所属窗口的侧栏，返回即可阅读；新 Tab 有新文档标记及短暂强调，所有自动打开行为都有可回看的提示。

**Architecture:** 复用 FilePreview 按服务器、tmux 实例、窗口持久化的 dock。files-commands 解析事件所属窗口，当前窗口正常打开，其他窗口先保存；通知面板保存本浏览器的文档记录。无需新增服务。

**Tech Stack:** 现有浏览器 JavaScript/CSS、localStorage、Vitest/JSDOM。

**Spec:** 用户本轮明确要求的后台加入、返回可见、Tab 效果和自动打开提示。

## Global Constraints

- 保留现有会话、键盘焦点和其他窗口的侧栏状态。
- 不把旧 tmux 实例的记录恢复到新实例。
- 明确为 background 的进度不抢当前标签、不发提示。
- 所有主题使用现有 token；减少动态效果时保留文字提示。

## Review Focus

- 浏览器后台仍接收 dock 文档，普通文件和 URL 不抢屏幕。
- watcher 多窗格匹配优先当前窗口，避免任意选中项目的第一个窗格。
- 接收和恢复之间用户切窗口、打开 modal，不丢失待处理文档。
- 通知刷新和页面重载保留文档记录，点击仍定位到原服务器。
- 同路径事件去重；replaces 保持顺序，不复活已删除窗口。

## Tasks

- [x] Task 1: 在 `test/client/agent-docs-dock.test.js` 增加后台加入/返回/标记/去重/旧实例回归，先运行并确认失败；扩展 `file-preview.js` 的窗口存储和自动打开标记使其通过。
- [x] Task 2: 更新 `files-commands.js` 的窗口定位和通知分支，`app.js` 的后台 dock 事件分发；测试来源身份和进度文档行为。
- [x] Task 3: 在 `notifications.js` 保存文档提示并支持正确打开，扩展 `blocks-kit.js` 的可停留提示；增加通知刷新/去重/恢复测试。
- [x] Task 4: 在 `file-preview-workspace.css` 增加“新”标记和有限强调，尊重 reduced-motion；更新 `CLAUDE.md` 与 `docs/agent-docs.md` 的旧契约。
- [x] Task 5: 相关测试、必要完整回归、真实浏览器视觉检查以及最终 diff 检查。

交付按仓库规则提交、普通推送并静态部署；部署后核对资源哈希和现有会话，记录工作日志。
