/* global Blocks, FilePreview, CommandPalette, PanelSlots, Api, AppShell */

// File commands (the palette and Alt+Shift shortcuts: browse, quick open, the
// TODO.md board), the file index quick open searches, and `anymux open <file>`
// from a pane. Loaded only with the files plugin.

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks || !window.BlockHost || !window.PanelSlots) return;

  var ui = Blocks.ui;
  var el = ui.el, button = ui.button, iconButton = ui.iconButton, icon = Blocks.icon;
  var toast = ui.toast, errorText = ui.errorText;

  var _fileIndex = { key: '', promise: null, at: 0 };
  /** Files under the pane's cwd for quick-open, cached for 30s per pane. */
  function fileIndex() {
    var ctx = ui.currentContext();
    var key = ctx.serverId + '|' + (ctx.paneId || '');
    if (_fileIndex.promise && _fileIndex.key === key && Date.now() - _fileIndex.at < 30000) return _fileIndex.promise;
    _fileIndex.key = key;
    _fileIndex.at = Date.now();
    _fileIndex.promise = ui.client(ctx.serverId).get('/api/files/index', { path: '.', paneId: ctx.paneId }).then(function (data) {
      return {
        root: data.root, truncated: data.truncated, source: data.source,
        files: data.files,
        open: function (rel) { if (window.FilePreview) FilePreview.openFile(data.root.replace(/\/$/, '') + '/' + rel, ctx.paneId); },
      };
    });
    _fileIndex.promise.catch(function () { _fileIndex.promise = null; });
    return _fileIndex.promise;
  }

  Blocks.fileIndex = fileIndex;

  function openFile(path, paneId) {
    if (window.FilePreview) FilePreview.openFile(path, paneId || ui.currentContext().paneId);
  }

  // --- `anymux open --dock` and documents agents write (agent-docs) ---------
  //
  // A dock document belongs to its source window even while another window
  // is on screen. Save it there first; notices are a way back, not its storage.
  var KIND_LABELS = { draft: '草稿', spec: '设计', plan: '计划', progress: '进度' };
  var NOTICE_REPEAT_MS = 15000;
  var _noticed = {};
  var _documentSequence = 0;
  var _documentRequests = new Map();

  function documentKey(event, target) {
    var source = target || event;
    return [event.serverId, source.instanceId, source.windowId, event.path].join('\u0000');
  }

  function rememberDocumentRequest(event, target, sequence) {
    var key = documentKey(event, target);
    var previous = _documentRequests.get(key);
    var paneId = target ? target.paneId : event.paneId || null;
    if (previous && (previous.sequence > sequence || (event.origin === 'agent-doc' && !paneId && previous.paneId))) return false;
    _documentRequests.set(key, { sequence: sequence, paneId: paneId || previous && previous.paneId || null });
    return true;
  }

  function documentTarget(serverId, paneIds, workspace, event) {
    var target = ui.windowTarget(serverId, paneIds, workspace, event);
    if (event.origin !== 'agent-doc' || paneIds.length < 2) return target;
    // Filesystem discovery knows project candidates, not the writing pane.
    // A unique window can receive the tab, but must not get a guessed Reply target.
    var windows = new Set();
    (workspace && workspace.sessions || []).forEach(function (session) {
      (session.windows || []).forEach(function (win) {
        if (event.windowId && win.id !== event.windowId) return;
        if ((win.panes || []).some(function (pane) { return paneIds.indexOf(pane.id) >= 0; })) windows.add(win.id);
      });
    });
    if (!workspace || workspace.complete === false || windows.size !== 1) return null;
    return target && Object.assign({}, target, { paneId: null });
  }

  function revealDocument(event, target) {
    if (!window.FilePreview) return;
    var serverId = target ? target.serverId : event.serverId;
    function modal() { return FilePreview.openFile(event.path, null, { source: { serverId: serverId, paneId: null } }); }
    if (!target) return modal();
    // Notices outlive moves, pane closures and server restarts. Resolve the
    // stable window ID again instead of navigating with yesterday's session.
    return ui.client(serverId).get('/api/workspace').then(function (workspace) {
      if (workspace.instanceId && workspace.instanceId !== target.instanceId) return modal();
      var current = null;
      (workspace.sessions || []).forEach(function (session) {
        (session.windows || []).forEach(function (win) {
          if (win.id !== target.windowId) return;
          var panes = win.panes || [];
          var pane = panes.filter(function (p) { return p.id === target.paneId; })[0];
          if (panes.length) current = Object.assign({}, target, { sessionId: session.id, paneId: pane ? pane.id : null });
        });
      });
      if (!current) return modal();
      return FilePreview.queueDocked(event.path, current.paneId, Object.assign({}, current, {
        activate: true, fragment: event.fragment,
      })).then(function () {
        return ui.revealWindow(current, function () {
          if (!FilePreview.blockDock.available()) return modal();
          var restore = document.querySelector('.fp-dock-restore');
          if (restore) restore.click();
          return FilePreview.openDocked(event.path, current.paneId, {
            source: { serverId: serverId, paneId: current.paneId }, fragment: event.fragment,
          }).then(function (result) {
            if (result === 'busy' || result === 'unavailable') return modal();
            return result;
          });
        });
      });
    }, modal);
  }

  Blocks.openDocumentNotice = function (notice) { return revealDocument(notice, notice.target); };

  function noticeDocument(event, target, result, sequence) {
    if (event.activate === false) return;
    var now = Date.now();
    var key = documentKey(event, target);
    var paneId = target ? target.paneId : event.paneId || null;
    var latest = _documentRequests.get(key);
    if (latest && latest.sequence > sequence) return;
    var previous = _noticed[key];
    if (previous && previous.paneId === paneId && now - previous.at < NOTICE_REPEAT_MS) return;
    Object.keys(_noticed).forEach(function (key) { if (now - _noticed[key].at >= NOTICE_REPEAT_MS) delete _noticed[key]; });
    _noticed[key] = { at: now, paneId: paneId };
    var name = event.path.split('/').pop();
    var message = result === 'activated' ? '已打开' + (KIND_LABELS[event.kind] || '文档') + '：' + name
      : result === 'queued' ? '文档已加入所属窗口的侧栏：' + name
      : result === 'hidden' ? '新文档已加入收起的侧栏：' + name : '新文档：' + name;
    var open = function () { return revealDocument(event, target); };
    if (window.NotificationPanel && NotificationPanel.addDocument) NotificationPanel.addDocument({
      id: 'doc-' + encodeURIComponent(key), type: 'document', path: event.path, paneId: paneId,
      serverId: event.serverId, target: target, message: message, timestamp: now,
      read: result === 'activated' && document.visibilityState === 'visible',
      session: target && target.session, windowIndex: target && target.windowIndex, windowName: target && target.windowName,
    }, open);
  }

  function openDocument(event) {
    var sequence = ++_documentSequence;
    var serverId = event.serverId || (window.Api && Api.activeServerId ? Api.activeServerId() : 'local');
    event = Object.assign({}, event, { serverId: serverId });
    // Validated CLI events already carry a stable scope. Reserve it before an
    // asynchronous workspace lookup can let an older request through.
    if (event.origin !== 'agent-doc' && event.instanceId && event.windowId
      && !rememberDocumentRequest(event, null, sequence)) return Promise.resolve();
    var paneIds = Array.isArray(event.paneIds) && event.paneIds.length ? event.paneIds : (event.paneId ? [event.paneId] : []);
    var workspace = window.AppShell && AppShell.workspace ? AppShell.workspace(serverId) : null;
    var target = documentTarget(serverId, paneIds, workspace, event);
    var resolveTarget = target || (!paneIds.length && !event.windowId) ? Promise.resolve(target)
      : ui.client(serverId).get('/api/workspace').then(function (workspace) { return documentTarget(serverId, paneIds, workspace, event); }, function () { return null; });
    return resolveTarget.then(function (target) {
      if (!target && event.origin === 'agent-doc') return;
      if (!rememberDocumentRequest(event, target, sequence)) return;
      if (!window.FilePreview || !target) { noticeDocument(event, target, undefined, sequence); return; }
      var opts = Object.assign({}, target, { activate: event.activate !== false, automatic: true,
        replaces: event.replaces || null, fragment: event.fragment || null,
        source: { serverId: serverId, paneId: target.paneId } });
      // Persist before fetching the preview: changing windows or receiving a
      // second document during the fetch must not lose either arrival.
      return FilePreview.queueDocked(event.path, target.paneId, opts).then(function (result) {
        noticeDocument(event, target, result, sequence);
      }, function () { noticeDocument(event, target, undefined, sequence); });
    });
  }

  function openFromPane(event) {
    if (event.placement === 'dock') return openDocument(event);
    return openFile(event.path, event.paneId);
  }

  PanelSlots.commands.register({ id: 'files', order: 30, group: 'block', title: '文件', icon: 'folder', keys: 'Alt+Shift+O', code: 'KeyO', run: function () { openFile('.'); }, keywords: 'files browse folder 目录 文件 浏览' });
  PanelSlots.commands.register({ id: 'quick-open', order: 40, group: 'nav', title: '快速打开文件…', icon: 'search', keys: 'Alt+Shift+P', code: 'KeyP', run: function () { if (window.CommandPalette) CommandPalette.open(null, '/'); }, keywords: 'open file find goto 文件 查找 打开' });
  PanelSlots.commands.register({ id: 'board', order: 50, group: 'block', title: '看板（TODO.md）', icon: 'board', keys: 'Alt+Shift+K', code: 'KeyK', run: function () { openFile('TODO.md'); }, keywords: 'kanban board todo 看板 待办' });
  PanelSlots.openers.register({ id: 'open-file', run: openFromPane });
})();
