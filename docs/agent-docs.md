# Agent 文档分窗

Agent 在终端里写方案、设计、调研、评审结论、计划这类长内容时，写成文档，在终端右侧的分窗里打开。用户一边看文档一边和 agent 对话，不用在对话历史里来回翻。适用于 Claude、Codex、Qoder、DeepSeek Harness，以及任何会写文件的 agent。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| skill `agent-docs` | `skills/agent-docs/SKILL.md` | 什么时候写文档、放在哪、什么时候放进项目、怎么问用户 |
| 常驻规则 | `skills/agent-docs/instructions.md` | 写进各 agent 全局指令的一小段，保证每个会话都知道这件事；`{{anymux}}` 在安装时换成实际命令 |
| CLI | `bin/anymux.mjs` | `anymux doc path`、`anymux open --dock/--background/--replaces` |
| 服务端 | `plugins/agent-docs`、`lib/agent-docs/`、`lib/api/agent-docs.js` | 草稿路径、文档类型与建议、往窗格填字、发现新文档 |
| 页面 | `FilePreview.openDocked`、`files-commands.js`、`plugins/agent-docs/client` | 静默进分窗或提示、文档上方的提示栏 |

## 安装

设置 → 管理中心 →“Agent 文档分窗”：为全部 agent 或单个 agent 安装。每个 agent 装两样东西：

| Agent | Skill | 常驻规则写在 |
|---|---|---|
| Claude | `~/.claude/skills/agent-docs` | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/skills/agent-docs` | `~/.codex/AGENTS.md` |
| Qoder | `~/.qoder/skills/agent-docs` | `~/.qoder/AGENTS.md` |
| DeepSeek Harness | `~/.dsh/skills/agent-docs` | `~/.dsh/AGENTS.md` |

面板启动时如果带着 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`QODER_CONFIG_DIR` 或 `DSH_HOME`，就用它们指向的目录。Qoder 和 DeepSeek Harness 的位置来自它们发布的包：Qoder CLI 1.1.89 读 `~/.qoder/AGENTS.md` 和 `~/.qoder/skills`（也读 `~/.agents/skills`）；`@deepseek-ai/dsh` 0.2.2 的 `dsh-agent-instructions` 读 `$DSH_HOME/AGENTS.md` 与 `~/.agents/AGENTS.md`，`dsh-skill-filesystem` 读 `$DSH_HOME/skills` 与 `~/.agents/skills`。

常驻规则写在 `<!-- >>> anymux agent-docs >>> -->` 和 `<!-- <<< anymux agent-docs <<< -->` 之间，文件里其它内容不动；修改前备份到面板配置目录的 `backups/`。项目更新了规则后，管理中心显示“有新版本”，再点一次就原地替换。移除只删这一段；文件里只剩这一段时整个删掉。

安装脚本不把 `anymux` 放进 PATH，所以规则里的命令是 `node "<仓库>/bin/anymux.mjs"`，bash、PowerShell 和 cmd 里都能直接运行。

远程机器的管理中心不经 Hub 转发：要在远程机器的 agent 里用，在那台机器的面板上安装。不装也能用一半：新文档的发现和打开不需要 agent 配合（见下）。

## 文档放在哪

agent 按顺序取第一个适用的：

1. 用户这次指定的路径；
2. 项目 AGENTS.md / CLAUDE.md 里点名的文档放置约定（本仓库见 [AGENTS.md](../AGENTS.md)「文档放置」）；
3. 正在使用的 skill 规定的位置，例如 superpowers 的 `docs/superpowers/specs/`、`docs/superpowers/plans/`，照它的流程走，不另建草稿；
4. `anymux doc path <主题>` 给的草稿位置。

`anymux doc path` 从当前目录往上找 `.git`，返回 `<项目>/.anymux/docs/<主题>.md`，并在仓库自己的 `.git/info/exclude`（linked worktree 用主仓库共享的那份）里加 `/.anymux/`，不改项目的 `.gitignore`。不在项目里，或项目在预览根之外时，放到 `~/.local/share/anymux/docs/<目录名>/`。它只建目录，文件由 agent 用自己的写文件工具写，这样写入照常经过 agent 的权限和 diff。Windows 上打印原生路径。

## 打开

两条路，结果相同，同一文件只开一次：

- agent 执行 `anymux open --dock <路径>[#标题]`（`--background` 只加标签不切过去，`--replaces <旧路径>` 把旧标签换成新路径）；
- Node 端的 watcher 每 2 秒看一次窗格所在项目里的文档目录，发现新文件就宣告。不需要 agent 做任何事，superpowers 这类不认识面板的 skill 写的文件也能打开。

watcher 看的目录和打开方式（`lib/agent-docs/profiles.js`）：

| 文件 | 类型 | 打开 |
|---|---|---|
| `.anymux/docs/*.md`、`*.html` | 草稿 | 切到它 |
| `docs/superpowers/specs/*.md` | 设计 | 切到它 |
| `docs/superpowers/plans/*.md` | 计划 | 切到它 |
| `.superpowers/sdd/*/progress.md` | 进度 | 只加标签 |

第一次看到一个项目时只记下已有文件，之前的文档不会被打开。改动不再宣告：已开的标签每 1.5 秒自己刷新，用户关掉的标签不会弹回来。

页面收到事件后：

| 情况 | 结果 |
|---|---|
| 正看着该窗格所在的窗口，分窗展开着 | 加标签。切到它，或“只加标签”时留在后面并标一个圆点 |
| 正看着该窗口，还没有分窗 | 新建分窗（终端会缩一次）；“只加标签”的文档不为它新建 |
| 分窗收起着 | 标签加进去，分窗保持收起，展开按钮显示新文档标记 |
| 收到事件时在别的窗口，或浏览器在后台 | 保存到所属窗口分窗，返回后直接显示；普通文档有 15 秒提示和通知列表记录 |
| 手机、有文件弹窗开着 | 保存待显示文档；有侧栏显示条件后恢复，提示可从通知列表再次查看 |
| 任何情况 | 不弹 modal，键盘焦点留在原处 |

watcher 的事件带同一项目的所有窗格，优先匹配当前窗口，否则采用事件所在窗口。文档状态按服务器 ID、tmux 实例和窗口 ID 隔离，不跨实例恢复。只有当前订阅服务器送达的事件会进入本浏览器；未连接时不回补未收到的事件。

新 Tab 有“新”文字标记和一次短暂强调；未查看标记保留到激活，减少动态效果时保留文字。自动打开成功也提示，后台加入提示提供“查看文档”。提示停留 15 秒，指针悬停或键盘聚焦时暂停消失；通知列表保留最近 50 条本浏览器的文档记录，刷新服务端通知不会清掉它们。

## 文档上方的提示栏

agent 文档（按上表识别）的预览上方有一条提示栏：类型、来自哪个窗格，以及“回复…”按钮。草稿的 front matter 里有放置建议时，再显示建议和“确认 / 改位置… / 保持草稿”：

```yaml
---
anymux:
  status: proposed          # draft | proposed | placed | kept
  target: docs/agent-docs-design.md
  reason: 同类设计文档都在 docs/*-design.md
  alternatives: [docs/design/agent-docs.md]
  also: CLAUDE.md 加一行链接
---
```

按钮把一行答复填进 agent 的窗格（`POST /api/agent-docs/reply`，`tmux send-keys -l`），**从不按回车**：agent 可能正在工作或显示权限菜单，提交上去可能答错地方。用户在终端里看过、补充后自己发送。窗格正处于复制模式（在滚动查看历史）时拒绝并提示先退出，否则这些按键会被当成复制模式的命令。`anymux:` 这段不显示在属性卡片里。

## 人什么时候参与

| 动作 | 是否需要确认 |
|---|---|
| 写草稿、在分窗打开 | 不需要 |
| skill 自己的文档（superpowers 的设计、计划） | 只有 skill 自己的审阅步骤，面板不另加 |
| 草稿放进项目：用户指定、约定写明直接放、按约定往已有文档追加一小段 | 不需要，事后告知 |
| 新建约定里没有的类型、多个候选位置、新建目录、对外文档、大段改写用户写的内容、可能含敏感信息 | 先问：front matter 写建议，对话里列编号选项并结束这一轮 |
| 提交、推送 | 按项目规则；会自动推送的项目，问的时候说明 |

## 接口

| 接口 | 调用方 | 说明 |
|---|---|---|
| `POST /api/open` | CLI（node token） | 新增 `placement: 'dock'`、`activate`、`replaces`、`fragment`、`kind`、`owner`；已知文档自动补上类型 |
| `POST /api/agent-docs/draft` | CLI（node token） | `{cwd, name, ext}` → `{path, nativePath, project, inProject, excluded, exists}` |
| `GET /api/agent-docs/info` | 页面 | `?path&paneId` → `{path, doc: {kind, label, owner, open, proposal} \| null}` |
| `POST /api/agent-docs/reply` | 页面（同源） | `{paneId, text}`，一行、≤2000 字、不回车 |

这些都是 Node 接口，经 Hub 的 `/n/:serverId` 同样可用。管理中心的 `POST /api/managed-resources/instructions/:target/{install,uninstall}`（`target` 为 `claude`、`codex`、`qoder`、`dsh` 或 `all`）只在 Hub 上。

## 没做的

- Node 端跨浏览器的完整文档历史和断线期间文档回放；当前后台加入与通知记录保存在接收到事件的浏览器。
- 在预览里选中一段文字“引用到对话”。
- 用户自己的文档目录类型（`doc-profiles.yml`）：目前只认 Anymux 草稿和 superpowers。
