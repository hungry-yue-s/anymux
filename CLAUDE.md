# CLAUDE.md

通用 Agent 工作流程（含任务完成后自动提交与推送）见 [AGENTS.md](AGENTS.md)，执行本文件时同样遵守。

## 一切皆插件

面板跑在 Cordis 插件内核上（与 DeepSeek Harness 同一内核，vendor 在 `vendor/cordis` 等）。没有手写的组装入口：`profiles/panel.yml` 列出插件，`bin/panel.js` 按它组装并启动（`--dump-config` 打印组装结果）。每个功能是 `plugins/<id>/`：`index.js` 是服务端接线，`client/` 是它的前端（`page.json` 声明页面上的脚本和样式），业务模块在 `lib/`。插件注册的一切（路由、定时器、监听器、页面上的脚本）随插件撤销。约定、Cordis 的使用陷阱、HTTP 管线、tmux server 的选择和插件表见 [docs/plugins.md](docs/plugins.md)；新功能写成插件，不要往别处加组装代码。`server/index.js` 只是给旧服务单元留的兼容入口。

## 服务管理

**严禁使用 systemd 以外的方式启停服务。**

- 重启：`systemctl --user restart anymux`
- 状态：`systemctl --user status anymux`
- 日志：`journalctl --user -u anymux -f`

禁止的操作：
- `kill` / `pkill` 进程后手动 `node bin/panel.js`（或旧的 `node server/index.js`）
- `nohup node bin/panel.js &`
- 任何绕过 systemd 的手动启动方式

原因：systemd service 配置了 TLS 证书、认证凭据、HTTP 跳转端口等环境变量。手动启动会丢失这些配置，导致 HTTPS 不可用、认证失效。

**静态文件改动不需要重启。** `ui` 插件挂载各插件的 `client/` 目录并组装主页面：HTML 每次都校验（`no-cache` + ETag），并在渲染时把本地 JS/CSS/字体 URL 改写成带内容哈希的 `?h=...`，这些 URL 可缓存一年。所以改 `plugins/*/client/` 下的文件后用户刷新浏览器即生效，不再需要手动改 `?v=`——只有改服务端代码（`plugins/*/index.js`、`lib/`、`kernel/`）或 `page.json`/`profiles/` 才需要 `systemctl --user restart`。动态加载的本地资源不经过改写，只走 `no-cache` 校验。

源码提交与运行版更新分别验证。服务可能从 `~/.local/share/anymux/releases/<版本>/` 等安装目录运行；先核对服务的工作目录，再验证实际页面加载的资源内容与哈希。只更新、提交或推送源码，不能据此宣称运行中的面板已生效。旧安装版的合并脚本与当前插件文件可能不同，应只移植所需静态补丁并保留可核对的备份，不为静态更新重启 tmux。

**终端字体按 unicode-range 切片。** 完整字体每个字重约 6 MB，页面不得预载或引用 `AnymuxMono-*.woff2`（它们只是 `scripts/build-font-subsets.mjs` 的输入）。首屏只预载核心片。字体和渲染器都在打开终端 socket 之前定好，attach 带的就是最终网格（`_mountTerminal` 的 `rendererReady`），不要改回首个输出之后再换字体：那会改变网格，在 Windows 上等于再 attach 一次并清屏。终端最多等核心片 `CORE_FONT_WAIT_MS`，超时后这次挂载保持系统等宽字体，核心片晚到也不自动切换（`_applyLateCoreFont`），要等下一次真实尺寸变化或下一次挂载才用上。中文和 Nerd 图标片由 `plugins/terminal/client/js/terminal-fonts.js` 按需加载：xterm 画在 canvas 上不会触发 unicode-range 加载，必须经 `TerminalFonts.ensure()`，切片到达后调用 `term.clearTextureAtlas()`。切片和 `plugins/terminal/client/css/terminal-fonts.css`、`plugins/terminal/client/js/terminal-fonts-data.js` 都是生成文件，只有源字体变化时才重新生成并提交。

**Windows** 上服务管理器是计划任务（`\anymux\anymux` 与 `\anymux\tmux-server`），统一经 `scripts/install-service.ps1` 操作：`restart` / `status` / `logs`（加 `-Tmux` 针对 tmux server）。同样禁止手动 `node bin/panel.js` 或直接 `Stop-Process` 后自行启动——AUTH/TLS/端口配置在 `%USERPROFILE%\.config\anymux\windows-service.json`，只由 `scripts/windows/run-panel.ps1` 注入。`restart -Tmux` 会结束 tmux server 和所有会话；只更新包装脚本 `run-tmux-server.ps1` 时用 `reload`，它不碰 tmux。

## 多服务器：Hub 与 Node

完整说明见 [docs/architecture.md](docs/architecture.md)。每份安装都是一个 Node，只管本机；浏览器所用的那份面板同时是 Hub，经 `/n/:serverId` 把机器相关的请求原样转给对应的 Node。

不变量：

- **本机免登录仅信任直接回环请求**：同时核对 TCP peer、回环 Host/真实端口及同源 Origin/Referer，拒绝转发头和跨站 Fetch Metadata；HTTP、WebSocket 与 `/n/` 共用规则。Node-only 始终要 token；`auth.trustLocal: false` 可关闭本机免登录。不要只凭 Host 或 X-Forwarded-For 认定本机。
- **Node 的 API 不带 serverId**（`/api/workspace`、`/api/metrics/*`、`/api/files/*`、`/ws/terminal/:paneId` 等）。要访问其它机器，一律走 Hub 的 `/n/:serverId`（`lib/hub/proxy.js`）；前端统一用 `Api.nodeUrl` / `Api.activeUrl` 拼路径，不要再写死 `/api/servers/:id/...` 这种按服务器分的机器接口。
- **对已装 Node 的机器，日常功能由 Node 本地执行**。SSH 用于 sftp 读取配对文件 `~/.config/anymux/node.json`，以及分别为 API 和终端维持独立的 `ssh -N -L` 端口转发（`lib/transport/ssh-connection.js`、`lib/hub/node-link.js`）。唯一的安装维护例外是用户显式触发的 `NodeInstaller`：完整 Node 安装，或固定的 Mosh 组件准备脚本；组件补装不打包替换应用、不重启服务。不得把此例外用于 Git、文件、监控或任意远程命令入口。
- **基础模式**（能 SSH 登录、没装面板，`lib/hub/basic/`）只提供工作区和终端。发往远端的只能是 `sh -s`（脚本走 stdin），或单个单词的 pty 命令（经 sftp 上传的脚本路径）；不要拼接带参数的远程命令行，因为 Windows OpenSSH 在 pty 模式下会把它拆碎。文件、监控等功能不要在基础模式里另写远程实现，那些功能的入口是“安装 Node”（`lib/hub/node-installer.js`、`scripts/remote/install-node.*`）。
- **只在 Hub 上处理、不转发的接口**：`/api/auth`、`/api/servers`、`/api/plugins`、`/api/managed-resources`、`/api/share`（`isRelayable` / `Api.isHubPath` 两处须一致）。
- **node token**（配对文件里的令牌）只能用来访问那台 Node 自己的 API。`/n/` 转发入口只接受可信本机直连或登录令牌，node token 即使来自回环连接也不能获得本机免登录权限，防止链式转发。
- HTTPS Node 按配对文件里的证书指纹固定，升级请求（WebSocket）也走同样的固定证书 agent（`pinnedAgent`）；不要退回 `rejectUnauthorized: false` 却不校验指纹。Node 在恢复的 TLS 会话上报告空证书：`pinnedAgent` 只缓存通过指纹的连接的会话，恢复成功即视为同一证书；不要换成 https.Agent 自带的会话缓存（它会缓存未校验的会话，恢复时又过不了指纹检查，进而重置整条链路）。
- **直连是可选的**（`transport.api` / `transport.terminal` = `direct`，默认 `ssh`）：只在 TLS + 指纹固定下进行，令牌不离开 Hub，检查通过才用，失败回到转发；直连失败不得重置 SSH 链路。配对和健康检查始终走 SSH。
- **Mosh 终端是可选实验**（`transport.terminal = 'mosh'`，见 docs/architecture.md）：`/api/mosh` 只认 node token 加 `x-anymux-hub-call`，转发时剥掉该头且不转发该路径，密钥不进浏览器和日志。Windows 上必须看到 `list-clients` 里出现该 mosh-server 的子进程才释放客户端启动队列，不得改回“CONNECT 后等固定时间”。结束进程前核对记录的身份（`lib/mosh/processes.js`），不凭历史 PID；Node 没确认清理干净时 Hub 不得回退到另一个 attach。由 Node 拉起的 tmux（mosh-server 的命令）必须删掉继承的 `TMUX`/`TMUX_PANE`。Windows 不作 Mosh 客户端（ENV-6）。

## 旧名兼容（tmux-web-panel → Anymux）

项目原名 tmux-web-panel（缩写 twp，原生 App 叫 Tmux Panel）。旧安装、未升级的 Hub/Node 和旧版原生 App 还带着旧名字，所以新代码**读两套名字、只写新名字**，对照表见 [docs/architecture.md](docs/architecture.md)「改名兼容」。不变量：

- 不得删除读旧名的兼容代码：`lib/legacy-names.js`（环境变量、目录）、`scripts/legacy-env.sh`、`x-twp-*` 请求头、`@twp-*` tmux 选项、`legacy-storage.js`、旧的托管标记和原生桥名。
- 应用目录一律经 `appDir()` / `anymux_dir` 取，不要再写死 `~/.config/anymux`：迁移没完成时旧目录才是真的。
- Windows 上旧目录只由 `install-service.ps1` 迁移（`Move-LegacyInstallation`），面板进程不碰：计划任务按路径引用设置文件，tmux 也占着旧目录里的日志。迁移只停旧 tmux 的包装脚本，不得结束 tmux。
- macOS 桌面版的旧安装继续用旧标签和 `/tmp/tmux-panel-*` socket 目录，不得替它改名。

## tmux server 守护与会话持久化

Linux 使用用户级 `tmux-server.service`，macOS 使用 `com.anymux.tmux-server.plist`；它们都由 `install-service.sh` 生成在用户服务目录中。这是为了让重启电脑后网页面板立刻能看到上次保存的会话。

工作链路：
1. 开机 → tmux companion service 跑 `tmux start-server`（macOS 为前台模式 `tmux -D`，Windows 为 `setsid -w tmux -D`）→ 加载 `~/.tmux.conf`
2. 面板服务启动，“会话保护”（`lib/session-protection/`）每 20 秒看一次 tmux：第一次看到某个 server 实例时，如果它没有会话或刚启动（2 分钟内），就用 `last` 快照自动恢复它还缺的 sessions/windows/panes，并在该 server 上记下 `@anymux-restored-at`（页面据此提示“已自动恢复”）
3. 面板每 5 分钟调用项目自带的 tmux-resurrect（`vendor/tmux-plugins/tmux-resurrect`）的 `save.sh` 保存；快照仍是 resurrect 标准格式，在 `~/.local/share/tmux/resurrect/`
4. 网页打开 → `lib/tmux.js` 的 `listSessions()` 跑 `tmux list-sessions`，看到所有 restored 会话

设置在每台服务器的“会话”页面（`/api/session-protection`，经 `/n/:serverId` 远程同样可用），存于 `~/.config/anymux/session-protection.json`。不用 tmux-continuum，也不需要往 `~/.tmux.conf` 加插件配置。

不变量：

- **部署必须使用 `vendor/tmux` 子模块构建的 tmux**：`install-service.sh install` 会调用 `scripts/build-tmux.sh`，原子部署到 `~/.local/share/anymux/bin/tmux`，不得退回系统 `PATH` 中的 tmux
  - Windows 同样构建 vendor 源码与项目补丁：`scripts/build-tmux-windows.ps1` 在 MSYS2 中构建，按内容哈希安装到不可变路径，避免覆盖运行中的 exe。DLL、cat、setsid 等从 MSYS2 根目录定位，不能按托管 tmux.exe 的父目录推断。`msysExecArgs` 必须传入真实 argv0 并启用 `MSYS=noglob`，否则路径引号或 `#{session_id}` 会被错误解释。pane 路径经 `toNativePath` 转换。
- **`~/.tmux.conf` 必须保留 `set -g exit-empty off`**：否则开机启动的空 server 等不到面板来恢复就自己退出了
- **不要在 `tmux-server.service` 里预创建会话**（如 `tmux new-session -d -s main`）：同名会话不会被恢复，启动超过 2 分钟后才看到的 server 也不再恢复
- **旧 `/ws/terminal` 的 Windows ConPTY 路径不得 resize 运行中的 tmux 客户端，也不得用 node-pty 的 `kill` 关闭它**：两者都可能带走整个 tmux server 和所有会话（`docs/known-issues.md` ENV-1）。尺寸变化走 `TerminalManager._setClientSize`（新客户端替换旧的），断开走 `_endClient`（只结束客户端进程），`conhost.exe` 由 `ConsoleReaper` 延后回收
- **Windows 上面板的 tmux 客户端一次只变更一个**：server 逐字节读新客户端的终端应答，这期间有客户端离开（别的会话的也算）就可能丢字节，剩下的会当按键进窗格（`docs/known-issues.md` ENV-3）。所以新接入和替换都排队经 `TerminalManager.whenClientCanStart` / `_inClientTurn`：确认旧客户端的进程已消失才启动，启动窗口内不结束别的客户端（`_endClient` 排队）。不要改回先启动新的、靠 `-d` 踢旧的；换 ConPTY DLL 也不是修复，实测同样漏。排队期间已取消的请求不得产生任何副作用。结束后超时仍活着就让接入失败并可重试（`TERMINAL_BUSY`，关闭码 1011），不并排启动；不要对同一个 pid 再结束一次（可能已被复用），只等 `onExit` 或确认 pid 已不存在。`onExit` 之后任何路径都不得再结束它
- **Windows 上被接管的连接立即失效，不等 `onExit`**：`onExit` 可能比进程消失晚约 1 秒，这段时间里旧 socket 的 resize 会反过来把会话抢回去。`_takeOver` / `_retire` 立刻把连接移出 `connections`、关闭 socket（接管用 1000，页面不再重连），`_leaving` 等待和 `onExit` 里的释放照常进行；消息入口先校验连接仍有效
- **客户端变更期间的输入留给下一个客户端**：网关的 `early`（接入前）和连接的 `heldInput`（从接受一次改变尺寸的 resize 起，到新客户端建立或尺寸改回）都只投递一次，总量受 `MAX_HELD_INPUT_BYTES` 限制，超过就以 1009 关闭并清空。不要把输入写给马上要结束的客户端。已经写入的，`_killClient` 按字节数等 server 读完（`INPUT_READ_*`，有上限）：这是尽力保护，不保证长粘贴，也不是 DA 问题的修复，不要拿它替代排队；没写过输入的客户端不等
- **Windows 上新窗格依赖 tmux 全局环境里的 `MSYS2_PATH_TYPE=inherit`**：没有它，MSYS2 登录 shell 会把 PATH 重置到最小集，窗格里找不到 claude、Node、Git（`docs/known-issues.md` ENV-2）。`run-tmux-server.ps1`、`lib/msys.js` 和会话保护的 `_applyOptions` 三处保证，不要去掉
- **Windows 上结束终端控制台要能证明没人在用**：`conhost.exe` 只能按 `pty.spawn` 的精确时间窗认领，不加余量（实测 30 个全部落在窗内）。进程里每个 `pty.spawn` 都必须经 `trackConsoleSpawn`（`lib/terminal/console-reaper.js`），它把时间窗记到 pty 退出；一个控制台还可能属于活着的 pty、或一个窗里不止一个控制台，就不结束。宁可漏清，不扩大窗口，也不要批量清理来历不明的 `conhost.exe`
- **环境问题要记录并由服务管理**：现象、证据和结论写进 `docs/known-issues.md`，检测和恢复做进服务，不靠人工救场。不要在默认 tmux server 上做接入、resize、断开实验。每条实验命令显式带 `tmux -S <私有 socket>` 或 `-L <唯一名称>`，并从实验及全部子进程环境移除 `TMUX` / `TMUX_PANE`；仅设置 `TMUX_TMPDIR` 不能隔离继承了 `TMUX` 的进程。清理前用同一组参数核对 `socket_path` 和 server PID 确实属于本次实验，无法确认归属就不结束。Windows 的绝对 tmux 路径会绕过 PATH 中的 shell 包装，不能把 POSIX 包装当作 Windows 隔离证明。
- **没有会话时绝不保存**：那次空快照会成为 `last`，下次重启就什么也恢复不了。`save.sh` 只能由 `SessionProtection` 在有会话时调用
- **`last` 不得停在空的或没写完的快照上**：保存时 tmux 不应答，`save.sh` 会写出空的或只有窗格的文件，并让 `last` 指向它（`docs/known-issues.md` ENV-13）。每次保存后和每个 server 实例第一次处理时，`repairLast` 把这样的 `last` 指回最近一份可用的快照（`isUsable`：有会话、有 `state` 行、至少有一行窗口）；`readLatest` 同样回退。不要去掉这两处，也不要改 vendored 的 `save.sh`
- **用户自己在 `~/.tmux.conf` 里加载了 tmux-resurrect（常见于 TPM + continuum）时，面板不自动保存和恢复**（`mode: 'external'`），只提供立即保存和找回会话，避免两套机制互相覆盖或重复恢复
- **从 Windows 的 Node 调 MSYS2 程序（tmux）必须用 `msysExecArgs`**（`lib/msys.js`）：Node 默认把 `"` 转义成 `\"`，MSYS 不认，布局字符串、带引号的命令或名字会被拆碎
- **`lib/tmux.js` 的 `listSessions()` 是只读**：不会自动创建/启动 tmux server。如果 server 不存在，网页就是空——这是设计意图，恢复责任在 companion service + 会话保护

排障：

- 启停 tmux server：`systemctl --user {start,stop,restart} tmux-server`
- 手动 `tmux kill-server` 后 unit 重启会拉起空 server，面板在下一次检查（≤20 秒）时自动恢复；也可以在“会话”页面的“找回会话”里按时间点恢复单个会话（作为新会话，不影响正在运行的）
- 只恢复窗口结构、目录，并按页面上勾选的程序重新打开（claude 用 `--continue`、codex 用 `resume --last` 接着上次的对话）；不恢复进程内存状态

## 原生工作台契约

完整设计见 [docs/local-workbench-design.md](docs/local-workbench-design.md)。`native-window` 使用真实 tmux 客户端，一个 xterm 渲染完整窗口；布局、prefix、自定义绑定、copy-mode、状态栏和 popup 的权威都在 tmux，不在浏览器。

- NativeWindowPool 保留每个标签页的客户端，刷新/断线重新订阅并获取原子重绘，普通 focus 和相同 resize 不得 reset。关闭订阅不等于终止窗格。
- `--panel-pty` 在 Unix/MSYS 内拥有自己的 PTY；此新路径原地 resize，只释放自己创建的 attach，不经过 ConPTY。前述 ConPTY 禁令及 Windows 客户端替换队列仍适用于旧路径，不能因此放宽。
- 原生握手应答通过 response 回到同一 PTY；用户 input 等恢复完成。快照验证实例和 pid，按完整 begin/end 边界与直播串行解析，不能以 capture-pane 文本或分块 reset 代替。
- Git 等焦点相关操作必须 context-request 即时查询真实 pid/tty；轮询缓存不能作为点击当刻的答案。viewId 只标识本地工具归属，不冒充 tmux windowId。
- `native_client_protocol` 检查运行中的 server。只更新二进制不代表旧 server 已升级；不得为了开启工作台结束现有任务。
- 终端与 API 的 SSH 转发使用独立物理连接；终端禁用 ControlMaster 复用。身份或证书改变时才整体失效，单条通道的迟到错误不能断开另一条健康通道。

## 终端首屏契约

打开一个窗口要尽快到稳定画面，最贵的是无谓的第二次 attach：Windows 上换尺寸就是换 tmux 客户端并清屏重画。所以：

- **先定尺寸，再开 socket。** 字体（见上）、WebGL 渲染器、右侧分窗占位都在 `connectTerminalWs` 之前定好。分窗恢复时立刻按保存的宽度占位（`_reserveDockSpace`），标签内容随后异步加载；保存为隐藏的分窗全程在 DOM 外构建，不得占位。`renderTerminal` 即使拿到已知窗格也要异步挂载，这样 `MsApp._mountTerminal` 同步设置分窗后，终端量到的才是最终宽度。
- **能不等就不等。** 工作区里已有目标窗格时直接挂载（`MsApp._knownPanes`），超过 `PANES_FRESH_MS` 或来自不完整读取的，在后台再核对一次；缺失或读取失败才阻塞查询。服务端挂载前的 `resolvePane` 不能省。
- **过时结果不落地。** `MsApp._routeGeneration` 每次路由递增，所有在 await 之后继续的路由入口（`_renderTerminal`、`refreshCurrentTerminal`、`server` 路由）都要校验，过时就不得写 DOM、`TerminalTarget`、`state` 或分窗。同一目标重复路由时如果 `isTerminalLive()` 就不重建。
- **工作区请求合并。** 路由和读取用 `refreshWorkspace(id, { shared: true })`；刚做完修改的调用方不能加 `shared`，那次进行中的读取可能早于修改。服务端 `getWorkspace` 同样单飞，`_mutate` 后作废。一次 `readSnapshot` 就读完整棵树和实例 ID；窗口缺窗格、读取失败都必须 `complete: false`，否则分窗和 block 的回收会误删。
- **取消一路到底。** 浏览器走了就不能再 attach：`attach-session -d` 会抢走当前画面。前端 `_cleanupTerminalResources` 关闭 pending socket 和重试定时器；`TerminalGateway.handle`、`attachBasicTerminal`、`TerminalManager.create` 和 Hub 的 `relayNodeUpgrade`、`proxyUpgrade` 都要在继续前检查 socket 还活着。升级中的 socket 要 `watchUpgradeSocket` 才能发现对端离开。
- **等待都有上限，但只限等待本身。** `Api.request` 默认读 45 秒、写 5 分钟，长传输不走它。`NodeLink` 的 `stallGuard` 分别限制排队、连接和等响应头；只有连接超时才判定转发已死并丢弃隧道，排队超时只取消那一个请求，开始传输后不限时。TLS 固定指纹和认证不因此放宽。终端 socket 收到任何帧后不得盲目重试。
- **一次失败的请求不能判隧道死刑。** 隧道一断，上面所有终端和下载都跟着断。健康探针 `NodeLink.info()` 失败后在新连接上再确认一次，还不通才 `reset`；只有这个只读探针重试，写请求和转发请求都不重试，401 和证书变化不需要第二次确认。凡是 `await` 之后要 `reset` 的地方都用 `_resetIfCurrent(tunnel, …)`，旧隧道的迟到结果不得影响新隧道。每次隧道失效 `logLinkLost` 记一行（时间、`serverId`、原因、错误码、退出码或信号），不写 URL、请求头、令牌、SSH 参数或 stderr。
- `plugins/terminal/client/js/terminal-trace.js` 记录每次打开的时间线（`TerminalTrace.enable()` 开启，`.last()` 读取），默认关闭，只存时间、网格和计数。`marks.stable` 是启发式，验收以真实界面截图和独立时序为准。

## 移动端工具盘交互契约

移动输入工具台 + 底部工具盘（drawer）在 `plugins/terminal/client/js/terminal.js` 的 `_createFabPanel` 和 `plugins/keypad/client/js/fab-drawer.js`（`keypad` 插件，关掉时终端没有工具盘）中实现；`.fab-tool` 保留为工具触发器的兼容类。修改时必须尊重以下约定：

- **软键盘与工具盘互斥**：xterm 的 `.xterm-helper-textarea` focus = 系统软键盘唤起的唯一信号。`document.addEventListener('focusin', ...)` 哨兵监听：drawer open 且 focus 命中 textarea 时自动 `toggleDrawer(false)`。不要引入绕过这个哨兵的 focus 调用。
- **iOS 手势上下文**：`term.focus()` 必须在用户 tap 的 touchend/click 回调里**直接同步调用**——塞进 `setTimeout` 会让 iOS Safari 判定非用户手势而拒绝唤起软键盘。
- **抽屉按键不退出**：工具盘里按键发送后 drawer 保持打开（像软键盘一样）。只有 ×、backdrop、或终端 focus 会关闭。不要在按键处理里加 `toggleDrawer(false)`。
- **不要恢复已删的 FAB popup 面板**：`.fab-panel` / `togglePanel` / `positionPanel` / `_startVoice` / `_stopVoice` 等已全部移除。“工具”按钮点击直接开 drawer，操作台在正常布局中占位，不能遮挡终端。

## 桌面端选中复制契约

`~/.tmux.conf` 是 `set -g mouse on`，所以 xterm 会把所有左键拖动转发给 tmux，并**关掉自己的本地选区**（`_selectionService.disable()`）。tmux 收到后再分流：进 copy-mode，**或**——如果 pane 里跑着抢鼠标的程序（claude/vim/htop/带 mouse 的 less）——直接把拖动透传给那个**程序**。程序的弱/无文本选择就是"选几个字符就断"的来源，**在原生终端里同样会断**（"tmux 内部异常时浏览器也异常"），因为这是 tmux 的路由，不是网页面板的问题。

两条选择路径，改动时不要混淆：

- **裸拖（plain drag）= tmux copy-mode / 或被 pane 内程序吃掉**：copy-mode 高亮是 tmux 服务端画的反显，松手 `MouseDragEnd1Pane send -X copy-selection-and-cancel` → OSC 52 → `lib/terminal.js` 的 `extractOsc52` 拦截 → 浏览器剪贴板。不要再并行调用 `pbcopy`，否则异步 pasteboard 写入可能在浏览器成功后把剪贴板覆盖为空。copy-mode 是**按 pane 隔离**的（拖到 pane 边界就停，是正确行为）。pane 跑抢鼠标程序时裸拖根本进不了 copy-mode。
- **修饰键拖动 = xterm 本地选区（绕开 tmux 和程序）**：靠 `macOptionClickForcesSelection`（`createTerminalInstance`）打开。**Mac 用 Option/Alt+拖动，Linux/Win 用 Shift+拖动**。这是原生终端里"按 Shift 绕过程序鼠标"的网页等价物，不受重绘/边缘/copy-mode 状态影响，但只覆盖可见视口（不含 tmux 滚动历史）。

不变量：

- **`macOptionClickForcesSelection` 只在 zoom/tab 模式开（`!nozoom`）**：tab 模式 xterm 只渲染单个 zoom 后的 pane，本地线性选区干净。**split（nozoom）模式必须关掉它**——此时网格里是整个窗口的所有 pane + 边框，xterm 的**线性选区不认 pane**，Option+拖动会越过 `│` 边框选到隔壁 pane（垃圾）。split 模式只能用 tmux 自己的按-pane copy-mode（裸拖 / 键盘 `prefix + [`）。
- **Mac 删不得**：Mac 上 xterm 的 `shouldForceSelection` 是 `altKey && macOptionClickForcesSelection`，没这选项 Mac 就再没有任何键能本地选区（**Shift 在 Mac 被忽略，还会把 SGR 按钮码 32→36 连 tmux 也不认**）。Linux/Win 用 Shift，该选项 no-op。`shouldColumnSelect` 在该选项开时会被 xterm 自动禁用，所以 Option+拖动是普通线性选区、不是矩形选区。
- **本地选区靠 `mouseup` 复制**：xterm 选区在 canvas 上、非 DOM 文本，Cmd/Ctrl+C 抓不到，所以 `connectTerminalWs` 里给 `term.element` 挂了 `mouseup` → `term.getSelection()` → `_copyToClipboard`。裸拖 / split 模式时 xterm 选区为空，所以**不会与 OSC 52 双重复制**，split 模式下自动失效。
- **mouseup 复制限桌面**（`window.innerWidth >= 768`）：移动端有自己的长按选择 + Copy 按钮 UI，不走这条。
- 别给 Mac 用户建议"按 Shift 选择"——那是 Linux/Win 的行为，Mac 上无效。任何平台/任何模式下最可靠的是键盘 copy-mode：`prefix + [` → `v` 选 → `y` 复制（按 pane，且走 OSC 52）。

## 终端链接契约

终端里的路径和网址有两个来源：程序自己标出的超链接（OSC 8），和页面从文字里识别的。文字识别在 `plugins/terminal/client/js/link-detect.js`（纯函数），跨行合并和 `registerLinkProvider` 在 `plugins/files/client/js/file-preview.js`，OSC 8 的服务端部分在 `lib/terminal/hyperlinks.js`；来由和证据见 `docs/known-issues.md` ENV-14。

- **OSC 8 优先，目标不靠猜。** 程序给出的地址写在链接的每个字符格上，怎么换行都不会断；xterm 先问它，再问页面的识别。`registerLinkProvider` 设置的 `linkHandler` 只开三种：http(s) 在点击里同步打开新标签，`file:` 和不带协议的路径进文件预览，其它协议只提示、不打开。屏幕上的文字是程序选的，悬停时要显示真实目标。
- **OSC 8 链接跨行时，其余行的下划线由页面画。** xterm 按行报告 OSC 8 链接，tmux 又给每行分配不同的 id，所以悬停时 xterm 只给指针所在的行画下划线。`_hyperlinkRows` 把“相同地址、上一行以它结尾、下一行以它开头”的行认作同一条链接，`_underlineRows` 在 `.xterm-screen` 上画其余行（面板的 xterm 总在备用屏里，xterm 的 decoration 在那里不显示，不能用）。它读的是 xterm 内部的提供者列表（`_core._linkProviderService`）：换 xterm 版本后找不到就只画一行，不得报错，也不要改成把多行范围交还给 xterm——那样下划线和可点击区域会连同缩进、行尾空白和隔壁窗格一起算进去。
- **`-T hyperlinks` 只加在面板自己的 tmux 客户端上。** tmux 不认识 xterm.js，不声明这个特性就把 OSC 8 全部丢掉。不要改成 server 的 `terminal-features`：那会连带改变别的终端。旧路径只在确认 tmux ≥ 3.4 后才带（更老的 tmux 不认 `-T`，带上就接不进去）；Windows 上替换客户端时同样要带，否则第一次改尺寸后链接就没了。基础模式用的是远端系统里的 tmux，不带。
- **`FORCE_HYPERLINK` 只在没设过时才设。** 用 `HYPERLINK_ENV_COMMAND` 那一条 `if-shell`，不要拆成“先读再写”，也不要无条件 `set-environment`：用户在 `~/.tmux.conf` 里设成 `0` 就是关闭它的办法。它只影响之后新开的窗格。
- **TUI 自己换的行按接缝判断。** 软换行和原有的严格规则（行满且接缝是 `/ - _ %`、或对齐的悬挂缩进）直接合并，不需要确认。`_looseSeam` 再看其余的硬换行：续行去掉缩进和边框后，必须有一个链接跨过接缝。强接缝有两种。**行满**：上一行到达了右边界（终端最后一列、贴着边框，或这段文字里最靠右且离终端右缘不超过 8 列），并且续行的头比路径前面的文字宽（Claude Code 这类排版器只断开一行放不下的词）。**放不下**：上一行停在断点上（`/` 后接字母、字母数字之间的 `-`），续行的第一段（到它自己的第一个断点为止）接在上一行后面会超出右边界（终端最后一列或边框内缘），而且续行的头不是一个普通单词；Codex 这类按 Unicode 断行规则换行的排版器就是这样断路径的，行并不顶到右边界。其余是**弱**接缝。
- **路径由文件系统裁决，网址只能看结构。** 路径在任何宽松接缝上都先问那台机器：合并后的路径存在就合并；不存在、而上下两行各自的那一段有一个存在，就不合并（误合并会弄坏一个本来能点的链接）；都不存在或问不到时，强接缝按结构合并，弱接缝不合并。网址没有任何东西可以校验，只在“行满”的强接缝上合并（以 `/` 结尾的网址本身常常就是完整的，“放不下”不算）；右边界是估计出来的（不是终端最后一列，也不贴边框）时，还要求续行的头像网址的后半段（含 `/ . - _ = ? & #` 或数字），`for`、`and` 这样的词不算。放宽这些条件之前先想清楚误合并。
- **校验只回答存在与否。** `/api/files/exists` 和其它文件接口用同一套根目录与敏感路径规则，范围之外的一律算不存在；不要让它返回更多信息。相对路径按链接所在窗格的目录解析，见下一条。答案只短暂缓存，不存在的更短：agent 刚提到的文件可能马上就被创建。老版本 Node 没有这个接口时算“问不到”。
- **相对路径按链接所在的窗格解析。** 终端显示整个 tmux 窗口时（旧终端的分屏模式、原生工作台），调用方给 `registerLinkProvider` 的 `options.panes` 返回该窗口的窗格布局（工作区 API 的 `geometry`）；校验存在、点击打开（包括程序标出的 OSC 8 文件链接）都用链接第一个格子所在的窗格，每个窗格分别校验。状态栏在上方时的行偏移从屏幕上读：哪个偏移能让最多的窗格边框落在横线上。布局和屏幕对不上（窗口被放大、看的是别的窗口、边框不是竖线），或格子落在边框上，就退回原来的做法：调用方给的窗格或 `resolvePaneId`。布局缓存 `LAYOUT_FRESH_MS`，终端尺寸变了就重新取。Tab 模式和手机只显示一个窗格，不传布局。
- **异步的回答只给 xterm 还在等的那次请求。** xterm 在指针移动和每次重绘时都会重新要这一行的链接；被新请求取代的旧请求不得再调用回调，否则旧行的链接会落到新行上。回答到达后重新读缓冲区再算，不沿用请求时的结果。
- **手机上点按不能等。** `hitTest` 是同步的（终端必须在手势里同步取得焦点），所以需要问文件系统的路径以 `unverified` 交给 `activateHit`，由它校验后再决定打开合并后的路径还是严格规则找到的那一段。手机上的点按只走文字识别，不读 OSC 8。
- **制表符边框（U+2500–259F）是路径和网址的终止符**：tmux 的窗格边框和 TUI 的方框都用它。
- **一行按竖线分段读。** 分屏时 tmux 把整个窗口画在一屏里，一行里是并排的几个窗格，TUI 的方框也一样。一行在竖线处（包括边框交汇处的 `├ ┤ ┬ ┴ ┼` 及粗线、双线变体）切成段，每段单独识别；跨行只接到下一行左右边界完全相同的那一段。横线开头的行（规则线、带标题的窗格边框）不接在上一行后面，两头都是横线的行也不往下接。没有竖线的行就是一段，和原来一样读。窗格边框用 ASCII `|`（`pane-border-lines simple`）或空格时认不出窗格。
- **分屏里 tmux 的折行没有软换行标记。** 只有占满整个终端宽度的窗格，tmux 才让终端自己折行；其余窗格在窗格右边缘断开，终端看到的是硬换行。所以“上一行写满到窗格边缘、下一行从窗格第一列开始”算强接缝，不管上一行从哪一列开始：路径照样先问文件系统（某一行自己是个文件就不合并），网址直接合并；下一行以汉字开头时不算。
- **跨行的链接在分段里按行交给 xterm。** xterm 把一个链接的范围当作从起点到终点之间的所有格子，跨行时会把隔壁窗格（或方框的边）算进下划线和可点区域，指针在隔壁窗格上也会打开这个链接。所以只要链接经过的某一行不是整行，就拆成每行一个链接，目标相同，悬停时其余行的下划线由 `_underlineRows` 画。
- 位置换算走 `_advanceCol`：宽字符是两格一个字符，BMP 之外的字符是一格两个字符，两种都不能按“一格一个字符”数。

## 文件预览分窗契约

`plugins/files/client/js/file-preview.js` 的文件预览分成两个层次：新文件始终先进入 modal；用户点击“在右侧分栏打开”后，才把当前 `.fp-modal` 移入右侧 `.fp-dock` 并新增/激活 Tab。唯一的例外是 `anymux open --dock` 和 agent 文档：它们经 `FilePreview.openDocked` 在屏幕外渲染后直接成为 Tab，规则见「Agent 文档分窗契约」。

- 分窗 Tab 按绝对路径去重；同一路径再次加入时激活已有 Tab，不复制。
- Tab 可以拖拽排序，也可以用 Alt+Shift+←/→ 移动。文件和 block 混排的顺序存在分窗状态的 `order` 里（文件按路径，block 按 `persistKey`），block 之间的顺序同时经 `blockDock.onReorder` 写回 BlockHost，没有文件 Tab 时也能还原。拖拽数据用面板自己的类型，不用 `text/plain`，免得拖到终端上被当成输入。
- 每个 Tab 都有图标：block 用自己的图标，文件按类型（`_tabKind`，服务端给出的类型优先，其次看扩展名），图标来自 `Blocks.icon`，颜色按 `data-kind` 取主题强调色。
- 每个 Tab 保存自己的 modal DOM、文件信息、pane ID、目录上下文、滚动和渲染状态；切换 Tab 不重新请求或重新渲染。
- “隐藏右侧预览”只收起分窗，不销毁 Tab；右侧恢复按钮负责重新展开。关闭最后一个 Tab 才销毁分窗。
- 分窗最小宽度为 320px，最大为扣除侧栏后可用工作区的 70%，不再设 820px 固定上限；左侧 12px resize 热区负责拖拽，保存值恢复、键盘调宽及窗口缩放时必须统一 clamp，至少为终端保留 30% 的共享空间。
- 分窗存在时点击其中的目录项/文件链接，仍必须先弹出 modal，不能直接覆盖当前 Tab。
- 导航离开 terminal 时 `FilePreview.closeDocked()` 会销毁整组分窗 Tab；普通 modal 的关闭语义保持独立。

Git、浏览器等工具 block 与文件共用这个分窗（同一个标签条、宽度和隐藏按钮），不要再做第二个右侧栏：

- 分窗归 `file-preview.js` 所有；`plugins/ui/client/js/block-host.js`（`ui` 插件；没有文件预览时 block 只能浮动）只通过 `FilePreview.blockDock.sync()` 声明哪些 frame 属于标签条，block 的生命周期仍归它管。
- 切换文件 Tab 时文件 modal 离开 DOM，block 的 frame 只隐藏不移除，这样浏览器页面和未写完的提交说明都不会丢。
- 文件 Tab 和 Git block 按窗口保存，浏览器 block 按服务器保存：切换窗口时文件和 Git 标签跟着换，浏览器标签保留。block 的归属由注册时的 `perWindow` 决定，`_persistDockState` 不写入 block，只记录它是否在最前（`activeBlock`）。
- 切走窗口时 Git block 的 frame 只脱离 DOM、不销毁，这样没写完的提交说明不会丢；窗口的 block 要等访问到它才创建。在没有窗口的页面打开的 Git 先浮动，到第一个窗口时归属于它。
- 文件 Tab 和窗口级 block 的持久化键包含服务器 ID、tmux 服务实例（PID + 启动时间）和窗口 ID；不恢复缺少实例信息的旧缓存。删除窗口成功时立即清理；成功且完整的工作区快照还会回收已消失窗口和旧实例的记录，失败或不完整的读取不得触发回收。
- 默认 Git 入口（顶栏 chip、快捷键、命令面板）跟随实际聚焦的窗格，每次都现查：原生分屏看 tmux active pane，Tab 和移动端看 `state.currentPane`，不看路由和 attach 用的窗格（`Blocks.ui.selectedContext` / `focusedContext`）。tmux 答不出就报错，不得回退到 attach 窗格；终端还没跟上路由时没有答案，不得拿旧窗格去问新服务器。查询期间换了服务器、窗口、窗格或模式，结果不得落地。先查到仓库根再按根打开或激活标签：已绑定仓库的标签不会改投别的仓库，草稿和写操作都留在原仓库；不在仓库里就开一个说明情况的标签，不沿用旧仓库。文件预览里的 Git 是显式路径，不跟随焦点。
- Git block 预览文件用的就是文件预览的渲染器，经 `FilePreview.renderInto` 只读渲染，不另写一套：不出 TODO 看板，任务勾选框禁用，不加 git gutter。磁盘上的版本照常走 `/api/files`，暂存区和提交里的版本走 `/api/git/file` 与 `/api/git/raw`（`rev` 只接受 `INDEX`、`HEAD` 或提交号，可带 `^`）。SQLite 和压缩包只能按磁盘上的文件预览，其它版本只给下载。
- `anymux git show <提交号> [--repo <路径>]` 经 Git 插件的 `/api/git/open` 解析固定完整提交号，沿 `open-git` 事件在来源窗格所属窗口打开历史详情，历史查询可按该提交为起点。自动打开复用同仓库标签和草稿，不关 modal、不抢焦点、不展开收起的分窗；后台按窗口保存，新内容标记和通知可回看。
- 大提交不能一次取完、一次画完：`/api/git/show` 并行取文件列表和整份 diff，整份超过 `SHOW_INLINE_BYTES` 就中止（`runGit` 的 `outputLimit`），返回 `diffOmitted`。页面按文件经 `/api/git/show-file` 在区块接近可视区时加载，同时最多 3 个，改动特别多的文件和二进制文件不自动加载。`renderDiffInto` 一次最多画 `maxLines` 行，其余点“显示剩余”接着画。不要改回整份 diff 一次渲染，那样两万行的提交会卡住页面好几秒。
- 预览预算必须覆盖所有文本入口：大 Markdown、Notebook 和 CSV 在解析前转为分段纯文本；大补丁使用内置限流 diff，不能交给 Diff2Html 整份匹配。CSV/XLSX 还限制总单元格与字符量，XLSX 只在激活工作表时绘制，合并区域不得展开到预览范围之外。Git 文件列表及懒加载区块都分批创建；切走时取消后续队列和过时渲染，窗口暂时脱离 DOM 的合法结果则保留。
- Git 刷新失败时，已经显示的改动、diff、历史和打开着的提交都不清掉，工具栏出现“刷新失败”（悬停看原因，点击重试），下一次成功后自动消失。只有第一次加载失败才显示错误。顶栏 chip 只在确认不是仓库、或 tmux 说不清焦点在哪个窗格时隐藏，其它失败保留并变暗。
- 重复查询要合并：`Blocks.ui.client` 合并进行中的相同 GET（结果是共享的，调用方不得修改），同一服务器上有写操作完成后，新的读不再搭旧的读。Git block 的 `load` / `loadHistory` 各自单航，同样以写操作为界；`showDiff` 只让最后选中的文件落地。历史重绘时，仍在列表里的那个打开着的提交，连同它的详情和列表滚动位置一起保留。
- 关闭最后一个文件 Tab 时，只要还有 block 标签，分窗就保留；所有标签都没了才销毁。
- 分窗只存在于终端旁：离开终端页时 block 暂存（frame 脱离 DOM），回来再挂上；在其它页面打开 block 时用浮动窗口。

## Agent 文档分窗契约

完整说明见 [docs/agent-docs.md](docs/agent-docs.md)。Agent 写的长文档在终端旁的分窗里打开，用户边看边对话；适用于 Claude、Codex、Qoder、DeepSeek Harness 等任何会写文件的 agent。

- **CLI 校验来源。** `open --dock` 和 `git show` 先核对 `TMUX_PANE` 是否存在；失效或缺失时，仅当执行目录精确对应唯一窗口才回退到该窗口，来源窗格保持未知。无法确定就报错，用 `--pane %N` 显式指定；不根据文档或仓库路径猜来源。事件携带窗口 ID 和 tmux 实例，页面拒收旧实例。CLI 输出 `requested` 只表示服务接受请求，实际查看状态由页面确认。

- 打开提醒放在左侧对应窗口（折叠时对应会话）内，点击“查看”才切到目标窗口打开，不用右下角 toast。左侧强调最多 2.4 秒，访问目标窗口就停止；只有实际显示对应内容才确认已读，恢复过程中的临时文件、收起状态或被 Git 遮住的文件不能提前确认。

- **打开不打断。** `FilePreview.openDocked` 不弹 modal、不抢键盘焦点（用户可能正在给 agent 打字）。文档按服务器、tmux 实例和所属窗口保存；不在该窗口时后台加入它的分窗，返回窗口后直接恢复并展示（watcher 的事件优先当前窗口中同项目的窗格，否则定位事件所属窗口）。浏览器后台也接收 dock 文档；手机或有 modal 打开时先保存，具备显示条件后恢复。自动打开或后台加入都发提示，并记入本浏览器可回看的通知列表；新 Tab 显示“新”标记和短暂强调，未查看标记跨窗口和刷新保留。分窗收起时只加标签和角标、不展开：展开会改终端尺寸，Windows 上等于换一个 tmux 客户端。没有分窗时，后台文档（进度）不为它新建分窗。
- **发现不靠 agent 配合。** `lib/agent-docs/watcher.js` 看窗格所在项目里 `profiles.js` 列出的目录，只宣告第一次看过之后新出现的文件；改动不再宣告（已开的标签自己刷新，用户关掉的不会弹回来）。只看预览根之内的项目。
- **skill 自己的文档目录不动。** superpowers 的 `docs/superpowers/…`、`.superpowers/sdd/…/progress.md` 原样打开，不移动、不加面板元数据；只有 `.anymux/docs/` 草稿读 front matter 里的 `anymux:` 建议。
- **草稿不进 git，也不碰项目文件。** `anymux doc path` 只往仓库自己的 `info/exclude` 加 `/.anymux/`（linked worktree 用共享的那份），不改 `.gitignore`；项目在预览根外时放到应用数据目录；不在预览根之外写任何东西。
- **往窗格填字从不回车。** `/api/agent-docs/reply` 只填一行（`send-keys -l`，拒绝控制字符和以 `-` 开头的文本；窗格在复制模式时拒绝，否则按键会变成复制模式的命令），只接受页面的同源请求。agent 可能正显示权限菜单，回车可能答错，由用户在终端里发送。
- **全局指令只改带标记的一段。** 管理中心写入各 agent 的 `CLAUDE.md` / `AGENTS.md` 时只增删 `<!-- >>> anymux agent-docs >>> -->` 标记之间的内容，改前备份；标记损坏就报错、不覆盖。规则里的命令是 `node "<仓库>/bin/anymux.mjs"`，因为安装脚本不把 `anymux` 放进 PATH。
