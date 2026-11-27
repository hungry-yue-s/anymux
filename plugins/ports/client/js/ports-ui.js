/* global Blocks, PanelSlots, AppShell, Api */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.PanelSlots || !window.Blocks) return;

  function openPortsModal() {
    var existing = document.getElementById('ports-modal-backdrop');
    if (existing) existing.remove();
    var ctx = window.Blocks.ui.currentContext ? window.Blocks.ui.currentContext() : {};
    var serverId = ctx.serverId || (window.Api?.activeServerId?.() || 'local');
    var client = window.Blocks.ui.client(serverId);

    var backdrop = document.createElement('div');
    backdrop.id = 'ports-modal-backdrop';
    backdrop.className = 'ms-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ms-modal ports-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '本机监听端口');
    modal.innerHTML = '<div class="ports-head"><strong>本机 TCP 监听端口 · Dev Servers</strong><div><button type="button" class="ms-btn" data-ports-refresh>刷新</button> <button type="button" class="ms-btn" data-ports-close>关闭</button></div></div><div class="ports-list" data-ports-list>正在扫描…</div>';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelector('[data-ports-close]').addEventListener('click', function () { backdrop.remove(); });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });

    function load() {
      var listEl = modal.querySelector('[data-ports-list]');
      client.get('/api/ports').then(function (data) {
        var listeners = data.listeners || [];
        listEl.replaceChildren();
        if (!listeners.length) {
          listEl.textContent = '未检测到用户空间监听端口 (>1024)。';
          return;
        }
        listeners.forEach(function (entry) {
          var row = document.createElement('div');
          row.className = 'ports-row';
          var meta = document.createElement('div');
          meta.className = 'ports-meta';
          var title = document.createElement('strong');
          title.textContent = ':' + entry.port + (entry.command ? ' · ' + entry.command : '');
          var sub = document.createElement('small');
          sub.textContent = 'PID ' + entry.pid + ' · ' + (entry.address || 'localhost');
          meta.append(title, sub);
          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'ms-btn';
          openBtn.textContent = '在浏览器块打开';
          openBtn.addEventListener('click', function () {
            backdrop.remove();
            window.Blocks.openBrowser?.('http://localhost:' + entry.port);
          });
          row.append(meta, openBtn);
          listEl.appendChild(row);
        });
      }).catch(function (err) {
        listEl.textContent = '扫描失败：' + (err.message || '');
      });
    }

    modal.querySelector('[data-ports-refresh]').addEventListener('click', load);
    load();
  }

  PanelSlots.commands.register({
    id: 'ports',
    order: 27,
    group: 'block',
    title: '监听端口 · Dev Servers',
    icon: 'plug',
    run: openPortsModal,
    keywords: 'ports dev server localhost lsof ss netstat 端口 预览',
  });
})();
