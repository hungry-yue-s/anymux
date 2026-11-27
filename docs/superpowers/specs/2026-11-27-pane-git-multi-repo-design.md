# 每窗格 Git 顶栏、多仓库 / Worktree 自动发现与来源清晰化设计

## 背景与目标

1. **Git 入口下沉到每个窗格**：将左上角全局顶栏的 `.pane-git-chip` 彻底移除（全模式移除，保留 `Alt+Shift+G` 与命令面板入口），把 Git 状态与快捷入口放到每个窗格自带的 28px 顶栏 `.seam-rail` 中。
2. **多项目 / 多 Worktree 自动追踪与折叠展示**：当在 workspace 根目录启动 Agent 或任务同时跨越多个项目、多个 git worktree 时，自动聚合当前窗格相关的所有 Git 仓库，在单行顶栏里折叠展示，并通过弹出浮层展开切换，绝不增加 `.seam-rail` 高度或触发 tmux resize。
3. **Git 预览窗与分窗 Tab 来源清晰化**：预览窗顶部直接显示仓库名、主仓库/Worktree 标识、可读路径、Worktree 切换菜单与快捷操作；右侧分窗 Tab 自动消歧（linked worktree 显示 `项目名 · worktree名`，同名仓库自动补父目录）并在 Tooltip 中显示完整绝对路径。

## 已确认的设计取舍

- **Agent 触及外部仓库的策略（方案 A）**：写操作 / 命令执行 / Stop 触及的外部仓库优先置顶；纯读取操作触及的外部仓库同样记录，但放在折叠列表较低优先级（干净且超出上限时优先淘汰）。
- **左上角全局 Git chip（方案 B）**：全模式彻底移除左上角全局 `.pane-git-chip`。

## 多仓库发现机制

`lib/git/repo-discovery.js` 提供三层融合发现：

1. **当前目录与同仓 Worktree**：以窗格 `pane_current_path` 向上查找 `.git`；若在仓库内，结合 `git worktree list --porcelain` 枚举主仓与所有 linked worktree。
2. **Workspace 浅层扫描**：当窗格 `cwd` 本身不在 Git 仓库内时，对直接子目录以及 `.worktrees` / `.anymux-worktrees` / `worktrees` 下的工作树做受限预算（120 次 `stat` / 80ms 超时）的浅层扫描。
3. **Agent 工具调用实时追踪（`PaneRepoTracker`）**：通过 `agent-events` 钩子（`PreToolUse` / `PostToolUse` / `Stop`）的 `agent-events/raw` 事件以及 `POST /api/git/open`，解析工具入参路径、命令中的 `cd` / `git -C` / `git worktree add` 路径，校验 `roots` 后归属到对应 `paneId`，区分 `agent-write` 与 `agent-read`。

## 后端接口契约

- **`GET /api/git/status`**：在原有字段基础上补充 `mainRoot`、`repoName`、`isWorktree`、`hasWorktrees`、`worktreeName`、`displayPath`。
- **`GET /api/git/pane-repos?paneIds=%1,%2`**：单次批处理拉取窗口内各窗格当前目录及发现到的全部仓库摘要（按仓库根去重并带 2.5s 短缓存），返回 `{ panes: { [paneId]: { cwd, repos } } }`，按 `cwd > 脏 agent-write > 脏 worktree > 脏 workspace > 净仓库 > agent-read` 排序。
- **写操作与事件失效**：所有 Git 写接口清除摘要缓存；`PaneRepoTracker` 新增仓库或写操作触发节流广播 `pane-git-changed`（经 `/ws/status` 转发到前端）。

## 前端交互设计

- **窗格顶栏（`.pane-git-slot`）**：
  - 0 个仓库：隐藏槽位，保持 `.pane-ctx`。
  - 1 个仓库：显示单个紧凑 chip（分支图标 + 可选 `WT` + `项目名/分支` + `●N` + `↑↓`）。
  - 2+ 个仓库：主 chip + 折叠触发按钮 `+N · ●M ▾`；在窄窗格（`@container pane`）下自动折叠为汇总 pill `⎇ K · ●M ▾`。
  - 点击折叠触发按钮打开固定定位、视口避让的 `.pane-git-popover`，分“当前与 Agent 触及”和“其他 Worktree 与工作区”两组展示，支持关键词筛选（>5 个仓库时自动显示）与键盘导航，点击直接打开对应仓库的 Git 预览。
- **Git 预览窗上下文栏（`.git-context-bar`）**：
  - 在 `.git-block` 顶部展示 `[Worktree]` / `[主仓库]` 标签、仓库/工作树名称、可读路径（`title` 为完整绝对路径）、同仓 Worktree 快速切换下拉、复制路径和浏览目录按钮。
- **分窗 Tab 消歧**：
  - `BlockHost` 新增 `setTooltip`，`FilePreview` 优先读取 `tab.block.tooltip`。
  - Linked worktree 自动命名为 `repoName · worktreeName`，同窗口内发生重名的独立仓库自动附加区分父目录。
