(function (global) {
  var Shell = null;

  function shell() {
    Shell = Shell || global.AppShell;
    return Shell;
  }

  function esc(value) { return shell().escape(value); }

  function actionButton(label, action, primary, iconName) {
    return '<button class="ms-btn ' + (primary ? 'primary' : '') + '" data-action="' + action + '">'
      + (iconName ? shell().icon(iconName) : '') + esc(label) + '</button>';
  }

  function routeButton(label, route, primary, iconName) {
    return '<button class="ms-btn ' + (primary ? 'primary' : '') + '" data-route="'
      + esc(global.Router.serialize(route)) + '">'
      + (iconName ? shell().icon(iconName) : '') + esc(label) + '</button>';
  }

  function detail(label, value) {
    return '<div class="detail-row"><span>' + esc(label) + '</span><strong class="mono">' + esc(value) + '</strong></div>';
  }

  function componentReason(reason) {
    return ({ package_manager_busy: '软件包管理器正在使用，请稍后重试。',
      package_manager_locked: '软件包管理器正在使用，请等待当前安装结束后重试。',
      package_manager_missing: '未找到支持的软件包管理器，请先按系统要求完成安装。',
      shared_package_change: '安装需要变更已有共享组件。', shared_runtime_upgrade_required: '安装需要升级正在使用的共享运行组件。',
      system_upgrade_pending: '系统软件包尚有待完成的升级，请先安排系统维护。',
      unknown_package_plan: '无法确认安装计划是否会影响已有组件。', unsafe_package_plan: '安装计划可能影响已有组件，自动安装已停止。',
      package_plan_unrecognized: '无法识别当前软件包管理器的安装计划。',
      service_transaction: '安装计划涉及服务变更，请安排维护。',
      package_cache_unavailable: '本机软件包缓存不可用，请维护软件源后重试。',
      package_network_unavailable: '暂时无法连接软件源，请检查网络后重试。',
      signature_policy_unsafe: '软件包签名校验配置不符合要求，请维护包管理器后重试。',
      homebrew_missing: '这台 Mac 尚未安装 Homebrew，请先完成 Homebrew 安装。',
      brew_requires_user: '请使用安装 Homebrew 的普通用户账户准备组件。',
      permission_required: '需要安装权限，请按系统提示处理后重试。',
      windows_admin_required: '需要 Windows 管理员权限，请在目标机器处理权限后重新检查。',
      sudo_required: '需要 sudo 密码来安装软件包。', sudo_auth_failed: 'sudo 验证未通过，请重新输入密码。',
      sudo_unavailable: '当前环境没有 sudo，请使用有安装权限的账户处理。',
      sudo_noninteractive_unavailable: '密码已验证，但系统不允许后续非交互 sudo。请在目标机器维护权限后重试，无需重复输入密码。',
      package_plan_failed: '无法读取安装计划，请检查软件源和网络后重试。',
      package_install_failed: '软件包安装未完成，请检查网络、权限和磁盘空间后重试。',
      package_verification_failed: '软件包校验失败，请检查软件源和系统时间后重试。',
      signature_policy_unavailable: '无法确认软件包签名校验配置，请维护包管理器后重试。',
      component_verification_failed: '安装后仍无法运行 Mosh 组件，请查看安装日志。',
      component_integrity_failed: 'Mosh 组件完整性检查未通过，请维护安装后重试。',
      mosh_client_unusable: 'Hub 的 Mosh 客户端无法运行，需要修复。',
      component_unusable: '已有 Mosh 组件无法运行，需要修复。',
      configured_component_unusable: '已配置的 Mosh 组件无法运行，需要维护。',
      maintenance_required: '需要升级已有运行组件，请在维护时处理，再回来重新检查。',
      mosh_server_not_found: '尚未安装 Mosh 服务端。', mosh_server_unusable: 'Mosh 服务端无法运行，需要修复。',
      mosh_client_not_found: '尚未安装 Hub 使用的 Mosh 客户端。', client_platform: '当前 Windows Hub 不支持 Mosh 客户端。',
      unsupported: '当前环境暂不支持自动安装，请查看安装日志。' })[reason] || (reason ? '组件暂未就绪，请查看安装日志。' : '');
  }

  function installFeedback(job, component, windows) {
    if (!job) return '';
    var state = job.state;
    var code = job.reason || (job.component || {}).reason;
    var reason = componentReason(code) || job.error && job.error.message;
    if (state === 'running') return '<div class="install-progress" role="status" aria-live="polite"><strong>正在安装：</strong>' + esc(job.step || '准备中') + '</div>';
    if (state === 'failed') return '<div class="install-progress error" role="alert"><strong>安装失败</strong>' + (reason ? '：' + esc(reason) : '，请查看日志后重试。') + '</div>';
    if (state === 'needs_password') return windows
      ? '<div class="install-progress" role="status"><strong>需要 Windows 管理员权限</strong>，请在目标机器处理权限后重新检查。</div>'
      : '<div class="install-progress" role="status"><strong>需要 sudo 密码</strong>来安装缺少的软件包，密码不会保存。</div>';
    if (state === 'maintenance_required') return '<div class="install-progress error" role="status"><strong>需要维护</strong>：'
      + (code === 'windows_admin_required' ? esc(componentReason(code)) : esc(componentReason(code) || '当前环境暂不能安全自动安装。') + '请安排维护后重新检查。') + '现有 SSH 连接可继续使用。</div>';
    if (state === 'unsupported') return '<div class="install-progress error" role="status"><strong>暂不支持自动安装</strong>' + (reason ? '：' + esc(reason) : '，请查看日志中的处理说明。') + '</div>';
    if (state === 'succeeded') {
      if (component) return '<div class="install-progress ok" role="status">' + (job.result === 'skipped' ? '已跳过 Mosh 组件准备，继续使用 SSH。' : 'Mosh 组件已就绪，正在更新检测结果。') + '</div>';
      var optional = job.component;
      if (optional && optional.result && optional.result !== 'ready' && optional.result !== 'skipped') {
        return '<div class="install-progress" role="status"><strong>面板服务已安装，Mosh 尚未准备完成。</strong>'
          + esc(componentReason(optional.reason) || '可在连接页面补装，SSH 仍可正常使用。') + '</div>';
      }
      return '<div class="install-progress ok" role="status"><strong>安装完成</strong>，正在重新连接…</div>';
    }
    return '';
  }

  /** New-connection routing, not a claim that existing sockets have switched. */
  function pathsText(paths) {
    var name = function (via) { return via === 'direct' ? '直连' : via === 'mosh' ? 'Mosh' : 'SSH 隧道'; };
    var reason = function (value) {
      return ({ node_not_installed: '未安装面板服务，使用基础 SSH', client_platform: 'Hub 所在平台暂不支持 Mosh 客户端',
        mosh_client_not_found: 'Hub 未安装 mosh-client', mosh_server_not_found: '目标机器未安装 mosh-server',
        mosh_server_unusable: '目标机器的 mosh-server 无法运行', unsupported: '目标机器不支持 Mosh',
        proxied: '经跳板机连接，使用 SSH', no_contact: '未能建立 Mosh 连接',
        client_exit: 'Mosh 客户端已退出', setup_timeout: 'Mosh 初始化超时',
        cleanup_unconfirmed: '旧连接清理未确认，暂不建立新终端',
        dns_failed: 'Hub 无法解析目标地址', dns_timeout: 'Hub 解析目标地址超时' })[value] || value || '未知';
    };
    var mosh = paths.mosh;
    var blocked = mosh && (mosh.reason === 'cleanup_unconfirmed' || mosh.fallbackReason === 'cleanup_unconfirmed');
    var text = '终端 ' + (blocked ? '暂不可用' : name(paths.terminal)) + ' · 文件/Git/监控 ' + name(paths.api);
    var direct = paths.direct;
    if (direct && direct.status === 'checking') text += '（直连检测中）';
    else if (direct && direct.status === 'down') text += '（直连不可用：' + reason(direct.reason) + '）';
    if (mosh && mosh.fallbackReason) text += '（已有 Mosh 连接保持，新连接：' + reason(mosh.fallbackReason) + '）';
    else if (paths.mosh && paths.mosh.status === 'down') text += '（Mosh 不可用：' + reason(paths.mosh.reason) + '）';
    else if (paths.mosh && paths.mosh.status === 'checking') text += '（Mosh 验证中）';
    else if (paths.mosh && paths.mosh.status === 'unknown') text += '（首选 Mosh，待首次连接验证）';
    return text;
  }

  /** Reachable over SSH, panel not installed there. */
  function isBasic(health) {
    return Boolean(health && health.node && health.node.installed === false);
  }

  function timeline(label, value, ok) {
    return '<div class="timeline-row"><span class="' + (ok ? 'check' : 'skip') + '">' + (ok ? '✓' : '△') + '</span>'
      + '<strong>' + esc(label) + '</strong><small>' + esc(value) + '</small></div>';
  }

  function capabilityStatus(capability, health, isTmux) {
    if (health.state === 'disabled') return { text: '已停用', ok: false };
    if (health.state === 'checking') return { text: '检测中', ok: false };
    if (!health.checkedAt || health.state === 'unknown') return { text: '未检测', ok: false };
    if (health.state !== 'online' && health.state !== 'degraded') return { text: '未取得结果', ok: false };
    if (capability && capability.available === true) {
      return { text: '可用' + (isTmux && capability.version ? ' · ' + capability.version : ''), ok: true };
    }
    if (!capability || capability.available !== false) return { text: '未取得结果', ok: false };
    var reason = capability && capability.reason;
    var reasons = { command_not_found: '未安装', unsupported_platform: '该平台不支持',
      version_unparseable: '版本无法识别', command_failed: '检测失败' };
    if (reason) return { text: reasons[reason] || '不可用', ok: false };
    return { text: '不可用', ok: false };
  }

  function relativeTime(iso) {
    if (!iso) return '从未';
    var then = Date.parse(iso);
    if (!Number.isFinite(then)) return '—';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 10) return '刚刚';
    if (seconds < 60) return seconds + ' 秒前';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
    return Math.floor(seconds / 86400) + ' 天前';
  }

  var ServersPage = {
    settingsSection: 'appearance',

    /** Server workspace: identity strip plus capability-driven tabs. */
    renderServer: function (route) {
      var serverId = route.params.serverId;
      var server = shell().server(serverId);
      if (!server) {
        return '<div class="ms-card empty"><h3>服务器不存在</h3>'
          + '<p>它可能已被删除。</p>' + routeButton('返回状态列表', { name: 'servers', params: {} }, true) + '</div>';
      }

      var health = shell().health(serverId);
      var workspace = shell().workspace(serverId);
      var openWorkspace = workspace && workspace.provider !== 'unavailable'
        ? routeButton('打开工作区', { name: 'terminal', params: { serverId: serverId } }, true, 'terminal')
        : '';

      var entry = global.PanelSlots.serverSections.get(route.params.section)
        || global.PanelSlots.serverSections.get(shell().defaultStatusSection(serverId));
      var section = entry ? entry.id : 'connection';
      shell().setHeader('服务器 / ' + server.name, entry ? entry.label : '连接', '');

      var base = this._hero(server, health, openWorkspace, route) + this._tabs(server, section);
      if (section === 'connection') return base + this._connection(server, health, workspace);
      // Basic mode: terminals work, the machine-level pages need the panel there.
      if (isBasic(health)) return base + this._installCard(server, health);
      // Every server runs the full panel, so its pages are the ones this page has.
      return base + entry.render(route);
    },

    _hero: function (server, health, openWorkspace, route) {
      var stateTone = shell().tone(health.state);
      var facts = health.facts || {};
      var mobile = global.MobileUI && global.MobileUI.isMobile();
      var operations = (shell().isStandaloneStatus(route) ? '' : actionButton('独立展示', 'detach-status', false, ''))
        + actionButton('立即检测', 'probe', false, 'refresh')
        + (server.immutable ? '' : actionButton('编辑', 'edit-server', false, ''));
      return '<div class="ms-card server-hero"><div class="server-icon">' + shell().icon('server') + '</div>'
        + '<div class="server-hero-copy"><h2>' + esc(server.name) + ' '
        + '<span class="ms-badge ' + stateTone.tone + '"><span class="dot ' + stateTone.dot + '"></span>'
        + esc(stateTone.label) + '</span></h2>'
        + '<p>' + esc(shell()._addressOf(server)) + ' · '
        + esc([facts.platform, facts.arch].filter(Boolean).join(' ') || '—') + ' · '
        + esc(shell()._latencyOf(health)) + ' · 更新于 ' + esc(relativeTime(health.checkedAt)) + '</p></div>'
        + '<div class="hero-actions">' + openWorkspace
        + '<details class="mobile-server-operations"' + (mobile ? '' : ' open') + '><summary>服务器操作</summary><div>' + operations + '</div></details>'
        + '</div></div>';
    },

    _tabs: function (server, section) {
      var entries = shell().statusSections().map(function (entry) { return [entry.id, entry.label]; });
      return '<div class="tabs">' + entries.map(function (entry) {
        var route = { name: 'server', params: { serverId: server.id, section: entry[0] } };
        return '<button class="tab ' + (section === entry[0] ? 'active' : '') + '"'
          + ' data-route="' + esc(global.Router.serialize(route)) + '">' + esc(entry[1]) + '</button>';
      }).join('') + '</div>';
    },

    /**
     * Offer to install the panel on a basic-mode server, or show the running
     * installation. The job itself lives in MsApp; this only renders it.
     */
    _installCard: function (server, health) {
      var job = (global.MsApp && global.MsApp.installJob && global.MsApp.installJob(server.id)) || null;
      var busy = job && job.state === 'running';
      if (job && job.operation === 'mosh') job = null;
      var node = health.node || {};
      var windows = /^(windows|win32)$/.test((health.facts || {}).platform || node.platform || '');
      var mode = (health.workspace && health.workspace.provider) === 'tmux'
        ? '远端 tmux 会话（重启客户端后仍在）'
        : '由客户端托管的 SSH 终端（客户端退出后结束）';
      var body = '<p>这台机器可以通过 SSH 登录，但还没有安装面板服务。现在能用的是：' + esc(mode) + '。</p>'
        + '<p>安装后可以获得全部功能：文件浏览与预览、上传、性能监控、通知、Agent 控制台，'
        + '终端与会话也改为由那台机器上的面板直接提供。</p>'
        + (node.posix === false && node.platform !== 'windows'
          ? '<p class="muted">没有检测到 POSIX shell；安装程序会按 Windows 处理。</p>' : '');
      var state = job ? job.state : 'idle';
      var status = installFeedback(job, false, windows);
      var log = job && job.log && job.log.length
        ? '<pre class="install-log mono">' + esc(job.log.slice(-14).join('\n')) + '</pre>' : '';
      var button = busy
        ? ''
        : actionButton(state === 'failed' ? '重试安装' : state === 'needs_password' ? (windows ? '管理员处理后重试' : '输入 sudo 密码并继续') : '安装面板服务',
          'install-node', true, '');
      return '<div class="section"><div class="ms-card capability install-node-card">'
        + '<div class="capability-head"><strong>基础模式</strong><span class="ms-badge yellow">未安装面板服务</span></div>'
        + body + status + (job && job.pollError ? '<p class="muted" role="status">安装进度暂时无法读取，正在重新连接；已显示的进度会保留。</p>' : '') + log
        + '<p class="muted">安装会把本客户端的面板代码经 SFTP 传到那台机器，自动安装缺少的依赖（需要时使用 sudo）、'
        + 'Node.js 和 tmux，再以只监听 127.0.0.1 的用户服务运行；只有本客户端能经 SSH 隧道访问它。</p>'
        + (busy ? '' : '<label class="monitor-page-toggle"><span><strong>同时准备 Mosh（可选）</strong>'
          + '<small>默认尝试安装；失败不会阻止面板安装。组件就绪后仍需验证 UDP 连通性。</small></span>'
          + '<input type="checkbox" data-prepare-mosh' + (job && job.skipMosh ? '' : ' checked') + '><span class="monitor-page-toggle-track" aria-hidden="true"></span></label>')
        + button + '</div></div>';
    },

    _moshCard: function (server, health) {
      var capabilities = health.capabilities || {};
      var service = capabilities.mosh;
      var client = server.kind === 'local' ? capabilities.moshClient : null;
      var clientUnsupported = client && client.reason === 'client_platform';
      var windows = /^(windows|win32)$/.test((health.facts || {}).platform || (health.node || {}).platform || '');
      var ready = service && service.available && (server.kind !== 'local' || clientUnsupported || client && client.available);
      var available = server.kind === 'local' || (health.state === 'online' || health.state === 'degraded');
      var job = global.MsApp && global.MsApp.installJob && global.MsApp.installJob(server.id);
      var componentJob = job && job.operation === 'mosh' ? job : null;
      var busy = job && job.state === 'running';
      var completed = componentJob && componentJob.state === 'succeeded' && componentJob.result === 'ready';
      var finishedAt = completed ? Date.parse(componentJob.finishedAt) : NaN;
      var checkedAt = Date.parse(health.checkedAt);
      var updating = completed && !ready && !componentJob.capabilityCheckFinished
        && (componentJob.capabilityChecking || !Number.isFinite(finishedAt) || !Number.isFinite(checkedAt) || checkedAt <= finishedAt);
      var label = function (capability) {
        if (!capability) return '未检测';
        return capability.available ? '已安装' + (capability.version ? ' · ' + capability.version : '')
          : componentReason(capability.reason) || '暂不可用';
      };
      var state = componentJob && componentJob.state;
      var action = state === 'needs_password' ? (windows ? '管理员处理后重新检查' : '输入 sudo 密码并继续')
        : state === 'maintenance_required' ? '维护后重新检查'
          : state === 'failed' || state === 'unsupported' ? '重试准备 Mosh'
            : service && service.available === false && service.reason !== 'mosh_server_not_found' ? '修复 Mosh 组件' : '准备 Mosh 组件';
      var warning = job && job.operation === 'node' && job.state === 'succeeded' && job.component
        && job.component.result !== 'ready' && job.component.result !== 'skipped' ? installFeedback(job, false, windows) : '';
      var logJob = componentJob || (warning ? job : null);
      var unreported = completed && componentJob.capabilityCheckFinished && (!service || server.kind === 'local' && !client);
      var feedback = completed && !ready && !updating
        ? '<div class="install-progress" role="status">' + (unreported
          ? '组件已准备，但服务尚未上报能力。可更新面板后重新检查。'
          : '上次组件准备已完成；当前检测尚未就绪，可重新检查或修复。') + '</div>'
        : installFeedback(componentJob, true, windows);
      return '<div class="section"><div class="ms-card capability mosh-component-card" aria-label="Mosh 组件">'
        + '<div class="capability-head"><strong>Mosh 组件</strong><span class="ms-badge ' + (ready ? 'green' : 'yellow') + '">' + (ready ? '组件就绪' : updating ? '更新检测中' : '待准备') + '</span></div>'
        + '<div class="detail-list">' + detail('服务端', label(service))
        + (server.kind === 'local' ? detail('Hub 客户端', label(client)) : '') + '</div>'
        + '<p class="muted">组件已安装不代表 UDP 已连通。通道选择在新连接时验证，失败时保留 SSH；准备组件不会切换已有终端。</p>'
        + warning + feedback
        + (busy && !componentJob ? '<p class="muted" role="status">面板服务正在安装，完成后可检查组件状态。</p>' : '')
        + (componentJob && componentJob.pollError ? '<p class="muted" role="status">安装进度暂时无法读取，正在重新连接；已显示的进度会保留。</p>' : '')
        + (logJob && logJob.log && logJob.log.length ? '<details><summary>安装日志</summary><pre class="install-log mono">' + esc(logJob.log.slice(-14).join('\n')) + '</pre></details>' : '')
        + (!ready && !updating && !busy && available ? actionButton(action, 'install-mosh', true, '') : '')
        + (!ready && !available ? '<p class="muted">连接恢复后可准备组件。</p>' : '')
        + '</div></div>';
    },

    _localConnection: function (health, server) {
      var facts = health.facts || {}, capabilities = health.capabilities || {};
      var platforms = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' };
      var tmux = capabilityStatus(capabilities.tmux, health, true);
      var metrics = capabilityStatus(capabilities.metrics, health, false);
      return '<div class="grid two-col connection-local"><section>'
        + '<div class="section-head"><h3>本机信息</h3></div><div class="ms-card detail-list">'
        + detail('连接方式', '本机进程')
        + detail('平台', platforms[facts.platform] || facts.platform || '未检测')
        + detail('架构', facts.arch || '未检测')
        + detail('主机名', facts.hostname || '未检测')
        + '</div><p class="muted">直接读取本机运行状态。</p>' + this._moshCard(server, health) + '</section><section>'
        + '<div class="section-head"><h3>最近检测结果</h3><span>' + esc(relativeTime(health.checkedAt)) + '</span></div>'
        + '<div class="ms-card timeline">'
        + timeline('tmux', tmux.text, tmux.ok)
        + timeline('指标采集能力', metrics.text, metrics.ok)
        + '</div></section></div>';
    },

    _connection: function (server, health, workspace) {
      if (server.kind === 'local') return this._localConnection(health, server);
      var address = server.address || {};
      var ssh = server.ssh || {};
      var capabilities = health.capabilities || {};
      var keyProblem = health.state === 'host_key_error';
      var verified = Boolean(health.checkedAt && (health.state === 'online' || health.state === 'degraded')
        && capabilities.ssh && capabilities.ssh.available === true);
      var connection = verified ? '已验证' : ({ offline: '连接失败', auth_required: '身份认证失败',
        host_key_error: '主机指纹需要确认', checking: '检测中', disabled: '已停用' })[health.state] || '未检测';
      var tmux = capabilityStatus(capabilities.tmux, health, true);
      var metrics = capabilityStatus(capabilities.metrics, health, false);
      var errorCode = health.error && health.error.code;
      // The node link has failure modes of its own beyond SSH reachability.
      var nodeHint = ({
        NODE_NOT_INSTALLED: '该主机上还没有运行 anymux。在那台机器上安装并启动面板服务后会自动接入（scripts/install-service.sh install 或 Windows 上的 install-service.ps1 install）。',
        NODE_NOT_RUNNING: '已通过 SSH 连上，但面板服务没有在运行。请在那台机器上启动面板服务。',
        NODE_INCOMPATIBLE: '该主机上的面板版本与本机不兼容，请把两边更新到同一版本。',
        NODE_AUTH_FAILED: '该主机上的面板拒绝了本机的访问令牌，通常是重装后令牌已更换；稍后会自动重新配对。',
      })[errorCode];
      var facts = health.facts || {};
      var basic = isBasic(health);

      return '<div class="grid two-col connection-remote"><section>'
        + '<div class="section-head"><h3>连接配置</h3></div>'
        + '<div class="ms-card detail-list">'
        + detail('Host', address.host || ssh.configHost || '—')
        + detail('SSH Port', address.port || (ssh.configHost ? '来自 ssh config' : '未配置'))
        + detail('Username', address.user || (ssh.configHost ? '来自 ssh config' : '—'))
        + detail('认证配置', ssh.authMethod === 'password' ? '用户名密码' : ssh.usesIdentityFile ? '指定私钥文件' : 'SSH Agent / ssh config')
        + (health.paths ? detail('新连接选路', pathsText(health.paths)) : '')
        + detail('最近成功', relativeTime(health.lastOnlineAt))
        + (facts.version ? detail('面板版本', facts.version) : '')
        + '</div>'
        + (basic ? this._installCard(server, health) : '')
        + (!basic ? this._moshCard(server, health) : '')
        + (nodeHint
          ? '<div class="section"><div class="ms-card capability">'
            + '<div class="capability-head"><strong>面板服务</strong><span class="ms-badge yellow">需要处理</span></div>'
            + '<p>' + esc(nodeHint) + '</p></div></div>'
          : '')
        + (keyProblem
          ? '<div class="section"><div class="ms-card capability">'
            + '<div class="capability-head"><strong>主机指纹需要确认</strong>'
            + '<span class="ms-badge red">阻断</span></div>'
            + '<p>面板不会自动信任或覆盖主机密钥。请通过可信渠道核对指纹后再确认。</p>'
            + actionButton('获取指纹', 'scan-host-key', true, '') + '</div></div>'
          : '')
        + (server.immutable ? '' : '<div class="section">'
          + actionButton('删除服务器', 'delete-server', false, '') + '</div>')
        + '</section><section>'
        + '<div class="section-head"><h3>最近一次检测</h3><span>' + esc(relativeTime(health.checkedAt)) + '</span></div>'
        + '<div class="ms-card timeline">'
        + timeline('SSH 隧道', connection, verified)
        + timeline('面板服务', basic ? '未安装（基础模式）' : verified ? '已连接' + (facts.version ? ' · ' + facts.version : '') : (nodeHint ? '未就绪' : connection), verified && !basic)
        + timeline('tmux', tmux.text, tmux.ok)
        + timeline('指标采集能力', metrics.text, metrics.ok)
        + '</div>'
        + '<p class="muted" style="margin-top:10px">连接由面板服务所在机器（Hub）建立。已有终端保持当前连接，通道设置在下次连接时应用。基础模式使用 SSH；安装面板服务后可使用直连 HTTPS 或尝试 Mosh。</p>'
        + '</section></div>';
    },

    renderSettings: function () {
      shell().setHeader('全局', '设置', '');
      var entry = shell().settingsSection(this.settingsSection);
      var section = entry ? entry.id : null;
      var navigation = '<nav class="mobile-settings-nav" aria-label="设置分类">' + shell().settingsSections().map(function (item) {
        return '<button type="button" data-settings-section="' + esc(item.id) + '"'
          + (item.id === section ? ' aria-current="page"' : '') + '>' + esc(item.label) + '</button>';
      }).join('') + '</nav>';
      return navigation + (entry ? entry.render() : '');
    },

    _settingsAppearance: function () {
      var T = global.Theme || {};
      var currentThemeId = typeof T.getCurrent === 'function' ? T.getCurrent() : '';
      var currentName = typeof T.getName === 'function' ? T.getName() : '—';
      var themeMode = typeof T.getThemeMode === 'function' ? T.getThemeMode() : 'manual';
      var lightThemeId = typeof T.getLightThemeId === 'function' ? T.getLightThemeId() : 'oyster';
      var darkThemeId = typeof T.getDarkThemeId === 'function' ? T.getDarkThemeId() : 'tokyo-night';
      var accentOverride = typeof T.getAccentOverride === 'function' ? T.getAccentOverride() : null;
      var accentSwatches = typeof T.getAccentSwatches === 'function' ? T.getAccentSwatches() : [];
      var allThemes = typeof T.getThemeList === 'function' ? T.getThemeList() : [];

      var modeSwitch = typeof T.setThemeMode === 'function'
        ? '<div class="appearance-toolbar">'
          + '<div class="appearance-segmented" role="group" aria-label="配色模式">'
          + '<button type="button" class="appearance-seg-btn' + (themeMode === 'manual' ? ' active' : '') + '" data-action="set-theme-mode" data-mode="manual">手动选择</button>'
          + '<button type="button" class="appearance-seg-btn' + (themeMode === 'system' ? ' active' : '') + '" data-action="set-theme-mode" data-mode="system">跟随系统浅/深</button>'
          + '</div>'
          + '<div class="appearance-accent-actions">'
          + '<button type="button" class="ms-btn" data-action="toggle-import-theme">导入主题 JSON</button> '
          + '<button type="button" class="ms-btn" data-action="export-theme-json">导出当前主题</button>'
          + '</div></div>'
        : '';

      var systemPair = '';
      if (themeMode === 'system' && allThemes.length) {
        var lightOpts = allThemes.filter(function (t) { return t.colorScheme === 'light'; });
        var darkOpts = allThemes.filter(function (t) { return t.colorScheme !== 'light'; });
        systemPair = '<div class="appearance-system-pair">'
          + '<label class="appearance-field"><span>浅色首选主题</span>'
          + '<select class="appearance-select" data-appearance-select="lightThemeId">'
          + (lightOpts.length ? lightOpts : allThemes).map(function (t) {
            return '<option value="' + esc(t.id) + '"' + (t.id === lightThemeId ? ' selected' : '') + '>' + esc(t.name) + '</option>';
          }).join('') + '</select></label>'
          + '<label class="appearance-field"><span>深色首选主题</span>'
          + '<select class="appearance-select" data-appearance-select="darkThemeId">'
          + (darkOpts.length ? darkOpts : allThemes).map(function (t) {
            return '<option value="' + esc(t.id) + '"' + (t.id === darkThemeId ? ' selected' : '') + '>' + esc(t.name) + '</option>';
          }).join('') + '</select></label></div>';
      }

      var accentBar = accentSwatches.length
        ? '<div class="appearance-accent-row">'
          + '<span class="appearance-accent-label">自定义强调色</span>'
          + '<div class="accent-swatch-list">'
          + accentSwatches.map(function (hexVal) {
            var active = accentOverride && accentOverride.toLowerCase() === hexVal.toLowerCase();
            return '<button type="button" class="accent-swatch' + (active ? ' active' : '') + '"'
              + ' data-action="set-accent" data-accent="' + esc(hexVal) + '"'
              + ' style="background:' + esc(hexVal) + '" aria-label="强调色 ' + esc(hexVal) + '"></button>';
          }).join('')
          + '<input id="appearance-accent-picker" class="accent-color-input" type="color" value="' + esc(accentOverride || '#7aa2f7') + '" aria-label="自定义取色">'
          + (accentOverride ? '<button type="button" class="ms-btn" data-action="reset-accent">恢复主题默认</button>' : '')
          + '</div></div>'
        : '';

      var importPanel = '<div id="theme-import-panel" class="theme-import-panel"' + (this._showImportPanel ? '' : ' hidden') + '>'
        + '<label class="appearance-field"><span>粘贴完整主题 JSON 或终端配色 JSON（自动进行 WCAG 对比度校正）</span>'
        + '<textarea id="theme-import-textarea" class="theme-import-textarea" placeholder=\'{"name":"My Theme","terminal":{"background":"#181a24","foreground":"#e6ebf5","blue":"#7aa2f7"}}\'></textarea></label>'
        + '<div><button type="button" class="ms-btn primary" data-action="submit-import-theme">验证并导入</button> '
        + '<button type="button" class="ms-btn" data-action="toggle-import-theme">取消</button></div></div>';

      return '<div class="intro"><h2>外观</h2><p>主题、壁纸、毛玻璃质感与终端排版会实时同步到工作台与终端。</p></div>'
        + '<div class="section"><div class="section-head"><h3>主题配色</h3>'
        + '<span>当前：' + esc(currentName) + (themeMode === 'system' ? '（自动跟随系统）' : '') + '</span></div>'
        + modeSwitch + systemPair + this._themeGrid() + accentBar + importPanel + '</div>'
        + this._wallpaperSettings(currentThemeId)
        + this._glassSettings()
        + this._transparencySettings()
        + this._typographySettings()
        + this._monitorPageSettings();
    },

    _wallpaperSettings: function (currentThemeId) {
      var T = global.Theme;
      if (!T || typeof T.getWallpaper !== 'function') return '';
      var wp = T.getWallpaper();
      var supportsNative = Boolean(T.supportsTransparency && T.supportsTransparency());
      var builtin = typeof T.getBuiltInWallpapers === 'function' ? T.getBuiltInWallpapers() : [];
      var custom = typeof T.getCustomWallpapers === 'function' ? T.getCustomWallpapers() : [];
      var allThemes = typeof T.getThemeList === 'function' ? T.getThemeList() : [];
      var currentTheme = allThemes.filter(function (t) { return t.id === currentThemeId; })[0];
      var recommendedId = currentTheme ? currentTheme.defaultWallpaper : '';
      var activeResolvedId = typeof T.getResolvedWallpaperId === 'function' ? T.getResolvedWallpaperId(currentThemeId) : wp.id;

      var cards = [];
      cards.push(
        '<button type="button" class="wallpaper-card' + (wp.mode === 'none' ? ' active' : '') + '" data-action="set-wallpaper" data-wp-mode="none">'
        + '<span class="wallpaper-thumb" style="background:var(--workspace-bg, var(--bg-primary))"></span>'
        + '<span class="wallpaper-meta"><strong>纯色背景</strong><small>简洁高对比无图案</small></span></button>'
      );
      cards.push(
        '<button type="button" class="wallpaper-card' + (wp.mode === 'desktop' ? ' active' : '') + '"'
        + ' data-action="set-wallpaper" data-wp-mode="desktop"' + (supportsNative ? '' : ' disabled') + '>'
        + '<span class="wallpaper-thumb wallpaper-thumb-desktop">' + (supportsNative ? 'Desktop' : 'macOS 客户端') + '</span>'
        + '<span class="wallpaper-meta"><strong>透传桌面</strong><small>' + (supportsNative ? '实时透视桌面壁纸与窗口' : '仅桌面端原生客户端支持') + '</small></span></button>'
      );

      builtin.forEach(function (item) {
        var isActive = wp.mode === 'builtin' && activeResolvedId === item.id;
        var isRec = recommendedId === item.id;
        cards.push(
          '<button type="button" class="wallpaper-card' + (isActive ? ' active' : '') + '"'
          + ' data-action="set-wallpaper" data-wp-mode="builtin" data-wp-id="' + esc(item.id) + '">'
          + '<span class="wallpaper-thumb" style="background-image:url(\'' + esc(item.url) + '\'),' + esc(item.previewBg) + '">'
          + (isRec ? '<span class="wallpaper-badge">推荐</span>' : '') + '</span>'
          + '<span class="wallpaper-meta"><strong>' + esc(item.name) + '</strong><small>' + esc(item.description) + '</small></span></button>'
        );
      });

      custom.forEach(function (item) {
        var isActive = wp.mode === 'custom' && wp.id === item.id;
        cards.push(
          '<div class="theme-card-wrap">'
          + '<button type="button" class="wallpaper-card' + (isActive ? ' active' : '') + '"'
          + ' data-action="set-wallpaper" data-wp-mode="custom" data-wp-id="' + esc(item.id) + '">'
          + '<span class="wallpaper-thumb" style="background-image:url(\'' + esc(item.url) + '\')">'
          + '<span class="wallpaper-badge">自定义</span></span>'
          + '<span class="wallpaper-meta"><strong>' + esc(item.name) + '</strong><small>已同步到 Hub</small></span></button>'
          + '<button type="button" class="wallpaper-delete-btn" data-action="delete-wallpaper" data-wp-id="' + esc(item.id) + '" aria-label="删除壁纸">×</button>'
          + '</div>'
        );
      });

      var webActive = wp.mode === 'builtin' || wp.mode === 'custom';
      var fitControls = webActive
        ? '<div class="appearance-slider-grid" style="margin-top:14px">'
          + '<div class="appearance-slider-item"><div class="appearance-slider-head"><label>填充方式</label></div>'
          + '<div class="appearance-segmented">'
          + [['cover', '铺满'], ['contain', '完整'], ['fill', '拉伸']].map(function (entry) {
            return '<button type="button" class="appearance-seg-btn' + (wp.fit === entry[0] ? ' active' : '') + '" data-action="set-wallpaper-fit" data-fit="' + entry[0] + '">' + entry[1] + '</button>';
          }).join('') + '</div></div>'
          + '<div class="appearance-slider-item"><div class="appearance-slider-head"><label for="wp-brightness">壁纸亮度</label>'
          + '<output id="wp-brightness-value">' + wp.brightness + '%</output></div>'
          + '<input id="wp-brightness" type="range" min="40" max="130" step="1" value="' + wp.brightness + '" data-appearance-slider="wallpaper.brightness"></div>'
          + '</div>'
        : '';

      return '<div class="section"><div class="section-head"><h3>背景与壁纸</h3>'
        + '<span>纯色 / 内置主题壁纸 / 自定义上传 / 透传桌面</span></div>'
        + '<div class="appearance-section-card">'
        + '<div class="wallpaper-mode-row">'
        + '<label class="wallpaper-toggle-inline"><input type="checkbox" data-action="toggle-follow-theme-wallpaper"' + (wp.followTheme ? ' checked' : '') + '>'
        + '<span>切换主题时自动匹配推荐壁纸</span></label>'
        + '<div><input id="wallpaper-upload-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden>'
        + '<button type="button" class="ms-btn" data-action="trigger-upload-wallpaper">上传自定义壁纸</button></div>'
        + '</div>'
        + '<div class="wallpaper-grid">' + cards.join('') + '</div>'
        + fitControls
        + '</div></div>';
    },

    _glassSettings: function () {
      var T = global.Theme;
      if (!T || typeof T.getGlass !== 'function') return '';
      var glass = T.getGlass();
      var wp = T.getWallpaper();
      var presets = typeof T.getGlassPresets === 'function' ? T.getGlassPresets() : [];
      var supportsLiquid = Boolean(T.supportsLiquidGlass && T.supportsLiquidGlass());
      var supportsMaterial = Boolean(T.supportsMaterialEngine && T.supportsMaterialEngine());
      var backdropActive = Boolean(T.isBackdropActive && T.isBackdropActive());

      var presetChips = presets.filter(function (p) {
        return p.id !== 'clear-glass' || supportsLiquid || wp.mode === 'builtin' || wp.mode === 'custom';
      }).map(function (p) {
        return '<button type="button" class="glass-preset-chip' + (glass.preset === p.id ? ' active' : '') + '"'
          + ' data-action="set-glass-preset" data-preset="' + esc(p.id) + '">'
          + '<strong>' + esc(p.name) + '</strong><small>' + esc(p.description) + '</small></button>';
      }).join('');

      var engineRow = '';
      if (supportsMaterial && wp.mode === 'desktop') {
        var engines = [
          ['material', 'MaterialView 精细磨砂'],
        ];
        if (supportsLiquid) {
          engines.push(['liquid-regular', 'Liquid Glass · Regular']);
          engines.push(['liquid-clear', 'Liquid Glass · Clear']);
        }
        engines.push(['system', '系统材质']);
        engineRow = '<div class="appearance-toolbar" style="margin-bottom:12px">'
          + '<span class="appearance-accent-label">macOS 原生渲染引擎</span>'
          + '<div class="appearance-segmented">'
          + engines.map(function (e) {
            return '<button type="button" class="appearance-seg-btn' + (glass.nativeEngine === e[0] ? ' active' : '') + '"'
              + ' data-action="set-native-glass-engine" data-engine="' + esc(e[0]) + '">' + esc(e[1]) + '</button>';
          }).join('') + '</div></div>';
      }

      var sliders = [
        ['blurRadius', '模糊半径', 0, 48, 1, 'px'],
        ['terminalTint', '终端遮罩浓度', 20, 95, 1, '%'],
        ['sidebarTint', '侧栏玻璃浓度', 0, 85, 1, '%'],
        ['saturation', '色彩饱和度', 60, 200, 1, '%'],
        ['noiseOpacity', '磨砂噪点质感', 0, 18, 1, '%'],
        ['inactivePaneDim', '非活跃窗格压暗', 0, 45, 1, '%'],
      ].map(function (spec) {
        var key = spec[0];
        var val = glass[key];
        return '<div class="appearance-slider-item"><div class="appearance-slider-head">'
          + '<label for="glass-' + key + '">' + esc(spec[1]) + '</label>'
          + '<output id="glass-' + key + '-value">' + val + spec[5] + '</output></div>'
          + '<input id="glass-' + key + '" type="range" min="' + spec[2] + '" max="' + spec[3] + '" step="' + spec[4] + '" value="' + val + '"'
          + ' data-appearance-slider="glass.' + key + '" data-unit="' + spec[5] + '"></div>';
      }).join('');

      return '<div class="section"><div class="section-head"><h3>毛玻璃与材质</h3>'
        + '<span>' + (backdropActive ? '实时渲染中' : '选择壁纸或开启透传桌面后可预览效果') + '</span></div>'
        + '<div class="appearance-section-card">'
        + '<div class="glass-preset-grid">' + presetChips + '</div>'
        + engineRow
        + '<div class="appearance-slider-grid">' + sliders + '</div>'
        + '</div></div>';
    },

    _typographySettings: function () {
      var T = global.Theme;
      if (!T || typeof T.getTerminalTypography !== 'function') return '';
      var typo = T.getTerminalTypography();
      return '<div class="section"><div class="section-head"><h3>终端排版与光标</h3>'
        + '<button type="button" class="ms-btn" data-action="reset-appearance">恢复默认外观</button></div>'
        + '<div class="appearance-section-card"><div class="typography-grid">'
        + '<div class="appearance-slider-item"><div class="appearance-slider-head"><label for="typo-fontSize">字体大小</label><output id="typo-fontSize-value">' + typo.fontSize + 'px</output></div>'
        + '<input id="typo-fontSize" type="range" min="10" max="22" step="1" value="' + typo.fontSize + '" data-appearance-slider="typography.fontSize" data-unit="px"></div>'
        + '<div class="appearance-slider-item"><div class="appearance-slider-head"><label for="typo-lineHeight">行高倍数</label><output id="typo-lineHeight-value">' + Number(typo.lineHeight).toFixed(2) + '</output></div>'
        + '<input id="typo-lineHeight" type="range" min="1.0" max="1.8" step="0.05" value="' + typo.lineHeight + '" data-appearance-slider="typography.lineHeight" data-unit=""></div>'
        + '<div class="appearance-slider-item"><div class="appearance-slider-head"><label for="typo-panePadding">窗格内边距</label><output id="typo-panePadding-value">' + typo.panePadding + 'px</output></div>'
        + '<input id="typo-panePadding" type="range" min="0" max="16" step="1" value="' + typo.panePadding + '" data-appearance-slider="typography.panePadding" data-unit="px"></div>'
        + '<div class="appearance-slider-item"><div class="appearance-slider-head"><label>光标样式</label></div>'
        + '<div class="appearance-segmented">'
        + [['block', '方块'], ['bar', '竖线'], ['underline', '下划线']].map(function (c) {
          return '<button type="button" class="appearance-seg-btn' + (typo.cursorStyle === c[0] ? ' active' : '') + '" data-action="set-cursor-style" data-cursor="' + c[0] + '">' + c[1] + '</button>';
        }).join('') + '</div>'
        + '<label class="wallpaper-toggle-inline" style="margin-top:8px"><input type="checkbox" data-action="toggle-cursor-blink"' + (typo.cursorBlink ? ' checked' : '') + '><span>光标闪烁</span></label>'
        + '</div></div></div></div>';
    },

    _transparencySettings: function () {
      if (!global.Theme || !global.Theme.supportsTransparency || !global.Theme.supportsTransparency()) return '';
      var amount = global.Theme.getTransparency();
      return '<div class="section native-transparency-settings"><div class="section-head">'
        + '<h3><label for="native-transparency">背景透明度</label></h3>'
        + '<output id="native-transparency-value" for="native-transparency">' + amount + '%</output></div>'
        + '<input id="native-transparency" type="range" min="0" max="50" step="1" value="' + amount + '"'
        + ' aria-describedby="native-transparency-help">'
        + '<p id="native-transparency-help" class="muted">0% 为不透明；调高可透出桌面毛玻璃效果，文字保持清晰。仅在 macOS 客户端生效。</p></div>'
        + (global.Theme.supportsGlassIntensity && global.Theme.supportsGlassIntensity()
          ? '<div class="section native-transparency-settings"><div class="section-head">'
            + '<h3><label for="native-glass-intensity">毛玻璃强度</label></h3>'
            + '<output id="native-glass-intensity-value" for="native-glass-intensity">' + global.Theme.getGlassIntensity() + '%</output></div>'
            + '<input id="native-glass-intensity" type="range" min="0" max="100" step="1" value="' + global.Theme.getGlassIntensity() + '"'
            + ' aria-describedby="native-glass-intensity-help">'
            + '<p id="native-glass-intensity-help" class="muted">0% 关闭毛玻璃，100% 为最强效果；背景透明度大于 0% 时可见。</p></div>'
          : '');
    },

    _monitorPageSettings: function () {
      var ui = global.Store.getState().ui;
      var entries = [
        ['showPerformance', '性能', '机器与窗口资源'],
        ['showClaude', 'Claude 数据源', '在 Agent 控制台显示 Claude 配额与趋势'],
        ['showCodex', 'Codex / Qoder 数据源', '在 Agent 控制台显示账号、供应商与 CLI 活动'],
      ];
      var enabledCount = entries.filter(function (entry) { return ui[entry[0]]; }).length;
      return '<div class="section"><div class="section-head"><h3>监控页面</h3>'
        + '<span>至少保留一个</span></div><div class="ms-card monitor-page-settings">'
        + entries.map(function (entry) {
          var enabled = ui[entry[0]];
          var locked = enabled && enabledCount === 1;
          return '<label class="monitor-page-toggle' + (locked ? ' locked' : '') + '">'
            + '<span><strong>' + esc(entry[1]) + '</strong><small>' + esc(entry[2]) + '</small></span>'
            + '<input type="checkbox" data-action="toggle-monitor-page" data-ui-key="' + entry[0] + '"'
            + (enabled ? ' checked' : '') + (locked ? ' disabled' : '') + '>'
            + '<span class="monitor-page-toggle-track" aria-hidden="true"></span></label>';
        }).join('') + '</div></div>';
    },

    /** Reuses Theme's own registry so the panel never keeps a second copy. */
    _themeGrid: function () {
      if (!global.Theme || typeof global.Theme.getThemeList !== 'function') {
        return '<div class="ms-card empty"><h3>主题组件未加载</h3></div>';
      }
      var current = global.Theme.getCurrent();
      return '<div class="theme-grid">' + global.Theme.getThemeList().map(function (theme) {
        var colors = theme.colors || {};
        var isActive = theme.id === current;
        var bg = colors['--workspace-bg'] || colors['--bg-primary'];
        var bgCard = colors['--workspace-sidebar'] || colors['--bg-card'];
        var text = colors['--workspace-text'] || colors['--text-primary'];
        var accent = colors['--workspace-accent'] || colors['--accent-blue'];
        var terminal = theme.terminal || {};
        var card = '<button class="theme-card' + (isActive ? ' active' : '') + '"'
          + ' data-action="set-theme" data-theme="' + esc(theme.id) + '"'
          + (isActive ? ' aria-current="true"' : '')
          + ' style="background:' + esc(bg) + ';border-color:' + esc(isActive ? accent : bgCard) + '">'
          + '<span class="theme-card-preview">'
          + '<span class="theme-card-bar" style="background:' + esc(bgCard) + '">'
          + '<span style="background:' + esc(colors['--accent-red']) + '"></span>'
          + '<span style="background:' + esc(colors['--accent-green']) + '"></span>'
          + '<span style="background:' + esc(accent) + '"></span></span>'
          + '<span class="theme-card-body" style="background:' + esc(bg) + '">'
          + '<span class="theme-card-line" style="background:' + esc(text) + ';opacity:.6;width:70%"></span>'
          + '<span class="theme-card-line" style="background:' + esc(accent) + ';opacity:.7;width:50%"></span>'
          + '<span class="theme-card-line" style="background:' + esc(colors['--accent-purple'])
          + ';opacity:.5;width:60%"></span>'
          + '<span class="theme-card-swatches" aria-hidden="true">'
          + ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map(function (color) {
            return '<i style="background:' + esc(terminal[color] || accent) + '"></i>';
          }).join('') + '</span></span></span>'
          + '<span class="theme-card-name" style="color:' + esc(text) + '">' + esc(theme.name) + '</span>'
          + (theme.description ? '<span class="theme-card-description" style="color:'
            + esc(colors['--workspace-muted'] || text) + '">' + esc(theme.description) + '</span>' : '')
          + '</button>';
        if (theme.isCustom) {
          return '<div class="theme-card-wrap">' + card
            + '<button type="button" class="theme-card-delete" data-action="delete-custom-theme" data-theme="' + esc(theme.id) + '" aria-label="删除自定义主题">×</button>'
            + '</div>';
        }
        return card;
      }).join('') + '</div>';
    },

    _settingsSecurity: function () {
      return '<div class="intro"><h2>连接与安全</h2>'
        + '<p>密码加密保存在面板所在机器，私钥只保存路径引用。</p></div>'
        + '<div class="grid two-col"><div class="ms-card detail-list">'
        + detail('认证方式', '用户名密码、SSH Agent 与 ~/.ssh/config')
        + detail('主机密钥', '需显式确认，变化后阻断连接')
        + detail('远端安装', '不安装、不升级、不启动远端 tmux')
        + '</div><div class="ms-card detail-list">'
        + detail('私钥', '仅保存路径引用')
        + detail('探针', '只读，非交互')
        + detail('SSH 选项', 'BatchMode，StrictHostKeyChecking')
        + '</div></div>';
    },

    _settingsAbout: function () {
      var signOut = global.Auth && global.Auth.getToken()
        ? '<div class="section"><div class="section-head"><h3>账户</h3>'
          + '<span>登录已启用</span></div><div class="ms-card detail-list">'
          + '<div class="workspace-missing-actions">'
          + actionButton('退出登录', 'logout', false, '') + '</div></div></div>'
        : '';
      return '<div class="intro"><h2>GitHub</h2><p>项目源码与版本信息。</p></div>'
        + '<div class="ms-card detail-list">'
        + detail('名称', 'Anymux')
        + detail('版本', 'v1.0.0')
        + detail('说明', '面向移动端友好的 tmux 会话管理界面')
        + '</div>'
        + '<div class="section"><a class="ms-btn" href="https://github.com/hungry-yue-s/anymux"'
        + ' target="_blank" rel="noopener">查看 GitHub 仓库 →</a></div>'
        + signOut;
    },
  };

  global.ServersPage = ServersPage;

  // This page's own sections (PanelSlots, slots.js); plugins add theirs.
  if (global.PanelSlots) {
    global.PanelSlots.serverSections.register({
      id: 'connection',
      label: '连接',
      order: 90,
      // Rendered by renderServer itself: it needs the server, its health and workspace.
      render: function () { return ''; },
    });
    global.PanelSlots.settingsSections.register({
      id: 'appearance', label: '外观', order: 10, render: function () { return ServersPage._settingsAppearance(); },
    });
    global.PanelSlots.settingsSections.register({
      id: 'security', label: '连接与安全', order: 30, render: function () { return ServersPage._settingsSecurity(); },
    });
    global.PanelSlots.settingsSections.register({
      id: 'about', label: 'GitHub', order: 40, render: function () { return ServersPage._settingsAbout(); },
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
