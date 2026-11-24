/* global Blocks, PanelSlots, AppShell */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.PanelSlots || !window.Blocks) return;

  function openSessionVaultModal() {
    var existing = document.getElementById('sv-modal-backdrop');
    if (existing) existing.remove();
    var serverId = (window.Blocks.ui.currentContext && window.Blocks.ui.currentContext().serverId) || (window.Api?.activeServerId?.() || 'local');
    var client = window.Blocks.ui.client(serverId);

    var backdrop = document.createElement('div');
    backdrop.id = 'sv-modal-backdrop';
    backdrop.className = 'ms-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ms-modal sv-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Session Vault');
    modal.innerHTML = '<div class="sv-head"><strong>Session Vault · 只读 AI 会话档案与用量</strong><button type="button" class="ms-btn" data-sv-close>关闭</button></div>'
      + '<div class="sv-summary" data-sv-summary>正在汇总用量…</div>'
      + '<div class="sv-controls">'
      + '<select class="ms-btn" data-sv-provider><option value="">全部 Agent</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="gemini">Gemini</option></select>'
      + '<input type="search" class="sv-search" data-sv-query placeholder="搜索标题、目录、分支或模型…">'
      + '</div>'
      + '<div class="sv-main"><div class="sv-list" data-sv-list>加载中…</div><div class="sv-detail" data-sv-detail>选择左侧会话查看只读对话记录</div></div>';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelector('[data-sv-close]').addEventListener('click', function () { backdrop.remove(); });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });

    var summaryEl = modal.querySelector('[data-sv-summary]');
    client.get('/api/session-vault/summary').then(function (sum) {
      summaryEl.innerHTML = '<span class="sv-chip">总会话 ' + (sum.totalSessions || 0) + '</span>'
        + '<span class="sv-chip">Input Tokens: ' + Number(sum.totalInputTokens || 0).toLocaleString() + '</span>'
        + '<span class="sv-chip">Output Tokens: ' + Number(sum.totalOutputTokens || 0).toLocaleString() + '</span>'
        + '<span class="sv-chip">Claude ' + (sum.byProvider?.claude?.sessions || 0) + ' · Codex ' + (sum.byProvider?.codex?.sessions || 0) + ' · Gemini ' + (sum.byProvider?.gemini?.sessions || 0) + '</span>';
    }).catch(function () { summaryEl.textContent = '用量读取失败'; });

    function loadDetail(session) {
      var detail = modal.querySelector('[data-sv-detail]');
      detail.textContent = '正在读取会话内容…';
      client.get('/api/session-vault/sessions/' + encodeURIComponent(session.provider) + '/' + encodeURIComponent(session.id)).then(function (data) {
        detail.replaceChildren();
        var top = document.createElement('div');
        top.className = 'wt-card-row';
        var info = document.createElement('span');
        info.textContent = session.provider.toUpperCase() + ' · ' + (session.cwd || '未知目录');
        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ms-btn';
        copyBtn.textContent = '复制恢复命令';
        copyBtn.addEventListener('click', function () {
          window._copyToClipboard?.(session.resumeCommand);
          window.AppShell?.toast?.('已复制：' + session.resumeCommand);
        });
        top.append(info, copyBtn);
        detail.appendChild(top);
        (data.turns || []).forEach(function (turn) {
          var box = document.createElement('div');
          box.className = 'sv-turn ' + (turn.role === 'user' ? 'is-user' : '');
          box.textContent = (turn.role === 'user' ? '[User] ' : '[Assistant] ') + turn.text;
          detail.appendChild(box);
        });
      }).catch(function (err) { detail.textContent = '读取失败：' + (err.message || ''); });
    }

    function refreshList() {
      var provider = modal.querySelector('[data-sv-provider]').value;
      var q = modal.querySelector('[data-sv-query]').value.trim();
      var list = modal.querySelector('[data-sv-list]');
      client.get('/api/session-vault/sessions', { provider: provider, q: q, limit: 60 }).then(function (res) {
        var sessions = res.sessions || [];
        list.replaceChildren();
        if (!sessions.length) { list.textContent = '没有匹配的只读会话记录。'; return; }
        sessions.forEach(function (s) {
          var item = document.createElement('button');
          item.type = 'button';
          item.className = 'sv-item';
          item.innerHTML = '<div class="sv-item-title"></div><div class="sv-item-meta"><span>' + s.provider + '</span><span>' + (s.model || '') + '</span></div>';
          item.querySelector('.sv-item-title').textContent = s.title;
          item.addEventListener('click', function () {
            list.querySelectorAll('.sv-item.active').forEach(function (n) { n.classList.remove('active'); });
            item.classList.add('active');
            loadDetail(s);
          });
          list.appendChild(item);
        });
      }).catch(function (err) { list.textContent = '加载失败：' + (err.message || ''); });
    }

    modal.querySelector('[data-sv-provider]').addEventListener('change', refreshList);
    modal.querySelector('[data-sv-query]').addEventListener('input', refreshList);
    refreshList();
  }

  PanelSlots.commands.register({
    id: 'session-vault',
    order: 26,
    group: 'block',
    title: 'Session Vault · AI 会话档案与用量',
    icon: 'history',
    run: openSessionVaultModal,
    keywords: 'session vault transcript history usage claude codex gemini 会话 历史 用量',
  });
})();
