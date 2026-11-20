# Git Preview Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, with one fresh final review.

**Goal:** 减少自动 Git 预览打断，并让文档来源名称对应 tmux 标题。
**Architecture:** CLI/API 传递 `activate`；后台事件只交给已有合并通知，显式查看仍由 BlockHost 打开。工作区传递真实 pane index，来源栏组合 label、index、command。
**Tech Stack:** Node/Express、原生浏览器 JS、tmux、Vitest/JSDOM。
**Spec:** `docs/superpowers/specs/2026-11-20-git-preview-cadence-design.md`

## Global Constraints

保留其他任务、现有 tmux 会话和服务管理方式；不增加依赖或冷却计时器；只提交本次改动。用户已授权完成后提交、推送和本机部署。全局规则仅更新已有托管区块并备份。

## Review Focus

后台请求不能触碰 block 生命周期；显式查看固定 hash；窗口与服务器隔离；pane index 不得由内部 ID 推算；触发规则无每笔提交的残留指令。

### Task 1: 后台 Git 入口

**Files:** `bin/anymux.mjs`、`lib/api/git.js`、`plugins/git/client/js/git-block.js`；`test/lib/blocks-api.test.js`、`test/client/git-block-preview.test.js`。
**Interface:** `git show --background` → `/api/git/open {activate:false}` → `open-git` → 合并通知；缺省 `activate:true`。
- [x] 先加 API 与客户端行为测试，运行并观察后台请求仍激活的失败。
- [x] 增加 CLI 参数、布尔校验和后台通知分支，保留普通打开。
- [x] 运行对应 Vitest 文件；Expected: 全通过，后台不读取 log/show，点击查看才加载。

### Task 2: 用户可识别的来源窗格

**Files:** `lib/tmux.js`、`lib/workspace/tmux-provider.js`、`plugins/agent-docs/client/js/agent-docs.js`；相关 tmux/workspace/agent-docs 测试。
**Interface:** 工作区 pane 的 `index` 是真实 tmux `pane_index`，显示 `[label] index:command`，空标签省略，未知序号不猜。
- [x] 先加非零真实 index、无标签、跨服务器和未知来源测试并观察失败。
- [x] 更新 tmux 格式/解析与 workspace pane view，渲染来源及回复提示。
- [x] 运行相关测试；Expected: 名称一致，无内部 `%ID` 显示。

### Task 3: 触发规则与验收

**Files:** `AGENTS.md`、`CLAUDE.md`、`skills/agent-docs/{SKILL.md,instructions.md}`。
**Interface:** 任务交付每实际仓库一次，后台命令；中间提交、重试、日志、纯文档任务不触发；显式查看照常。
- [x] 记录旧规则的 5 场景基线，更新规则后用新上下文重复验证。
- [x] 运行相关客户端、API、tmux 和托管规则测试，做一次新上下文全分支评审。
- [ ] 检查暂存区，fetch 后普通提交推送；备份并部署必要文件，以 launchd 重启 Node。
- [ ] 校验 API、实际 pane index、静态文件与 tmux 稳定性；更新已安装规则，任务交付后台登记一次提交，记录工作日志。
