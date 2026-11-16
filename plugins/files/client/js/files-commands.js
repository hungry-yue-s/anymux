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
  // The side panel belongs to the window in view, so a document goes there only
  // while that window holds the pane it came from (or, for a document found by
  // the watcher, a pane in the same project). Anywhere else, on a phone, or with
  // a modal open, it is a notice with an Open button: nothing takes the screen
  // or the keyboard away from what the person is doing.

  var KIND_LABELS = { draft: '草稿', spec: '设计', plan: '计划', progress: '进度' };
  var NOTICE_REPEAT_MS = 15000;
  var _noticed = {};

  /** Whether the window whose dock is showing holds one of these panes. */
  function windowInView(serverId, paneIds) {
    if (!paneIds.length || !window.FilePreview || !FilePreview.blockDock) return false;
    var key = FilePreview.blockDock.context();
    if (!key) return false;
    var parts = key.split('\u0000');
    if (parts[0] !== serverId) return false;
    var ctx = ui.currentContext();
    if (ctx && ctx.paneId && paneIds.indexOf(ctx.paneId) >= 0) return true;
    var workspace = window.AppShell && AppShell.workspace ? AppShell.workspace(serverId) : null;
    var found = false;
    (workspace && workspace.sessions || []).forEach(function (session) {
      (session.windows || []).forEach(function (win) {
        if (win.id !== parts[2]) return;
        (win.panes || []).forEach(function (pane) { if (paneIds.indexOf(pane.id) >= 0) found = true; });
      });
    });
    return found;
  }

  function noticeDocument(event) {
    if (event.activate === false) return; // a progress log does not call for attention
    var now = Date.now();
    Object.keys(_noticed).forEach(function (key) { if (now - _noticed[key] > NOTICE_REPEAT_MS) delete _noticed[key]; });
    if (_noticed[event.path]) return;
    _noticed[event.path] = now;
    var name = event.path.split('/').pop();
    toast((KIND_LABELS[event.kind] || '文档') + '：' + name, {
      action: { label: '打开', run: function () { openFile(event.path, event.paneId); } },
    });
  }

  function openDocument(event) {
    var serverId = window.Api && Api.activeServerId ? Api.activeServerId() : 'local';
    var paneIds = Array.isArray(event.paneIds) && event.paneIds.length ? event.paneIds : (event.paneId ? [event.paneId] : []);
    if (!window.FilePreview || typeof FilePreview.openDocked !== 'function' || !windowInView(serverId, paneIds)) {
      noticeDocument(event);
      return;
    }
    var paneId = event.paneId || paneIds[0] || null;
    FilePreview.openDocked(event.path, paneId, {
      activate: event.activate !== false,
      replaces: event.replaces || null,
      fragment: event.fragment || null,
      source: { serverId: serverId, paneId: paneId },
    }).then(function (result) {
      if (result === 'busy' || result === 'unavailable') noticeDocument(event);
      else if (result === 'hidden' && event.activate !== false && !_noticed[event.path]) {
        _noticed[event.path] = Date.now();
        toast('新文档在收起的右侧分窗里：' + event.path.split('/').pop(), {
          action: { label: '展开', run: function () {
            var restore = document.querySelector('.fp-dock-restore');
            if (restore) restore.click();
          } },
        });
      }
    }, function () { noticeDocument(event); });
  }

  function openFromPane(event) {
    if (event.placement === 'dock') openDocument(event);
    else openFile(event.path, event.paneId);
  }

  PanelSlots.commands.register({ id: 'files', order: 30, group: 'block', title: '文件', icon: 'folder', keys: 'Alt+Shift+O', code: 'KeyO', run: function () { openFile('.'); }, keywords: 'files browse folder 目录 文件 浏览' });
  PanelSlots.commands.register({ id: 'quick-open', order: 40, group: 'nav', title: '快速打开文件…', icon: 'search', keys: 'Alt+Shift+P', code: 'KeyP', run: function () { if (window.CommandPalette) CommandPalette.open(null, '/'); }, keywords: 'open file find goto 文件 查找 打开' });
  PanelSlots.commands.register({ id: 'board', order: 50, group: 'block', title: '看板（TODO.md）', icon: 'board', keys: 'Alt+Shift+K', code: 'KeyK', run: function () { openFile('TODO.md'); }, keywords: 'kanban board todo 看板 待办' });
  PanelSlots.openers.register({ id: 'open-file', run: openFromPane });
})();
