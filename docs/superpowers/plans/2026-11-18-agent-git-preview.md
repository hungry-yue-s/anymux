# Agent Git Preview Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Agent 能打开自己的确定提交，用户在所属窗口的侧栏查看改动。

**Architecture:** Git 插件提供受路径约束的打开 API，CLI 发送来源窗格和仓库。前端沿状态事件定位窗口，BlockHost 持久保存目标，Git block 切到提交详情。

**Tech Stack:** Node.js、Express、现有浏览器 JavaScript、Vitest/JSDOM。

**Spec:** [设计](../specs/2026-11-18-agent-git-preview.md)

## 约束与验证重点

复用现有插件和预览渲染；不增加依赖；不碰 tmux 生命周期。验证非法路径和提交、历史范围外提交、后台窗口恢复、重复到达、提交草稿、modal 与键盘焦点。

## 实施

- [x] 添加 API 与前端回归测试，确认当前缺失入口导致失败。
- [x] 实现 CLI、Git 打开 API 和确定提交的历史定位。
- [x] 实现按窗口保存的自动 block 打开、标签提示和通知。
- [x] 更新调用文档和本项目 agent 规则，运行相关与全量验证，审查差异。
- [ ] 提交、推送并更新运行版；验证实际 API 和静态资源，再用新命令打开本次提交，记录工作日志。
