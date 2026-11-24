/* global Api, Blocks, PanelSlots, FilePreview, AppShell */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.PanelSlots || !window.Blocks) return;

  function activeRepoContext() {
    var ctx = window.Blocks.ui && window.Blocks.ui.currentContext ? window.Blocks.ui.currentContext() : {};
    var serverId = ctx.serverId || (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
    var client = window.Blocks.ui.client(serverId);
    return { serverId: serverId, paneId: ctx.paneId || '', cwd: (ctx.target && ctx.target.cwd) || '.', client: client };
  }

  function openWorktreesModal() {
    var existing = document.getElementById('wt-modal-backdrop');
    if (existing) existing.remove();
    var ctx = activeRepoContext();
    var backdrop = document.createElement('div');
    backdrop.id = 'wt-modal-backdrop';
    backdrop.className = 'ms-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'ms-modal wt-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Git Worktrees');
    modal.innerHTML = '<div class="wt-head"><strong>Git Worktrees · 并行分支工作树</strong><button type="button" class="ms-btn" data-wt-close>关闭</button></div>'
      + '<div class="wt-body">'
      + '<form class="wt-form" data-wt-form>'
      + '<input type="text" class="wt-input" name="branch" placeholder="新分支名，例如 feat/auth-fix" required>'
      + '<label class="wt-check"><input type="checkbox" name="openWindow" checked> 同时在 tmux 中新建窗口</label>'
      + '<button type="submit" class="ms-btn primary">创建 Worktree</button>'
      + '</form>'
      + '<div class="wt-list" data-wt-list>正在加载…</div>'
      + '</div>';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close() { backdrop.remove(); }
    modal.querySelector('[data-wt-close]').addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });

    var currentRepoRoot = ctx.cwd || '.';
    function renderList() {
      var listEl = modal.querySelector('[data-wt-list]');
      ctx.client.get('/api/worktrees', { path: currentRepoRoot, paneId: ctx.paneId }).then(function (data) {
        currentRepoRoot = data.repoRoot || currentRepoRoot;
        var items = data.worktrees || [];
        if (!items.length) { listEl.textContent = '当前仓库没有 worktree。'; return; }
        listEl.replaceChildren();
        items.forEach(function (wt) {
          var card = document.createElement('div');
          card.className = 'wt-card';
          var row = document.createElement('div');
          row.className = 'wt-card-row';
          var left = document.createElement('div');
          var branch = document.createElement('span');
          branch.className = 'wt-branch';
          branch.textContent = (wt.branch || (wt.detached ? 'detached' : 'worktree')) + (wt.isMain ? ' (主仓库)' : '');
          left.appendChild(branch);
          if (wt.dirtyCount > 0) {
            var dirty = document.createElement('span');
            dirty.className = 'wt-badge is-warn';
            dirty.textContent = wt.dirtyCount + ' 处未提交';
            left.append(' ', dirty);
          }
          if ((wt.activePanes || []).length > 0) {
            var active = document.createElement('span');
            active.className = 'wt-badge';
            active.textContent = wt.activePanes.length + ' 个活动窗格';
            left.append(' ', active);
          }
          var actions = document.createElement('div');
          actions.className = 'wt-actions';
          var openDir = document.createElement('button');
          openDir.type = 'button';
          openDir.className = 'ms-btn';
          openDir.textContent = '浏览目录';
          openDir.addEventListener('click', function () {
            if (window.FilePreview) FilePreview.openFile(wt.path, ctx.paneId || undefined, { source: { serverId: ctx.serverId, paneId: ctx.paneId || undefined } });
          });
          actions.appendChild(openDir);
          if (!wt.isMain) {
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'ms-btn';
            removeBtn.textContent = '安全移除';
            removeBtn.addEventListener('click', function () {
              ctx.client.post('/api/worktrees/check-remove', { path: currentRepoRoot, worktreePath: wt.path }).then(function (check) {
                var force = false;
                if (!check.safe) {
                  if (!window.confirm('注意：' + check.reasons.join('；') + '。是否仍要强制移除此 Worktree？')) return;
                  force = true;
                }
                return ctx.client.del('/api/worktrees?path=' + encodeURIComponent(currentRepoRoot) + '&worktreePath=' + encodeURIComponent(wt.path) + (force ? '&force=true' : '')).then(function () {
                  if (window.MsApp?.refreshWorkspace) window.MsApp.refreshWorkspace(ctx.serverId);
                  renderList();
                });
              }).catch(function (err) { window.AppShell?.toast?.(err.message || '移除失败'); });
            });
            actions.appendChild(removeBtn);
          }
          row.append(left, actions);
          var pathEl = document.createElement('div');
          pathEl.className = 'wt-path';
          pathEl.textContent = wt.path;
          card.append(row, pathEl);
          listEl.appendChild(card);
        });
      }).catch(function (err) {
        listEl.textContent = '加载失败：' + (err.message || '当前路径可能不是 Git 仓库');
      });
    }

    modal.querySelector('[data-wt-form]').addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var branch = form.branch.value.trim();
      if (!branch) return;
      ctx.client.post('/api/worktrees', {
        path: currentRepoRoot,
        paneId: ctx.paneId || undefined,
        branch: branch,
        openWindow: form.openWindow.checked,
      }).then(function () {
        form.branch.value = '';
        if (window.MsApp?.refreshWorkspace) window.MsApp.refreshWorkspace(ctx.serverId);
        renderList();
      }).catch(function (err) {
        window.AppShell?.toast?.(err.message || '创建 Worktree 失败');
      });
    });

    renderList();
  }

  PanelSlots.commands.register({
    id: 'worktrees',
    order: 25,
    group: 'block',
    title: 'Git Worktrees · 并行分支',
    icon: 'branch',
    run: openWorktreesModal,
    keywords: 'worktree git branch parallel orca 并行 分支 工作树',
  });
})();
