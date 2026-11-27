(function (global) {
  'use strict';

  var STATUS_URL = '/api/macos-permissions/status';
  var cachedStatus = null;
  var inflight = null;
  var focusBound = false;
  var nudgeDismissedInSession = false;

  var PERMISSION_ROWS = [
    {
      id: 'full-disk-access',
      title: '完全磁盘访问权限',
      recommended: true,
      desc: '授予 Anymux 一次权限，即可让其下运行的 Claude / Codex / agy 访问桌面、文稿、下载及其他应用数据而不再反复弹窗。',
      primaryLabel: '打开系统设置',
      showFdaBadge: true,
      showReveal: true,
    },
    {
      id: 'files-and-folders',
      title: '文件和文件夹',
      desc: '若不开启完全磁盘访问，可在此单独放行桌面、文稿与下载目录。',
      primaryLabel: '打开系统设置',
    },
    {
      id: 'local-network',
      title: '本地网络',
      desc: '允许终端与 Agent 连接本地开发服务器、调试端口及局域网设备。',
      primaryLabel: '打开系统设置',
    },
    {
      id: 'automation',
      title: '自动化（Apple Events）',
      desc: '允许开发脚本或 Agent 通过 osascript 控制其他本地应用。',
      primaryLabel: '打开系统设置',
    },
    {
      id: 'accessibility',
      title: '辅助功能',
      desc: '允许自动化工具或辅助脚本注入按键与读取窗口状态。',
      primaryLabel: '打开系统设置',
    },
    {
      id: 'screen',
      title: '屏幕录制',
      desc: '允许本地截图与视觉自动化检查工具读取屏幕内容。',
      primaryLabel: '打开系统设置',
    },
  ];

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fetchStatus(force) {
    if (!global.Api || typeof global.Api.get !== 'function') return Promise.resolve(null);
    if (!force && cachedStatus) return Promise.resolve(cachedStatus);
    if (inflight) return inflight;
    inflight = global.Api.get(STATUS_URL, { timeout: 5000 }).then(function (data) {
      cachedStatus = data || null;
      syncSettingsNavVisibility();
      syncNudgeBanner(cachedStatus);
      return cachedStatus;
    }).catch(function () {
      return null;
    }).finally(function () {
      inflight = null;
    });
    return inflight;
  }

  function syncSettingsNavVisibility() {
    if (!global.AppShell || !global.document) return;
    if (cachedStatus && cachedStatus.supported && !global.document.querySelector('[data-settings-section="macos-permissions"]')) {
      if (typeof global.AppShell.render === 'function') global.AppShell.render();
    }
  }

  function badgeForFda(status) {
    if (status === 'granted') return '<span class="ms-badge green">已授权</span>';
    if (status === 'denied') return '<span class="ms-badge amber">未授权</span>';
    if (status === 'not_running') return '<span class="ms-badge">tmux 未运行</span>';
    return '<span class="ms-badge">未知</span>';
  }

  function attributionSummary(attr) {
    if (!attr || !attr.supported) return { tone: 'ms-badge', label: '不适用', detail: '' };
    if (attr.state === 'unified') {
      return {
        tone: 'ms-badge green',
        label: '已统一归因',
        detail: (attr.live?.authority || '已签名') + ' · ' + (attr.live?.identifier || 'com.anymux.app'),
      };
    }
    if (attr.state === 'restart_required') {
      return {
        tone: 'ms-badge amber',
        label: '待重启 tmux 生效',
        detail: '新版签名助手已在磁盘就绪；当前运行中的 tmux PID ' + (attr.livePid || '') + ' 仍使用旧身份',
      };
    }
    if (attr.state === 'not_running') {
      return {
        tone: attr.installedReady ? 'ms-badge green' : 'ms-badge amber',
        label: attr.installedReady ? '助手已签名就绪' : '待签名构建',
        detail: attr.installed?.realPath || attr.installed?.path || '',
      };
    }
    return {
      tone: 'ms-badge red',
      label: '未统一（裸二进制）',
      detail: attr.live?.identifier ? '当前 Identifier: ' + attr.live.identifier : '当前 tmux 使用 ad-hoc 裸二进制',
    };
  }

  function renderBanner(data) {
    if (!data || !data.supported) {
      return '<div class="macos-perm-banner"><div class="macos-perm-banner-copy"><strong>当前主机非 macOS</strong><p>macOS 系统隐私权限引导仅在 Apple 桌面端生效。</p></div></div>';
    }
    var attr = data.attribution || {};
    var bothGranted = data.panelFda === 'granted' && (data.tmuxFda === 'granted' || data.tmuxFda === 'not_running');
    if (attr.state === 'unified' && bothGranted) {
      return '<div class="macos-perm-banner is-ok"><div class="macos-perm-banner-copy">'
        + '<strong>权限与签名身份已就绪</strong>'
        + '<p>Anymux 与运行中的 tmux 共享同一个签名身份（' + esc(attr.live?.identifier || 'com.anymux.app') + '），并已获得完全磁盘访问权限。</p>'
        + '</div></div>';
    }
    if (attr.state === 'restart_required') {
      return '<div class="macos-perm-banner"><div class="macos-perm-banner-copy">'
        + '<strong>新版签名 tmux 助手已安装，待重启 tmux 后接管</strong>'
        + '<p>为保护当前正在运行的会话，面板不会强行重启 tmux（PID ' + esc(attr.livePid || '') + '）。请在保存当前任务后重启一次 tmux 服务，之后只需在系统设置中为 Anymux 勾选一次完全磁盘访问权限即可。</p>'
        + '</div></div>';
    }
    return '<div class="macos-perm-banner"><div class="macos-perm-banner-copy">'
      + '<strong>授予完全磁盘访问权限即可告别反复弹窗</strong>'
      + '<p>在 macOS 中，终端内运行的 Agent 会继承宿主进程的系统隐私权限。点击下方「打开系统设置」将 Anymux 加入「完全磁盘访问权限」后，重新打开会话即可生效。</p>'
      + '</div></div>';
  }

  function renderPanel(data) {
    if (!data) {
      return '<div class="intro"><h2>系统权限</h2><p>正在检测本机 macOS 隐私权限状态…</p></div>';
    }
    var attrInfo = attributionSummary(data.attribution);
    var rows = PERMISSION_ROWS.map(function (row) {
      var badge = '';
      if (row.showFdaBadge) {
        badge = badgeForFda(data.tmuxFda === 'granted' && data.panelFda === 'granted' ? 'granted' : (data.panelFda === 'granted' ? data.tmuxFda : data.panelFda));
      } else if (row.recommended) {
        badge = '<span class="ms-badge">推荐</span>';
      }
      var extraBtns = '';
      if (row.showReveal && data.appPath) {
        extraBtns += '<button type="button" class="ms-btn" data-mp-reveal="app">在 Finder 中显示 Anymux</button>';
      }
      if (row.showReveal && data.tmuxInstalledPath && data.attribution?.state !== 'unified') {
        extraBtns += '<button type="button" class="ms-btn" data-mp-reveal="tmux">显示 tmux 位置</button>';
      }
      return '<div class="macos-perm-row">'
        + '<div class="macos-perm-row-main">'
        + '<div class="macos-perm-row-title"><span>' + esc(row.title) + '</span>' + badge + '</div>'
        + '<p class="macos-perm-row-desc">' + esc(row.desc) + '</p>'
        + '</div>'
        + '<div class="macos-perm-row-actions">'
        + extraBtns
        + '<button type="button" class="ms-btn" data-mp-open="' + esc(row.id) + '">' + esc(row.primaryLabel) + '</button>'
        + '</div></div>';
    }).join('');

    return '<div class="intro"><h2>系统权限</h2>'
      + '<p>统一管理 Anymux 与内置 tmux 的 macOS 系统隐私授权，避免 Agent 在使用过程中反复弹出系统权限确认框。</p></div>'
      + '<div class="macos-perm-section">'
      + renderBanner(data)
      + '<div class="macos-perm-summary">'
      + '<div class="macos-perm-stat"><div class="macos-perm-stat-head"><span>面板服务磁盘权限</span>' + badgeForFda(data.panelFda) + '</div>'
      + '<div class="macos-perm-stat-detail">' + esc(data.appPath || '未检测到 Anymux.app') + '</div></div>'
      + '<div class="macos-perm-stat"><div class="macos-perm-stat-head"><span>tmux 守护磁盘权限</span>' + badgeForFda(data.tmuxFda) + '</div>'
      + '<div class="macos-perm-stat-detail">' + esc(data.attribution?.live?.realPath || data.tmuxInstalledPath || 'tmux') + '</div></div>'
      + '<div class="macos-perm-stat"><div class="macos-perm-stat-head"><span>TCC 签名归因</span><span class="' + attrInfo.tone + '">' + esc(attrInfo.label) + '</span></div>'
      + '<div class="macos-perm-stat-detail">' + esc(attrInfo.detail || '—') + '</div></div>'
      + '</div>'
      + '<div class="section-head"><h3>macOS 隐私授权项</h3>'
      + '<button type="button" class="ms-btn" data-mp-refresh="1">重新检测</button></div>'
      + '<div class="macos-perm-list">' + rows + '</div>'
      + '</div>';
  }

  function removeNudge() {
    var existing = global.document && global.document.getElementById('macos-perm-nudge');
    if (existing) existing.remove();
  }

  function syncNudgeBanner(data) {
    if (!global.document || !data || !data.supported || nudgeDismissedInSession) {
      removeNudge();
      return;
    }
    var prompt = data.tccPrompt;
    if (!prompt || !prompt.nudgePending) {
      removeNudge();
      return;
    }
    if (global.document.getElementById('macos-perm-nudge')) return;

    var card = global.document.createElement('aside');
    card.id = 'macos-perm-nudge';
    card.className = 'macos-perm-nudge';
    card.setAttribute('role', 'status');
    card.innerHTML = '<div class="macos-perm-nudge-head">'
      + '<strong>macOS 刚刚弹出了 ' + esc(prompt.promptCount) + ' 次系统权限确认框</strong>'
      + '<button type="button" class="macos-perm-nudge-close" data-mp-nudge="close" aria-label="关闭">×</button>'
      + '</div>'
      + '<p>为 Anymux 开启「完全磁盘访问权限」可让终端内的 Agent 一次授权、不再反复弹窗。</p>'
      + '<div class="macos-perm-nudge-actions">'
      + '<button type="button" class="ms-btn primary" data-mp-nudge="open">前往授权</button>'
      + '<button type="button" class="ms-btn" data-mp-nudge="dismiss">不再提示</button>'
      + '</div>';

    card.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-mp-nudge]');
      if (!btn) return;
      var action = btn.dataset.mpNudge;
      if (action === 'close') {
        nudgeDismissedInSession = true;
        removeNudge();
      } else if (action === 'dismiss') {
        nudgeDismissedInSession = true;
        removeNudge();
        global.Api.post('/api/macos-permissions/dismiss-nudge', {}).catch(function () {});
      } else if (action === 'open') {
        removeNudge();
        if (global.ServersPage) global.ServersPage.settingsSection = 'macos-permissions';
        if (global.Router && typeof global.Router.go === 'function') {
          global.Router.go({ name: 'settings', params: {} });
        } else {
          global.location.hash = '#settings';
        }
      }
    });

    global.document.body.appendChild(card);
  }

  async function mount(view) {
    if (!view) return;
    var host = view.querySelector('#macos-permissions-root');
    if (!host) return;

    var renderCurrent = async function (force) {
      var data = await fetchStatus(force);
      if (!host.isConnected) return;
      host.innerHTML = renderPanel(data);
    };

    if (!host.dataset.mpBound) {
      host.dataset.mpBound = '1';
      host.addEventListener('click', function (event) {
        var openBtn = event.target.closest('[data-mp-open]');
        if (openBtn) {
          global.Api.post('/api/macos-permissions/open-settings', { id: openBtn.dataset.mpOpen })
            .then(function () {
              if (global.AppShell && global.AppShell.toast) global.AppShell.toast('已打开 macOS 系统设置，授权后切回会自动刷新');
            })
            .catch(function (err) {
              if (global.AppShell && global.AppShell.toast) global.AppShell.toast(err.message || '打开系统设置失败');
            });
          return;
        }
        var revealBtn = event.target.closest('[data-mp-reveal]');
        if (revealBtn) {
          global.Api.post('/api/macos-permissions/reveal', { target: revealBtn.dataset.mpReveal })
            .catch(function (err) {
              if (global.AppShell && global.AppShell.toast) global.AppShell.toast(err.message || '定位文件失败');
            });
          return;
        }
        if (event.target.closest('[data-mp-refresh]')) {
          renderCurrent(true);
        }
      });
    }

    if (cachedStatus) host.innerHTML = renderPanel(cachedStatus);
    await renderCurrent(true);
  }

  if (global.PanelSlots) {
    global.PanelSlots.settingsSections.register({
      id: 'macos-permissions',
      label: '系统权限',
      order: 35,
      available: function () { return Boolean(cachedStatus && cachedStatus.supported); },
      render: function () { return '<div id="macos-permissions-root"></div>'; },
      mount: mount,
    });
  }

  if (global.window && !focusBound) {
    focusBound = true;
    global.window.addEventListener('focus', function () {
      fetchStatus(true).then(function (data) {
        var host = global.document && global.document.querySelector('#macos-permissions-root');
        if (host && host.isConnected && data) host.innerHTML = renderPanel(data);
      });
    });
    setTimeout(function () { fetchStatus(true); }, 1200);
  }
})(typeof window !== 'undefined' ? window : globalThis);
