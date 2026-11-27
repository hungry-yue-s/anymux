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
      + '<select class="ms-btn" data-sv-provider><option value="">全部 Agent</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="gemini">Gemini</option><option value="opencode">OpenCode</option></select>'
      + '<input type="search" class="sv-search" data-sv-query placeholder="FTS5 全文搜索（支持缩写/路径/纠错）…">'
      + '<button type="button" class="ms-btn" data-sv-reindex>重建索引</button>'
      + '</div>'
      + '<div class="sv-typo-banner" data-sv-typo hidden></div>'
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

    function appendMarkedSnippet(el, snippet) {
      var text = String(snippet || '');
      var parts = text.split(/(<mark>[\s\S]*?<\/mark>)/g);
      parts.forEach(function (part) {
        if (part.indexOf('<mark>') === 0 && part.slice(-7) === '</mark>') {
          var mark = document.createElement('mark');
          mark.textContent = part.slice(6, -7);
          el.appendChild(mark);
        } else if (part) {
          el.appendChild(document.createTextNode(part));
        }
      });
    }

    function loadDetail(session) {
      var detail = modal.querySelector('[data-sv-detail]');
      var sessionId = session.id || session.session_id;
      var resumeCmd = session.resumeCommand || session.resume_command || '';
      detail.textContent = '正在读取会话内容…';
      client.get('/api/session-vault/sessions/' + encodeURIComponent(session.provider) + '/' + encodeURIComponent(sessionId)).then(function (data) {
        detail.replaceChildren();
        var top = document.createElement('div');
        top.className = 'wt-card-row';
        var info = document.createElement('span');
        info.textContent = session.provider.toUpperCase() + ' · ' + (session.cwd || '未知目录');
        var btns = document.createElement('div');
        btns.className = 'sv-detail-actions';
        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ms-btn';
        copyBtn.textContent = '复制恢复命令';
        copyBtn.addEventListener('click', function () {
          window._copyToClipboard?.(resumeCmd);
          window.AppShell?.toast?.('已复制：' + resumeCmd);
        });
        var handoffBtn = document.createElement('button');
        handoffBtn.type = 'button';
        handoffBtn.className = 'ms-btn';
        handoffBtn.textContent = '复制交接 Prompt';
        handoffBtn.addEventListener('click', function () {
          client.get('/api/session-vault/sessions/' + encodeURIComponent(session.provider) + '/' + encodeURIComponent(sessionId) + '/handoff')
            .then(function (res) {
              window._copyToClipboard?.(res.prompt || '');
              window.AppShell?.toast?.('已生成并复制跨 Agent 交接上下文');
            })
            .catch(function (err) { window.AppShell?.toast?.('生成失败：' + (err.message || '')); });
        });
        btns.append(copyBtn, handoffBtn);
        top.append(info, btns);
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
      var typoEl = modal.querySelector('[data-sv-typo]');
      var endpoint = q ? '/api/session-vault/search' : '/api/session-vault/sessions';
      client.get(endpoint, { provider: provider, q: q, limit: 60 }).then(function (res) {
        var sessions = res.results || res.sessions || [];
        if (typoEl) {
          if (res.correctedQuery) {
            typoEl.hidden = false;
            typoEl.textContent = '未命中原词，已自动纠错检索：' + res.correctedQuery;
          } else {
            typoEl.hidden = true;
            typoEl.textContent = '';
          }
        }
        list.replaceChildren();
        if (!sessions.length) { list.textContent = '没有匹配的只读会话记录。'; return; }
        sessions.forEach(function (s) {
          var item = document.createElement('button');
          item.type = 'button';
          item.className = 'sv-item';
          var titleEl = document.createElement('div');
          titleEl.className = 'sv-item-title';
          titleEl.textContent = s.title;
          var metaEl = document.createElement('div');
          metaEl.className = 'sv-item-meta';
          var leftMeta = document.createElement('span');
          leftMeta.textContent = s.provider + (s.forkCount ? (' · +' + s.forkCount + ' 分支') : '');
          var rightMeta = document.createElement('span');
          rightMeta.textContent = s.model || '';
          metaEl.append(leftMeta, rightMeta);
          item.append(titleEl, metaEl);
          if (s.snippet) {
            var snipEl = document.createElement('div');
            snipEl.className = 'sv-snippet';
            appendMarkedSnippet(snipEl, s.snippet);
            item.appendChild(snipEl);
          }
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
    modal.querySelector('[data-sv-reindex]').addEventListener('click', function () {
      client.post('/api/session-vault/index', {}).then(function (stats) {
        window.AppShell?.toast?.('索引已更新：' + (stats.indexed || 0) + ' 个会话');
        refreshList();
      }).catch(function (err) { window.AppShell?.toast?.('索引失败：' + (err.message || '')); });
    });
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
