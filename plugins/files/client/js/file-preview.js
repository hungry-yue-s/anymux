/* global state */
var FilePreview = (function () {
  'use strict';

  /**
   * '' for the panel's own machine, '/n/:serverId' for another server: files
   * are always read on the machine whose pane printed the path.
   */
  function _machine(source) {
    var api = typeof window !== 'undefined' ? window.Api : null;
    if (!api || typeof api.nodeUrl !== 'function') return '';
    var origin = source || _currentSource;
    return api.nodeUrl(origin ? origin.serverId : api.activeServerId(), '');
  }

  var _overlay = null;
  var _modalReturnFocus = null;
  var _dockReturnFocus = null;
  var _maximized = false;
  var _currentFile = null;
  var _currentPaneId = null;
  var _currentSource = null;
  var _dirContext = null; // parent dir abs path, set when a file is opened from the dir browser
  var _placement = 'modal';
  var _placementButton = null;
  var _maximizeButton = null;
  var _sideResizeCleanup = null;
  var _dockOverlay = null;
  var _dockTabs = [];
  var _activeDockTabId = null;
  var _nextDockTabId = 1;
  var _dockHidden = false;
  var _dockRestoreButton = null;
  var _currentOpenPath = null;
  var _refreshButton = null;
  var _actionMenu = null;
  var _shareDialogClose = null;
  var _autoRefreshTimer = null;
  var _refreshPromise = null;
  var _previewGeneration = 0;
  var _mermaidThemeGeneration = 0;
  var _previewReady = false;
  var _restorePromise = null;
  var _restoreContextKey = null;
  var _restoringDock = false;
  // A dock restored as hidden is built offstage: taking space even for a moment
  // would change the terminal's size twice, and each change can mean a new attach.
  var _restoringHidden = false;
  // openDocked builds its preview offstage and leaves the keyboard alone.
  var _quietOpen = false;
  // Plugins that add to a preview (agent-docs puts a bar above agent documents).
  var _decorators = [];
  var _persistenceSuspended = false;
  // openDocked builds its preview offstage and leaves the keyboard alone: the
  // person may be typing to the agent that wrote the document.
  var _quietOpen = false;
  // Others' additions above a preview (the agent-docs bar): fn({ modal, body, file, paneId, source }).
  var _decorators = [];
  var _dockContextKey = null;
  var _dockContextGeneration = 0;
  var AUTO_REFRESH_MS = 1500;
  var DOCK_STATE_PREFIX = 'tmux_file_preview_dock_v4:';
  var VIEW_DOCK_STATE_PREFIX = 'tmux_file_preview_view_dock_v1:';
  var LEGACY_DOCK_STATE_KEY = 'tmux_file_preview_dock_v1';
  var LEGACY_DOCK_WIDTH_KEY = 'tmux_file_preview_side_width';
  var DOCK_STATE_VERSION = 1;
  var MAX_PERSISTED_DOCK_TABS = 12;
  var MAX_PERSISTED_TAB_ORDER = 40;
  // Tool blocks (git, browser) share this dock's tab strip, width and hide
  // button. BlockHost owns their lifetime and declares them through `blockDock`;
  // a tab keeps `block` and `modal` (its frame), and no file state of its own.
  var _blockTabs = [];
  var _blockListener = null;
  var _blockWindowListener = null;
  var _blockOrderListener = null;
  // The order this window's tabs were saved in, until they are all back.
  var _savedTabOrder = null;
  var _draggedTabId = null;
  var TAB_DRAG_TYPE = 'application/x-anymux-tab';
  var _blockWindowsGoneListener = null;
  var _switchingDockContext = false;
  var _pendingBlockKey = null;
  var _sideSetWidth = null;
  var BLOCK_SIDE_WIDTH = 560;
  var BLOCK_WIDTH_KEY = 'anymux_block_side_width';
  var PREFS_KEY = 'anymux_dock_prefs_v1';
  var MAX_PREFS_ENTRIES = 64;
  var _applyingRemote = false;
  var _workspaceRevisions = {};

  function _syncDockOpenWidth(px) {
    var root = document.documentElement;
    if (root && root.style) {
      if (px && px > 0) root.style.setProperty('--fp-dock-open-width', Math.round(px) + 'px');
      else root.style.removeProperty('--fp-dock-open-width');
    }
    if (typeof window !== 'undefined' && typeof window.Event === 'function' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new window.Event('anymux-dock-layout'));
    }
  }
  // Arrivals not rendered yet. Keep them when a modal or another window owns
  // the preview, and merge them into that window's ordinary persisted dock.
  var _queuedDockDocuments = {};
  var _drainingDocuments = false;

  function _terminalContext() {
    var ui = window.Blocks && window.Blocks.ui;
    var context = ui && ui.currentContext ? ui.currentContext() : null;
    return context && context.onTerminal ? context : null;
  }

  function _sourceForPane(paneId) {
    var context = _terminalContext();
    return {
      serverId: context && context.serverId || (window.Api && window.Api.activeServerId ? window.Api.activeServerId() : 'local'),
      paneId: paneId || (context ? context.paneId : _currentPaneId),
    };
  }

  /**
   * Identifies one window's dock state.
   *
   * tmux IDs survive renames and moves, but restart their sequence with each
   * server process. Missing instance IDs allow an in-memory dock only (old Nodes).
   */
  function _makeDockContextKey(serverId, windowId, instanceId) {
    if (typeof serverId !== 'string' || !serverId) return null;
    if (typeof windowId !== 'string' || !windowId) return null;
    return serverId + '\u0000' + (typeof instanceId === 'string' ? instanceId : '') + '\u0000' + windowId;
  }

  function _dockStateStorageKey(contextKey) {
    if (!contextKey || !contextKey.split('\u0000')[1]) return null;
    return (contextKey.split('\u0000')[1] === 'local-view' ? VIEW_DOCK_STATE_PREFIX : DOCK_STATE_PREFIX) + encodeURIComponent(contextKey);
  }

  function _currentDockStateKey() {
    return _dockStateStorageKey(_dockContextKey);
  }

  function _loadPrefs(contextKey) {
    if (!contextKey) return null;
    if (window.DockSync && typeof window.DockSync.getLocalPrefs === 'function') {
      return window.DockSync.getLocalPrefs(contextKey);
    }
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && parsed[contextKey] ? parsed[contextKey] : null;
    } catch (_) {
      return null;
    }
  }

  function _savePrefs(contextKey, patch) {
    if (!contextKey || !patch) return;
    if (window.DockSync && typeof window.DockSync.setLocalPrefs === 'function') {
      window.DockSync.setLocalPrefs(contextKey, patch);
      return;
    }
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      var map = raw ? JSON.parse(raw) : {};
      if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
      var current = map[contextKey] && typeof map[contextKey] === 'object' ? map[contextKey] : {};
      map[contextKey] = Object.assign({}, current, patch, { updatedAt: Date.now() });
      var entries = Object.entries(map);
      if (entries.length > MAX_PREFS_ENTRIES) {
        entries.sort(function (a, b) {
          return Number((b[1] && b[1].updatedAt) || 0) - Number((a[1] && a[1].updatedAt) || 0);
        });
        var trimmed = {};
        entries.slice(0, MAX_PREFS_ENTRIES).forEach(function (pair) { trimmed[pair[0]] = pair[1]; });
        map = trimmed;
      }
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function _clearPrefs(contextKey) {
    if (!contextKey) return;
    if (window.DockSync && typeof window.DockSync.clearLocalPrefs === 'function') {
      window.DockSync.clearLocalPrefs(contextKey);
      return;
    }
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var map = JSON.parse(raw);
      if (!map || typeof map !== 'object' || !(contextKey in map)) return;
      delete map[contextKey];
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function _syncWindowOp(op, contextKeyOverride) {
    if (_applyingRemote || _persistenceSuspended || _restoringDock || _switchingDockContext) return;
    if (!window.DockSync || typeof window.DockSync.sendWindowOp !== 'function') return;
    if (window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote()) return;
    var ctx = contextKeyOverride || _dockContextKey;
    if (!ctx) return;
    var parts = ctx.split('\u0000');
    if (parts.length !== 3 || !parts[0] || !parts[1] || parts[1] === 'local-view' || !parts[2]) return;
    window.DockSync.sendWindowOp(parts[0], parts[1], parts[2], op);
  }

  function _clearPrefsForServer(serverId) {
    if (!serverId) return;
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var map = JSON.parse(raw);
      if (!map || typeof map !== 'object') return;
      var changed = false;
      Object.keys(map).forEach(function (ctx) {
        if (ctx.split('\u0000')[0] === serverId) {
          delete map[ctx];
          changed = true;
        }
      });
      if (changed) window.localStorage.setItem(PREFS_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function _clearPersistedDock(contextKey) {
    var key = contextKey ? _dockStateStorageKey(contextKey) : _currentDockStateKey();
    if (!key) return;
    try { window.localStorage.removeItem(key); } catch (_) {}
  }

  function _loadDockState(contextKey) {
    var key = contextKey ? _dockStateStorageKey(contextKey) : _currentDockStateKey();
    if (!key) return null;
    var raw;
    try { raw = window.localStorage.getItem(key); } catch (_) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== DOCK_STATE_VERSION || !Array.isArray(parsed.tabs)) {
        _clearPersistedDock(contextKey);
        return null;
      }
      var seen = {};
      var tabs = parsed.tabs.filter(function (tab) {
        if (!tab || typeof tab.path !== 'string' || tab.path.charAt(0) !== '/') return false;
        if (seen[tab.path]) return false;
        seen[tab.path] = true;
        return true;
      }).slice(0, MAX_PERSISTED_DOCK_TABS).map(function (tab) {
        return {
          path: tab.path,
          paneId: typeof tab.paneId === 'string' && /^%\d+$/.test(tab.paneId) ? tab.paneId : null,
          source: tab.source && typeof tab.source.serverId === 'string' ? tab.source : null,
          unread: tab.unread === true,
          automatic: tab.automatic === true,
          fragment: typeof tab.fragment === 'string' ? tab.fragment : null,
        };
      });
      if (tabs.length === 0) {
        _clearPersistedDock(contextKey);
        return null;
      }
      var width = Number(parsed.width);
      var loaded = {
        tabs: tabs,
        activePath: typeof parsed.activePath === 'string' ? parsed.activePath : tabs[0].path,
        hidden: parsed.hidden === true,
        width: isFinite(width) && width > 0 ? width : 0,
      };
      if (typeof parsed.activeBlock === 'string') loaded.activeBlock = parsed.activeBlock;
      if (Array.isArray(parsed.order)) {
        loaded.order = parsed.order.filter(function (key) { return typeof key === 'string'; }).slice(0, MAX_PERSISTED_TAB_ORDER);
      }
      return loaded;
    } catch (_) {
      _clearPersistedDock(contextKey);
      return null;
    }
  }

  function _persistDockState(widthOverride) {
    var key = _currentDockStateKey();
    if (_persistenceSuspended || !key) return;
    if (_dockTabs.length === 0 && !(_queuedDockDocuments[_dockContextKey] || []).length) {
      _clearPersistedDock();
      _clearPrefs(_dockContextKey);
      return;
    }
    var active = _activeDockTab();
    var width = Number(widthOverride) || 0;
    if (!width && _dockOverlay) {
      width = parseFloat(_dockOverlay.style.flexBasis)
        || (_dockOverlay.isConnected ? _dockOverlay.getBoundingClientRect().width : 0);
    }
    var state = {
      version: DOCK_STATE_VERSION,
      tabs: _fileTabs().slice(0, MAX_PERSISTED_DOCK_TABS).map(function (tab) {
        var saved = { path: tab.path, paneId: tab.paneId || null };
        if (tab.unread) saved.unread = true;
        if (tab.automatic) saved.automatic = true;
        if (tab.fragment) saved.fragment = tab.fragment;
        if (tab.source && (_dockContextKey.split('\u0000')[1] === 'local-view'
          || tab.source.serverId !== _dockContextKey.split('\u0000')[0])) saved.source = tab.source;
        return saved;
      }).filter(function (tab) { return typeof tab.path === 'string' && tab.path.charAt(0) === '/'; }),
      activePath: active && !active.block ? active.path : null,
      hidden: _dockHidden,
      width: width > 0 ? Math.round(width) : 0,
    };
    if (active && active.block) state.activeBlock = active.block.persistKey;
    // Files and blocks in the order they are shown, which the user may have dragged.
    state.order = _dockTabs.map(_tabOrderKey).slice(0, MAX_PERSISTED_TAB_ORDER);
    _savedTabOrder = state.order;
    _mergeDocumentArrivals(state, _queuedDockDocuments[_dockContextKey] || []);
    if (state.tabs.length === 0) {
      _clearPersistedDock();
      _savePrefs(_dockContextKey, {
        hidden: _dockHidden,
        width: state.width,
        order: state.order,
        activeBlock: state.activeBlock || null,
      });
      return;
    }
    _savePrefs(_dockContextKey, {
      hidden: _dockHidden,
      width: state.width,
    });
    try { window.localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
  }

  /** Only a complete, successful snapshot can prove a window has gone away. */
  function reconcileWorkspace(serverId, workspace) {
    if (!serverId || !workspace || workspace.provider !== 'tmux' || workspace.complete !== true
      || !Array.isArray(workspace.sessions)
      || workspace.sessions.some(function (session) {
        return !session || session.windowsComplete === false || !Array.isArray(session.windows)
          || typeof session.windowCount === 'number' && session.windows.length !== session.windowCount
          || session.windows.some(function (win) { return !win || typeof win.id !== 'string' || win.panesComplete === false; });
      })
      || !(typeof workspace.instanceId === 'string' && workspace.instanceId
        || workspace.instanceId === null && workspace.sessions.length === 0)) return;
    var revisionKey = serverId + '\u0000' + workspace.instanceId;
    if (typeof workspace.revision === 'number' && workspace.revision < _workspaceRevisions[revisionKey]) return;
    var live = new Set();
    workspace.sessions.forEach(function (session) {
      session.windows.forEach(function (win) {
        live.add(_makeDockContextKey(serverId, win.id, workspace.instanceId));
      });
    });
    // A native client's verified window is newer evidence than a delayed tree.
    // Pending focus may retain that identity too; absence is not a deletion.
    var focused = _terminalContext();
    if (focused && focused.serverId === serverId && focused.windowId
      && (focused.instanceId && focused.instanceId !== workspace.instanceId
        || !live.has(_makeDockContextKey(serverId, focused.windowId, focused.instanceId)))) return;
    if (typeof workspace.revision === 'number') _workspaceRevisions[revisionKey] = workspace.revision;
    Object.keys(_queuedDockDocuments).forEach(function (context) {
      if (context.split('\u0000')[0] === serverId && !live.has(context)) delete _queuedDockDocuments[context];
    });
    if (_dockContextKey) {
      var current = _dockContextKey.split('\u0000');
      if (current[0] === serverId && current[1] !== 'local-view' && !live.has(_dockContextKey)) {
        // Invalidate pending restores before deleting; switching must not save
        // the removed window back into localStorage later.
        var replacement = _makeDockContextKey(serverId, current[2], workspace.instanceId);
        switchDockContext(serverId, live.has(replacement) ? current[2] : null, workspace.instanceId);
      }
    }
    try {
      var storage = window.localStorage;
      for (var i = storage.length - 1; i >= 0; i--) {
        var key = storage.key(i);
        if (key === LEGACY_DOCK_STATE_KEY || key === LEGACY_DOCK_WIDTH_KEY
          || key.indexOf('tmux_file_preview_dock_v2:') === 0) {
          storage.removeItem(key);
          continue;
        }
        var prefix = key.indexOf(DOCK_STATE_PREFIX) === 0 ? DOCK_STATE_PREFIX
          : key.indexOf('tmux_file_preview_dock_v3:') === 0 ? 'tmux_file_preview_dock_v3:' : null;
        if (!prefix) continue;
        var context;
        try { context = decodeURIComponent(key.slice(prefix.length)); } catch (_) { continue; }
        if (context.split('\u0000')[0] === serverId && (prefix !== DOCK_STATE_PREFIX || !live.has(context))) {
          storage.removeItem(key);
        }
      }
    } catch (_) { /* storage may be unavailable */ }
    if (_blockWindowsGoneListener) _blockWindowsGoneListener(serverId, function (context) { return context.split('\u0000')[1] === 'local-view' || live.has(context); });
  }

  /** A successful DELETE is enough evidence even if the next tree fetch fails. */
  function forgetWindow(serverId, windowId, instanceId) {
    var context = _makeDockContextKey(serverId, windowId, instanceId);
    if (!context) return;
    delete _queuedDockDocuments[context];
    if (context === _dockContextKey) switchDockContext(null, null);
    var key = _dockStateStorageKey(context);
    try {
      if (key) window.localStorage.removeItem(key);
      window.localStorage.removeItem('tmux_file_preview_dock_v3:' + encodeURIComponent(serverId + '\u0000' + windowId));
    } catch (_) { /* storage may be unavailable */ }
    if (_blockWindowsGoneListener) _blockWindowsGoneListener(serverId, function (other) { return other !== context; });
  }

  function _dockLayout() {
    return document.querySelector('.ms-app.mode-terminal .ms-main');
  }

  function _isMobileReader() {
    if (window.MobileUI && typeof window.MobileUI.isMobile === 'function') return window.MobileUI.isMobile();
    return window.innerWidth < 768 || !!(window.matchMedia
      && window.matchMedia('(pointer: coarse) and (max-height: 560px) and (max-width: 1023px)').matches);
  }

  function _canDockRight() {
    var bounds = _sideWidthBounds();
    return !_isMobileReader() && window.innerWidth >= 900
      && !!_dockContextKey
      && !!_dockLayout()
      && !!document.querySelector('.terminal-view, .wb-stage, #ms-workbench-host')
      && bounds.max >= bounds.min;
  }

  function _sideWidthBounds() {
    var layout = _dockLayout();
    var layoutWidth = layout ? layout.getBoundingClientRect().width : 0;
    if (!layoutWidth) layoutWidth = window.innerWidth || 0;

    // .ms-main is the column beside the shell's sidebar: all of it is shared.
    var available = Math.max(0, layoutWidth);
    var min = 320;
    // Dragging left may use 70% of the shared workstage, including restored
    // widths. Keep the file in a modal when the 320px minimum cannot fit.
    var max = Math.floor(available * 0.7);
    var preferred = Math.min(max, 360);
    return { min: min, max: max, preferred: Math.min(preferred, max) };
  }

  function _clampSideWidth(width) {
    var bounds = _sideWidthBounds();
    var candidate = width || bounds.preferred;
    return Math.max(bounds.min, Math.min(bounds.max, candidate));
  }

  function _cleanupSideResize() {
    if (_sideResizeCleanup) {
      _sideResizeCleanup();
      _sideResizeCleanup = null;
    }
  }

  function _installSideResize() {
    _cleanupSideResize();
    if (!_overlay || _placement !== 'side') return;
    var sideOverlay = _overlay;
    var grip = document.createElement('div');
    grip.className = 'fp-side-resizer';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-label', '\u8C03\u6574\u53F3\u4FA7\u9884\u89C8\u5BBD\u5EA6');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.tabIndex = 0;
    grip.title = '调整预览宽度（方向键，Home / End）';
    sideOverlay.insertBefore(grip, sideOverlay.firstChild);

    var startX = 0, startWidth = 0;
    function rememberBlockWidth(width) {
      var active = _activeDockTab();
      if (!active || !active.block) return;
      try { window.localStorage.setItem(BLOCK_WIDTH_KEY, String(Math.round(width))); } catch (_) {}
    }
    function setWidth(width) {
      var next = Math.round(_clampSideWidth(width));
      sideOverlay.style.flexBasis = next + 'px';
      sideOverlay.style.width = next + 'px';
      if (sideOverlay === _dockOverlay && !sideOverlay.classList.contains('fp-side-maximized')) {
        _syncDockOpenWidth(next);
      }
      sideOverlay.style.setProperty('--fp-side-max-width', _sideWidthBounds().max + 'px');
      grip.setAttribute('aria-valuemin', '320');
      grip.setAttribute('aria-valuemax', String(_sideWidthBounds().max));
      grip.setAttribute('aria-valuenow', String(next));
      grip.setAttribute('aria-valuetext', next + ' 像素');
      return next;
    }
    function onMove(e) { setWidth(startWidth + startX - e.clientX); }
    function onKeydown(e) {
      var width = parseFloat(sideOverlay.style.width) || sideOverlay.getBoundingClientRect().width;
      var step = e.shiftKey ? 50 : 20;
      if (e.key === 'ArrowLeft') width += step;
      else if (e.key === 'ArrowRight') width -= step;
      else if (e.key === 'Home') width = 320;
      else if (e.key === 'End') width = _sideWidthBounds().max;
      else return;
      e.preventDefault();
      e.stopPropagation();
      var next = setWidth(width);
      rememberBlockWidth(next);
      _persistDockState(next);
    }
    setWidth(parseFloat(sideOverlay.style.width) || 0);
    _sideSetWidth = setWidth;
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('fp-side-resizing');
      var width = Math.round(sideOverlay.getBoundingClientRect().width);
      rememberBlockWidth(width);
      _persistDockState(width);
    }
    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = sideOverlay.getBoundingClientRect().width;
      document.body.classList.add('fp-side-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    grip.addEventListener('pointerdown', onDown);
    grip.addEventListener('keydown', onKeydown);
    var onGripContext = function (e) {
      if (!window.ContextMenu) return;
      e.preventDefault();
      e.stopPropagation();
      var maximized = sideOverlay.classList.contains('fp-side-maximized');
      window.ContextMenu.open({
        x: e.clientX,
        y: e.clientY,
        label: '右侧栏分栏操作',
        items: [
          { id: 'reset-width', label: '重置宽度 (420px)', action: function () {
            var next = setWidth(420);
            rememberBlockWidth(next);
            _persistDockState(next);
          } },
          { id: 'toggle-max', label: maximized ? '还原右侧栏' : '最大化右侧栏', action: function () {
            _toggleDockMaximize();
          } },
          { separator: true },
          { id: 'hide-dock', label: '隐藏右侧栏', action: function () { _hideDock(); } },
        ],
      });
    };
    grip.addEventListener('contextmenu', onGripContext);

    function onLayoutResize() {
      if (!sideOverlay.isConnected) return;
      if (!_canDockRight()) {
        _hideDock();
        return;
      }
      var current = parseFloat(sideOverlay.style.flexBasis) || sideOverlay.getBoundingClientRect().width;
      setWidth(current);
    }
    window.addEventListener('resize', onLayoutResize);
    var layoutObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      layoutObserver = new ResizeObserver(onLayoutResize);
      var mainLayout = _dockLayout();
      if (mainLayout) layoutObserver.observe(mainLayout);
    }
    _sideResizeCleanup = function () {
      _sideSetWidth = null;
      grip.removeEventListener('pointerdown', onDown);
      grip.removeEventListener('keydown', onKeydown);
      grip.removeEventListener('contextmenu', onGripContext);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('resize', onLayoutResize);
      if (layoutObserver) layoutObserver.disconnect();
      document.body.classList.remove('fp-side-resizing');
      if (grip.parentNode) grip.parentNode.removeChild(grip);
    };
  }

  function _syncPlacementButton() {
    if (!_placementButton) return;
    var side = _placement === 'side';
    _setSvgIcon(_placementButton, side
      ? '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m18 9-3 3 3 3"/>'
      : '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m10 9 3 3-3 3"/>');
    _placementButton.setAttribute('aria-label', side ? '\u9690\u85CF\u53F3\u4FA7\u9884\u89C8' : '\u5728\u53F3\u4FA7\u5206\u680F\u6253\u5F00');
    _placementButton.setAttribute('aria-pressed', side ? 'true' : 'false');
    _placementButton.classList.toggle('is-active', side);
    _placementButton.title = side ? '\u9690\u85CF\u53F3\u4FA7\u9884\u89C8' : '\u5728\u53F3\u4FA7\u5206\u680F\u6253\u5F00';
  }

  function _syncMaximizeButton() {
    if (!_maximizeButton) return;
    _setSvgIcon(_maximizeButton, _maximized
      ? '<path d="M8 3v5H3"/><path d="M16 3v5h5"/><path d="M8 21v-5H3"/><path d="M16 21v-5h5"/>'
      : '<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>');
    _maximizeButton.setAttribute('aria-label', _maximized ? '恢复预览' : '最大化预览');
    _maximizeButton.setAttribute('aria-pressed', _maximized ? 'true' : 'false');
    _maximizeButton.classList.toggle('is-active', _maximized);
    _maximizeButton.title = _maximized ? '\u6062\u590D\u9884\u89C8' : '\u6700\u5927\u5316\u9884\u89C8';
  }

  function _stopAutoRefresh() {
    if (_autoRefreshTimer != null) {
      window.clearTimeout(_autoRefreshTimer);
      _autoRefreshTimer = null;
    }
  }

  function _canAutoRefresh() {
    return !document.hidden
      && !_dockHidden
      && _previewReady
      && !!(_overlay && _overlay.isConnected)
      && !(_overlay.querySelector('[data-fp-hold-refresh]'))
      && !!(_currentFile && _currentFile.absPath);
  }

  function _syncAutoRefresh() {
    _stopAutoRefresh();
    if (!_canAutoRefresh()) return;
    _autoRefreshTimer = window.setTimeout(function () {
      _autoRefreshTimer = null;
      _refreshCurrent(false).finally(_syncAutoRefresh);
    }, AUTO_REFRESH_MS);
  }

  function _setRefreshBusy(button, body, busy) {
    if (button) {
      button.classList.toggle('is-refreshing', busy);
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (body) body.classList.toggle('fp-refreshing', busy);
  }

  function _clearRefreshError(button) {
    if (!button) return;
    button.classList.remove('has-error');
    button.title = '\u5237\u65B0\u9884\u89C8\uFF08\u6BCF 1.5 \u79D2\u81EA\u52A8\u68C0\u67E5\uFF09';
  }

  function _capturePreviewScroll(body) {
    var selectors = [
      '.fp-md-wrap', '.fp-code-wrap', '.fp-code-wrap pre > code',
      '.fp-image-wrap', '.fp-xlsx-wrap', '.fp-dir-wrap', '.fp-dir-list',
    ];
    var state = [{ selector: null, top: body.scrollTop, left: body.scrollLeft }];
    selectors.forEach(function (selector) {
      var el = body.querySelector(selector);
      if (el) state.push({ selector: selector, top: el.scrollTop, left: el.scrollLeft, codeOffset: el.__fpCodeOffset });
    });
    return state;
  }

  function _restorePreviewScroll(body, state) {
    function apply() {
      if (!body || !body.isConnected) return;
      state.forEach(function (item) {
        var el = item.selector ? body.querySelector(item.selector) : body;
        if (!el) return;
        if (item.codeOffset != null && el.__fpRestoreCodeOffset) el.__fpRestoreCodeOffset(item.codeOffset);
        el.scrollTop = item.top;
        el.scrollLeft = item.left;
      });
    }
    apply();
    if (window.requestAnimationFrame) window.requestAnimationFrame(apply);
  }

  function _isPreviewRequestCurrent(requestId, body, expectedFile, expectedPath) {
    return requestId === _previewGeneration
      && !!(body && body.isConnected)
      && (!expectedFile || _currentFile === expectedFile)
      && (!expectedPath || (_currentFile && _currentFile.absPath === expectedPath));
  }

  function _replacePreviewBody(body, renderedBody) {
    _pauseVideos(body);
    _disposePreview(body);
    body.innerHTML = '';
    while (renderedBody.firstChild) body.appendChild(renderedBody.firstChild);
  }

  function _setPreviewTitle(path) {
    if (!_overlay) return;
    var titleEl = _overlay.querySelector('.fp-title');
    if (!titleEl) return;
    var parent = path.replace(/\/[^/]+\/?$/, '') || '/';
    var mobile = _isMobileReader();
    titleEl.textContent = mobile ? (path.split('/').filter(Boolean).pop() || '/')
      : (_placement === 'side' && !(_currentFile && _currentFile.isDirectory) ? parent : path);
    titleEl.setAttribute('data-parent', parent);
    titleEl.setAttribute('aria-label', path);
    titleEl.title = path;
    var back = _overlay.querySelector('.fp-btn-back');
    if (back) {
      var label = mobile && (!_dirContext || (_currentFile && _currentFile.isDirectory))
        ? '返回工作区' : '返回上级目录';
      back.setAttribute('aria-label', label);
      back.title = label;
    }
  }

  function _refreshCurrent(force) {
    if (_refreshPromise) return _refreshPromise;
    if (!_overlay || !_overlay.isConnected || !_currentFile || !_currentFile.absPath) {
      return Promise.resolve(false);
    }

    var fileAtStart = _currentFile;
    var pathAtStart = fileAtStart.absPath;
    var noticeSnapshot = _previewNotices(pathAtStart);
    var requestId = _previewGeneration;
    var body = _overlay.querySelector('.fp-body');
    if (!body) return Promise.resolve(false);
    // An open editor or board owns the body until it saves or closes.
    if (!force && body.querySelector('[data-fp-hold-refresh]')) return Promise.resolve(false);
    var button = _refreshButton;
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var qs = '?path=' + encodeURIComponent(fileAtStart.absPath);
    if (_currentPaneId) qs += '&paneId=' + encodeURIComponent(_currentPaneId);

    _clearRefreshError(button);
    _setRefreshBusy(button, body, true);
    _refreshPromise = fetch(_machine() + '/api/files/info' + qs, {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) {
        if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart)) return null;
        if (r.status === 401) {
          if (!_previewReady) throw new Error('登录已失效，请重新登录后重试');
          close(); return null;
        }
        return r.json();
      })
      .then(function (res) {
        if (!res) return false;
        if (!res.success) throw new Error(res.error || '\u5237\u65B0\u5931\u8D25');
        if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart)) return false;
        var info = res.data;
        var changed = force
          || fileAtStart.isDirectory
          || !!info.isDirectory !== !!fileAtStart.isDirectory
          || Number(info.mtimeMs || 0) !== Number(fileAtStart.mtimeMs || 0)
          || Number(info.size || 0) !== Number(fileAtStart.size || 0);
        if (!changed) {
          fileAtStart.noticeSnapshot = noticeSnapshot;
          _acknowledgeFilePreview();
          return false;
        }
        return Promise.resolve(_renderResolvedPreview(body, info, null, {
          reuseCurrent: true,
          requestId: requestId,
          expectedFile: fileAtStart,
          expectedPath: pathAtStart,
          noticeSnapshot: noticeSnapshot,
        })).then(function () {
          if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart)) return false;
          _saveActiveDockTab();
          _acknowledgeFilePreview();
          return true;
        });
      })
      .catch(function (err) {
        if (_isPreviewRequestCurrent(requestId, body, fileAtStart, pathAtStart) && button) {
          button.classList.add('has-error');
          button.title = '\u5237\u65B0\u5931\u8D25\uFF1A' + (err && err.message ? err.message : err);
        }
        return false;
      })
      .finally(function () {
        _setRefreshBusy(button, body, false);
        _refreshPromise = null;
      });
    return _refreshPromise;
  }

  function _tabTitle(tab) {
    if (tab.block) return tab.block.title;
    var path = tab.path || '';
    return path.split('/').filter(Boolean).pop() || path || 'Preview';
  }

  // What a file is, by name, for its tab's icon. What the server said wins (see _tabKind).
  var TAB_KIND_BY_NAME = [
    [/\.(md|markdown|mdx)$/i, 'markdown'],
    [/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)$/i, 'image'],
    [/\.(mp4|webm|mov|m4v|ogv|mkv)$/i, 'video'],
    [/\.pdf$/i, 'document'],
    [/\.(csv|tsv|xlsx|xls)$/i, 'table'],
    [/\.(sqlite3?|db)$/i, 'database'],
    [/\.ipynb$/i, 'notebook'],
    [/\.(zip|tar|tgz|gz|bz2|xz|7z|rar|jar)$/i, 'archive'],
    [/\.(html?|xhtml)$/i, 'browser'],
    [/\.(diff|patch)$/i, 'changes'],
    [/\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|lua|sql|json|jsonc|ya?ml|toml|ini|xml|css|scss|less|vue|svelte|dart|r|pl|ex|exs)$/i, 'code'],
  ];

  function _tabKind(tab) {
    if (tab.block) return tab.block.kind || 'block';
    if (tab.modeDir) return 'folder';
    var file = tab.currentFile || {};
    if (file.isImage) return 'image';
    if (file.isVideo) return 'video';
    if (file.isPdf) return 'document';
    if (file.isXlsx) return 'table';
    if (file.isArchive) return 'archive';
    var name = tab.path || '';
    for (var i = 0; i < TAB_KIND_BY_NAME.length; i++) {
      if (TAB_KIND_BY_NAME[i][0].test(name)) return TAB_KIND_BY_NAME[i][1];
    }
    return file.isMarkdown ? 'markdown' : 'file';
  }

  function _tabIcon(tab) {
    if (tab.block) return tab.block.icon || '';
    return window.Blocks && window.Blocks.icon ? window.Blocks.icon(_tabKind(tab)) : '';
  }

  // --- tab order ---------------------------------------------------------------

  /** A tab's place in a saved order: files by path, blocks by what they show. */
  function _tabOrderKey(tab) {
    return tab.block ? 'block:' + tab.block.persistKey : 'file:' + tab.path;
  }

  /** Puts tabs back in the order they were saved in; ones it does not know stay after. */
  function _applySavedTabOrder() {
    if (!_savedTabOrder || _dockTabs.length < 2) return;
    var rank = {};
    _savedTabOrder.forEach(function (key, i) { rank[key] = i; });
    var place = function (tab, i) {
      var r = rank[_tabOrderKey(tab)];
      return r == null ? _savedTabOrder.length + i : r;
    };
    var placed = _dockTabs.map(function (tab, i) { return { tab: tab, at: place(tab, i) }; });
    placed.sort(function (a, b) { return a.at - b.at; });
    _dockTabs = placed.map(function (entry) { return entry.tab; });
  }

  /** Moves a tab before or after another, or by a step; saves the order. */
  function _moveDockTab(tabId, targetId, after) {
    var from = -1;
    for (var i = 0; i < _dockTabs.length; i++) if (_dockTabs[i].id === tabId) from = i;
    if (from < 0 || tabId === targetId) return false;
    var moved = _dockTabs.splice(from, 1)[0];
    var to = -1;
    for (var j = 0; j < _dockTabs.length; j++) if (_dockTabs[j].id === targetId) to = j;
    if (to < 0) {
      _dockTabs.splice(from, 0, moved);
      return false;
    }
    _dockTabs.splice(after ? to + 1 : to, 0, moved);
    _renderDockTabs();
    _persistDockState();
    _syncWindowOp({ type: 'reorder', order: _dockTabs.map(_tabOrderKey).slice(0, MAX_PERSISTED_TAB_ORDER) });
    // Blocks keep their own order too, for when they come back without a file tab.
    if (_blockOrderListener) {
      _blockOrderListener(_dockTabs.filter(function (tab) { return tab.block; }).map(function (tab) { return tab.block.key; }));
    }
    return true;
  }

  function _clearDropMarks(bar) {
    bar.querySelectorAll('.fp-drop-before, .fp-drop-after, .fp-dragging').forEach(function (node) {
      node.classList.remove('fp-drop-before', 'fp-drop-after', 'fp-dragging');
    });
  }

  /**
   * Drag a tab onto another to put it before or after it. The data type is the
   * panel's own, so a tab dropped on the terminal is not pasted into it as text.
   */
  function _bindTabDrag(item, tab, bar) {
    item.draggable = true;
    var side = function (e) {
      var rect = item.getBoundingClientRect();
      return e.clientX > rect.left + rect.width / 2;
    };
    item.addEventListener('dragstart', function (e) {
      _draggedTabId = tab.id;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id));
      }
      item.classList.add('fp-dragging');
    });
    item.addEventListener('dragend', function () {
      _draggedTabId = null;
      _clearDropMarks(bar);
    });
    item.addEventListener('dragover', function (e) {
      if (_draggedTabId == null || _draggedTabId === tab.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var after = side(e);
      item.classList.toggle('fp-drop-after', after);
      item.classList.toggle('fp-drop-before', !after);
    });
    item.addEventListener('dragleave', function () {
      item.classList.remove('fp-drop-before', 'fp-drop-after');
    });
    item.addEventListener('drop', function (e) {
      if (_draggedTabId == null) return;
      e.preventDefault();
      var dragged = _draggedTabId;
      _draggedTabId = null;
      _clearDropMarks(bar);
      _moveDockTab(dragged, tab.id, side(e));
    });
  }

  function _activeDockTab() {
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].id === _activeDockTabId) return _dockTabs[i];
    }
    return null;
  }

  function _fileTabs() {
    return _dockTabs.filter(function (tab) { return !tab.block; });
  }

  function _saveActiveDockTab() {
    if (_placement !== 'side') return;
    var tab = _activeDockTab();
    if (!tab || tab.block) return;
    tab.currentFile = _currentFile;
    tab.paneId = _currentPaneId;
    tab.source = _currentSource;
    tab.dirContext = _dirContext;
    tab.placementButton = _placementButton;
    tab.maximizeButton = _maximizeButton;
    tab.refreshButton = _refreshButton;
    tab.previewReady = _previewReady;
    tab.maximized = _maximized;
    tab.modeDir = _dockOverlay && _dockOverlay.classList.contains('fp-mode-dir');
    tab.hasBack = _dockOverlay && _dockOverlay.classList.contains('fp-has-back');
    tab.scrollState = _capturePreviewScroll(tab.modal.querySelector('.fp-body'));
    if (_currentFile && _currentFile.absPath) tab.path = _currentFile.absPath;
    _persistDockState();
  }

  function _renderDockTabs() {
    if (!_dockOverlay) return;
    var bar = _dockOverlay.querySelector('.fp-dock-tabs');
    if (!bar) return;
    var focusedTab = document.activeElement && document.activeElement.closest('.fp-dock-tab-item');
    var focusWasClose = focusedTab && document.activeElement.classList.contains('fp-dock-tab-close');
    var focusedId = focusedTab && focusedTab.getAttribute('data-tab-id');
    bar.innerHTML = '';
    _dockTabs.forEach(function (tab) {
      var item = document.createElement('div');
      item.className = 'fp-dock-tab-item' + (tab.id === _activeDockTabId ? ' active' : '')
        + (tab.unread && tab.id !== _activeDockTabId ? ' is-unread' : '')
        + (tab.highlightUntil > Date.now() ? ' is-new' : '');
      item.setAttribute('data-tab-id', tab.id);
      var select = document.createElement('button');
      select.className = 'fp-dock-tab';
      select.setAttribute('role', 'tab');
      select.id = 'fp-tab-' + tab.id;
      select.tabIndex = tab.id === _activeDockTabId ? 0 : -1;
      select.setAttribute('aria-controls', 'fp-panel-' + tab.id);
      select.setAttribute('aria-selected', tab.id === _activeDockTabId ? 'true' : 'false');
      select.title = tab.path || _tabTitle(tab);
      item.setAttribute('data-kind', _tabKind(tab));
      select.innerHTML = _tabIcon(tab);
      var label = document.createElement('span');
      label.className = 'fp-dock-tab-label';
      label.textContent = _tabTitle(tab);
      select.appendChild(label);
      if (tab.unread || tab.highlightUntil > Date.now()) {
        var badge = document.createElement('span');
        badge.className = 'fp-dock-tab-new';
        badge.textContent = '新';
        select.appendChild(badge);
        select.setAttribute('aria-label', _tabTitle(tab) + '，新打开的文档');
      }
      if (tab.block) {
        item.classList.add('is-block');
        item.classList.toggle('is-busy', !!tab.block.busy);
        if (tab.block.tooltip) select.title = tab.block.tooltip;
        else if (tab.block.subtitle) select.title = tab.block.title + ' · ' + tab.block.subtitle;
        select.addEventListener('dblclick', function () { if (tab.block.onDoubleClick) tab.block.onDoubleClick(); });
        select.addEventListener('auxclick', function (e) { if (e.button === 1) _closeDockTab(tab.id); });
      }
      _bindTabDrag(item, tab, bar);
      item.addEventListener('contextmenu', function (e) {
        if (!window.ContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        _openDockTabContextMenu(tab, e.clientX, e.clientY);
      });
      select.addEventListener('click', function () { _activateDockTab(tab.id); });
      select.addEventListener('keydown', function (e) {
        var index = _dockTabs.indexOf(tab), next;
        // Alt+Shift+←/→ moves the tab, as dragging it would.
        if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          e.stopPropagation();
          var neighbour = _dockTabs[index + (e.key === 'ArrowRight' ? 1 : -1)];
          if (neighbour && _moveDockTab(tab.id, neighbour.id, e.key === 'ArrowRight')) {
            document.getElementById('fp-tab-' + tab.id).focus();
          }
          return;
        }
        if (e.key === 'ArrowRight') next = (index + 1) % _dockTabs.length;
        else if (e.key === 'ArrowLeft') next = (index + _dockTabs.length - 1) % _dockTabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = _dockTabs.length - 1;
        else if (e.key === 'Delete') {
          e.preventDefault();
          _closeDockTab(tab.id);
          var active = document.getElementById('fp-tab-' + _activeDockTabId);
          if (active) active.focus();
          return;
        } else return;
        e.preventDefault();
        _activateDockTab(_dockTabs[next].id);
        document.getElementById('fp-tab-' + _activeDockTabId).focus();
      });
      var closeTab = document.createElement('button');
      closeTab.className = 'fp-dock-tab-close';
      closeTab.setAttribute('aria-label', '\u5173\u95ED ' + _tabTitle(tab));
      closeTab.textContent = '\u00D7';
      closeTab.addEventListener('click', function (e) {
        e.stopPropagation();
        _closeDockTab(tab.id);
      });
      item.appendChild(select);
      item.appendChild(closeTab);
      bar.appendChild(item);
    });
    if (focusedId) {
      var replacement = bar.querySelector('[data-tab-id="' + focusedId + '"] ' + (focusWasClose ? '.fp-dock-tab-close' : '.fp-dock-tab'));
      if (replacement) replacement.focus();
    }
  }

  function _ensureDockOverlay() {
    if (_dockOverlay) return;
    _dockReturnFocus = _modalReturnFocus;
    _dockOverlay = document.createElement('div');
    _dockOverlay.className = 'fp-overlay fp-side fp-dock';
    _dockOverlay.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Esc while typing in a block (a commit message, a URL) is not "hide".
      var activeTab = _activeDockTab();
      if (activeTab && activeTab.block && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      _hideDock();
      if (_dockRestoreButton) _dockRestoreButton.focus();
    });
    var tabs = document.createElement('div');
    tabs.className = 'fp-dock-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '\u6587\u4EF6\u9884\u89C8\u6807\u7B7E');
    if (window.ContextMenu && window.ContextMenu.installLongPress) {
      window.ContextMenu.installLongPress(tabs, '.fp-dock-tab-item', function (el, coords) {
        var id = Number(el.getAttribute('data-tab-id'));
        var match = _dockTabs.find(function (t) { return t.id === id; });
        if (match) _openDockTabContextMenu(match, coords.clientX, coords.clientY);
      });
    }
    var panels = document.createElement('div');
    panels.className = 'fp-dock-panels';
    _dockOverlay.appendChild(tabs);
    _dockOverlay.appendChild(panels);
  }

  function _removeDockRestoreButton() {
    if (_dockRestoreButton) _dockRestoreButton.remove();
    _dockRestoreButton = null;
  }

  function _showDock(preserveRequest) {
    if (!_dockOverlay || _dockTabs.length === 0 || !_canDockRight()) return;
    _dockHidden = false;
    _removeDockRestoreButton();
    var layout = _dockLayout();
    if (layout && !_restoringHidden) layout.appendChild(_dockOverlay);
    var savedWidth = 0;
    var persisted = _loadDockState();
    if (persisted) savedWidth = persisted.width;
    // A dock holding only blocks has no saved state yet: keep its current width.
    if (!savedWidth) savedWidth = parseFloat(_dockOverlay.style.width) || 0;
    // Nothing to go on, and git needs more room than a document.
    if (!savedWidth && _fileTabs().length === 0) {
      try { savedWidth = Number(window.localStorage.getItem(BLOCK_WIDTH_KEY)) || 0; } catch (_) {}
      savedWidth = savedWidth || BLOCK_SIDE_WIDTH;
    }
    var dockWidth = _clampSideWidth(savedWidth);
    _dockOverlay.style.flexBasis = dockWidth + 'px';
    _dockOverlay.style.width = dockWidth + 'px';
    _dockOverlay.classList.toggle('fp-restoring', _restoringDock);
    if (!_restoringHidden) {
      document.body.classList.add('fp-side-open');
      if (!_dockOverlay.classList.contains('fp-side-maximized')) _syncDockOpenWidth(dockWidth);
    }
    _activateDockTab(_activeDockTabId || _dockTabs[0].id, preserveRequest);
    _installSideResize();
    _persistDockState(dockWidth);
  }

  /** The dock's place in the layout, empty and invisible until _showDock fills it. */
  function _reserveDockSpace(savedWidth) {
    var layout = _dockLayout();
    if (!layout) return;
    _ensureDockOverlay();
    var dockWidth = _clampSideWidth(savedWidth);
    _dockOverlay.style.flexBasis = dockWidth + 'px';
    _dockOverlay.style.width = dockWidth + 'px';
    _dockOverlay.classList.add('fp-restoring');
    layout.appendChild(_dockOverlay);
    document.body.classList.add('fp-side-open');
    _syncDockOpenWidth(dockWidth);
  }

  function _hideDock(persistHidden) {
    if (!_dockOverlay) return;
    var modalOpen = _overlay && _overlay !== _dockOverlay && _placement !== 'side';
    if (!modalOpen && _shareDialogClose) _shareDialogClose(false);
    _pauseVideos(_dockOverlay);
    if (!modalOpen) {
      if (document.__fpActiveMermaidDialogClose) document.__fpActiveMermaidDialogClose();
      _previewGeneration++;
      _stopAutoRefresh();
      _saveActiveDockTab();
    }
    _dockHidden = true;
    _cleanupSideResize();
    _dockOverlay.remove();
    document.body.classList.remove('fp-side-open');
    _syncDockOpenWidth(0);
    if (!modalOpen) {
      _placement = 'modal';
      _overlay = null;
      _currentFile = null;
      _currentPaneId = null;
      _dirContext = null;
    }
    if (!_dockRestoreButton) {
      _dockRestoreButton = document.createElement('button');
      _dockRestoreButton.className = 'fp-dock-restore';
      _dockRestoreButton.setAttribute('aria-label', '\u5C55\u5F00\u53F3\u4FA7\u6587\u4EF6\u9884\u89C8');
      _dockRestoreButton.addEventListener('click', function () {
        _showDock();
        var active = document.getElementById('fp-tab-' + _activeDockTabId);
        if (active) active.focus();
      });
      var layout = _dockLayout();
      if (layout) layout.appendChild(_dockRestoreButton);
    }
    if (_fileTabs().length < _dockTabs.length) _dockRestoreButton.setAttribute('aria-label', '\u5C55\u5F00\u53F3\u4FA7\u8FB9\u680F');
    _syncRestoreButton();
    if (persistHidden !== false) _persistDockState();
  }

  function _activateDockTab(tabId, preserveRequest) {
    if (!_dockOverlay) return;
    if (document.__fpActiveMermaidDialogClose) document.__fpActiveMermaidDialogClose();
    if (_placement === 'side') _saveActiveDockTab();
    var tab = null;
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].id === tabId) { tab = _dockTabs[i]; break; }
    }
    if (!tab) return;
    if (!preserveRequest) _previewGeneration++;
    _activeDockTabId = tab.id;
    if (tab.unread && tab.automatic) _highlightDocumentTab(tab);
    if (document.visibilityState !== 'hidden') tab.unread = false;
    var panels = _dockOverlay.querySelector('.fp-dock-panels');
    if (panels) {
      _pauseVideos(panels);
      // A file preview leaves the DOM; a block stays attached but hidden, so a
      // browser tab keeps its page and a half-written commit message survives.
      Array.prototype.slice.call(panels.children).forEach(function (child) {
        if (child.hasAttribute('data-dock-block')) child.hidden = true;
        else child.remove();
      });
      if (tab.modal.parentNode !== panels) panels.appendChild(tab.modal);
      tab.modal.hidden = false;
      if (tab.scrollState) _restorePreviewScroll(tab.modal.querySelector('.fp-body'), tab.scrollState);
    }
    _overlay = _dockOverlay;
    _placement = 'side';
    _currentFile = tab.block ? null : tab.currentFile;
    _currentPaneId = tab.block ? null : tab.paneId;
    _currentSource = tab.block ? null : tab.source || null;
    _dirContext = tab.block ? null : tab.dirContext;
    _placementButton = tab.block ? null : tab.placementButton;
    _maximizeButton = tab.block ? null : tab.maximizeButton;
    _refreshButton = tab.block ? null : tab.refreshButton;
    _previewReady = !tab.block && tab.previewReady !== false;
    _maximized = !tab.block && !!tab.maximized;
    _dockOverlay.classList.toggle('fp-mode-dir', !!tab.modeDir);
    _dockOverlay.classList.toggle('fp-has-back', !!tab.hasBack);
    _dockOverlay.classList.toggle('fp-side-maximized', _maximized);
    if (document.body.classList.contains('fp-side-open')) {
      _syncDockOpenWidth(_maximized ? 0 : (parseFloat(_dockOverlay.style.width) || 0));
    }
    _syncPlacementButton();
    _syncMaximizeButton();
    if (!tab.block) _setPreviewTitle(tab.path);
    _renderDockTabs();
    _syncAutoRefresh();
    _persistDockState();
    if (!tab.block && !_restoringDock && !_quietOpen && !_dockHidden) {
      _syncWindowOp({ type: 'activate', key: 'file:' + tab.path });
    }
    if (_blockListener) _blockListener(tab.block ? tab.block.key : null);
    _acknowledgeFilePreview();
    if (tab.deferred && !_dockHidden && !_restoringDock && !_restoringHidden) {
      _hydrateDeferredTab(tab);
    }
  }

  function _previewNotices(path) {
    return window.NotificationPanel && window.NotificationPanel.previewSnapshot
      ? window.NotificationPanel.previewSnapshot({ type: 'document', path: path, contextKey: _dockContextKey }) : null;
  }

  function _acknowledgeFilePreview() {
    var tab = _activeDockTab();
    if (!tab || tab.block || !_previewReady || _placement !== 'side' || _dockHidden
      || _restoringDock || _restoringHidden || _restorePromise || !_dockOverlay || !_dockOverlay.isConnected) return;
    if (window.NotificationPanel && window.NotificationPanel.previewViewed) {
      window.NotificationPanel.previewViewed({ type: 'document', path: tab.path, contextKey: _dockContextKey,
        snapshot: tab.currentFile && tab.currentFile.noticeSnapshot });
    }
  }

  function _toggleDockMaximize() {
    if (!_dockOverlay) return;
    _maximized = !_maximized;
    _dockOverlay.classList.toggle('fp-side-maximized', _maximized && _placement === 'side');
    var active = _activeDockTab();
    if (active && active.modal) active.modal.classList.toggle('fp-maximized', _maximized);
    if (document.body.classList.contains('fp-side-open')) {
      _syncDockOpenWidth((_maximized && _placement === 'side') ? 0 : (parseFloat(_dockOverlay.style.width) || 0));
    }
    _syncMaximizeButton();
  }

  function _closeOtherDockTabs(keepTabId) {
    var ids = _dockTabs.filter(function (t) { return t.id !== keepTabId; }).map(function (t) { return t.id; });
    ids.forEach(function (id) { _closeDockTab(id); });
  }

  function _closeRightDockTabs(tabId) {
    var idx = _dockTabs.findIndex(function (t) { return t.id === tabId; });
    if (idx < 0) return;
    var ids = _dockTabs.slice(idx + 1).map(function (t) { return t.id; });
    ids.forEach(function (id) { _closeDockTab(id); });
  }

  function _openDockTabContextMenu(tab, x, y) {
    if (!window.ContextMenu) return;
    var idx = _dockTabs.indexOf(tab);
    var hasOthers = _dockTabs.length > 1;
    var hasRight = idx >= 0 && idx < _dockTabs.length - 1;
    var maximized = _dockOverlay && _dockOverlay.classList.contains('fp-side-maximized');
    var items = [];
    if (!tab.block) {
      items.push({ id: 'refresh', label: '刷新预览', action: function () {
        if (_activeDockTabId !== tab.id) _activateDockTab(tab.id);
        return _refreshCurrent(true).finally(_syncAutoRefresh);
      } });
    }
    items.push({ id: 'toggle-max', label: maximized ? '还原右侧栏' : '最大化右侧栏', action: _toggleDockMaximize });
    if (tab.path) {
      items.push({ id: 'copy-path', label: '复制路径', action: function () {
        _copyText(tab.path);
        _toast('路径已复制');
      } });
    }
    items.push(
      { separator: true },
      { id: 'close-tab', label: '关闭标签', action: function () { _closeDockTab(tab.id); } },
      { id: 'close-others', label: '关闭其他标签', disabled: !hasOthers, action: function () { _closeOtherDockTabs(tab.id); } },
      { id: 'close-right', label: '关闭右侧标签', disabled: !hasRight, action: function () { _closeRightDockTabs(tab.id); } },
      { separator: true },
      { id: 'hide-dock', label: '隐藏右侧栏', action: function () { _hideDock(); } }
    );
    window.ContextMenu.open({
      x: x,
      y: y,
      label: '右侧栏标签操作',
      items: items,
    });
  }

  function _closeDockTab(tabId) {
    var index = -1;
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].id === tabId) { index = i; break; }
    }
    if (index < 0) return;
    // BlockHost closes the block, and its next sync removes the tab.
    if (_dockTabs[index].block) {
      _dockTabs[index].block.onClose();
      return;
    }
    _removeDockTab(index);
  }

  function _removeDockTab(index) {
    var removed = _dockTabs[index];
    var tabId = removed.id;
    var focused = document.activeElement;
    var item = focused && focused.closest('.fp-dock-tab-item');
    var hadFocus = removed.modal.contains(focused) || (item && item.getAttribute('data-tab-id') === String(tabId));
    var wasActive = _activeDockTabId === tabId;
    var modalOpen = _overlay && _overlay !== _dockOverlay;
    _pauseVideos(removed.modal);
    if (removed.block) {
      _releaseBlockFrame(removed.modal);
    } else {
      _disposePreview(removed.modal);
    }
    removed.modal.remove();
    _dockTabs.splice(index, 1);
    if (!removed.block) {
      _syncWindowOp({ type: 'remove-file', path: removed.path });
    }
    if (_dockTabs.length === 0) {
      var opener = _dockReturnFocus;
      _destroyDock(false, modalOpen);
      if (hadFocus && opener && opener.isConnected) opener.focus();
      return;
    }
    if (wasActive) {
      var next = _dockTabs[Math.min(index, _dockTabs.length - 1)];
      _activeDockTabId = next.id;
      if (!_dockHidden && !modalOpen) {
        // The old active tab has already been removed; do not save its globals
        // into the replacement tab when activating the neighbour.
        _placement = 'modal';
        _activateDockTab(next.id);
      }
    }
    _renderDockTabs();
    _syncRestoreButton();
    if (hadFocus) {
      var active = document.getElementById('fp-tab-' + _activeDockTabId);
      if (active) active.focus();
    }
    _persistDockState();
  }

  function _destroyDock(preservePersisted, preserveModal) {
    var separateOverlay = _overlay && _overlay !== _dockOverlay ? _overlay : null;
    var keepModal = preserveModal && separateOverlay;
    if (!keepModal) {
      if (_shareDialogClose) _shareDialogClose(false);
      _previewGeneration++;
      _previewReady = false;
      _closeActionMenu();
      _stopAutoRefresh();
    }
    _cleanupSideResize();
    if (!keepModal) _pauseVideos(separateOverlay);
    _dockTabs.forEach(function (tab) { _pauseVideos(tab.modal); });
    if (!keepModal) {
      _disposePreview(separateOverlay);
      if (separateOverlay) separateOverlay.remove();
    }
    _dockTabs.forEach(function (tab) { _disposePreview(tab.modal); });
    _disposePreview(_dockOverlay);
    if (_dockOverlay) _dockOverlay.remove();
    _removeDockRestoreButton();
    _dockOverlay = null;
    _dockReturnFocus = null;
    _dockTabs = [];
    _activeDockTabId = null;
    _dockHidden = false;
    if (!preservePersisted) _clearPersistedDock();
    document.body.classList.remove('fp-side-open');
    _syncDockOpenWidth(0);
    if (keepModal) return;
    _overlay = null;
    _placement = 'modal';
    _currentFile = null;
    _currentPaneId = null;
    _dirContext = null;
    _currentOpenPath = null;
    _placementButton = null;
    _maximizeButton = null;
    _refreshButton = null;
    _maximized = false;
  }

  function _dockCurrentPreview() {
    if (!_overlay || _placement === 'side' || !_canDockRight()) return false;
    var modalOverlay = _overlay;
    var modal = modalOverlay.querySelector('.fp-modal');
    if (!modal) return false;
    var path = (_currentFile && _currentFile.absPath) || _currentOpenPath || '';
    for (var i = 0; i < _dockTabs.length; i++) {
      if (path && _dockTabs[i].path === path) {
        _pauseVideos(modalOverlay);
        _disposePreview(modalOverlay);
        modalOverlay.remove();
        _activeDockTabId = _dockTabs[i].id;
        _showDock();
        _persistDockState();
        return true;
      }
    }
    _ensureDockOverlay();
    var tab = _tabFromModal(modalOverlay, modal, path);
    _dockTabs.push(tab);
    _activeDockTabId = tab.id;
    _showDock(true);
    _persistDockState();
    if (!_restoringDock && !_quietOpen) {
      _syncWindowOp({
        type: 'upsert-file',
        path: path,
        paneId: tab.paneId || null,
        unread: false,
        automatic: false,
        activate: true,
      });
    }
    return true;
  }

  /** Takes the modal preview out of the page and makes it a tab (not yet in the strip). */
  function _tabFromModal(modalOverlay, modal, path) {
    modal.remove();
    modalOverlay.remove();
    var tab = {
      id: _nextDockTabId++, path: path, modal: modal,
      currentFile: _currentFile, paneId: _currentPaneId, source: _currentSource, dirContext: _dirContext,
      placementButton: _placementButton, maximizeButton: _maximizeButton,
      refreshButton: _refreshButton,
      previewReady: _previewReady,
      maximized: false,
      modeDir: modalOverlay.classList.contains('fp-mode-dir'),
      hasBack: modalOverlay.classList.contains('fp-has-back'),
    };
    modal.classList.remove('fp-maximized');
    modal.id = 'fp-panel-' + tab.id;
    modal.setAttribute('role', 'tabpanel');
    modal.setAttribute('aria-labelledby', 'fp-tab-' + tab.id);
    modal.removeAttribute('aria-modal');
    return tab;
  }

  // --- Opening straight into the dock (`anymux open --dock`, agent documents) ---

  function _highlightDocumentTab(tab) {
    tab.highlightUntil = Date.now() + 7000;
    window.setTimeout(function () {
      if (_dockTabs.indexOf(tab) >= 0) _renderDockTabs();
    }, 7100);
  }

  function _mergeDocumentArrivals(saved, arrivals) {
    arrivals.forEach(function (arrival) {
      var old = saved.tabs.findIndex(function (tab) { return tab.path === (arrival.replaces || arrival.path); });
      var existing = saved.tabs.findIndex(function (tab) { return tab.path === arrival.path; });
      var tab = { path: arrival.path, paneId: arrival.paneId, source: arrival.source,
        unread: true, automatic: true, fragment: arrival.fragment || null };
      if (!arrival.paneId && existing >= 0 && saved.tabs[existing].paneId) {
        tab.paneId = saved.tabs[existing].paneId;
        tab.source = saved.tabs[existing].source || { serverId: arrival.source.serverId, paneId: tab.paneId };
      }
      if (existing >= 0) saved.tabs[existing] = tab;
      else if (old >= 0) saved.tabs.splice(old, 1, tab);
      else saved.tabs.push(tab);
      if (old >= 0 && existing >= 0 && old !== existing) saved.tabs.splice(old, 1);
      if (arrival.replaces && saved.order) saved.order = saved.order.map(function (key) {
        return key === 'file:' + arrival.replaces ? 'file:' + arrival.path : key;
      });
      if (arrival.activate !== false) {
        saved.activePath = arrival.path;
        if (arrival.reveal !== false) saved.hidden = false;
        delete saved.activeBlock;
      }
    });
    saved.tabs = saved.tabs.slice(-MAX_PERSISTED_DOCK_TABS);
  }

  /** Add to the owning window without navigating or touching the live preview. */
  function queueDocked(filePath, paneId, opts) {
    opts = opts || {};
    var context = _makeDockContextKey(opts.serverId, opts.windowId, opts.instanceId);
    var key = _dockStateStorageKey(context);
    if (!context || (!key && context !== _dockContextKey)
      || typeof filePath !== 'string' || filePath.charAt(0) !== '/') return Promise.resolve('unavailable');
    if (context === _dockContextKey) _persistDockState();
    var saved = _loadDockState(context) || { version: DOCK_STATE_VERSION, tabs: [], width: 0, hidden: false };
    if (opts.activate === false && saved.tabs.length === 0
      && !(context === _dockContextKey && _dockTabs.length)) return Promise.resolve('skipped');
    var arrival = { path: filePath, paneId: paneId, activate: opts.activate,
      replaces: opts.replaces, fragment: opts.fragment,
      reveal: context !== _dockContextKey || !_dockHidden,
      source: { serverId: opts.serverId, paneId: paneId } };
    var pending = _queuedDockDocuments[context] || [];
    _queuedDockDocuments[context] = pending.filter(function (item) { return item.path !== filePath; }).concat(arrival);
    _mergeDocumentArrivals(saved, [arrival]);
    saved.version = DOCK_STATE_VERSION;
    try { if (key) window.localStorage.setItem(key, JSON.stringify(saved)); } catch (_) { /* kept in memory */ }
    if (!opts.skipServerSync && !(_applyingRemote || (window.DockSync && window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote()))) {
      _syncWindowOp({
        type: 'upsert-file',
        path: filePath,
        paneId: paneId || null,
        replaces: opts.replaces || null,
        fragment: opts.fragment || null,
        automatic: true,
        unread: true,
        activate: opts.activate !== false,
        keepUnread: true,
      }, context);
    }
    return _drainDocumentArrivals().then(function (result) { return result || 'queued'; });
  }

  function _drainDocumentArrivals() {
    var context = _dockContextKey;
    if (_drainingDocuments || _restorePromise || document.hidden || !_canDockRight()
      || (_overlay && _placement !== 'side')) return Promise.resolve();
    var pending = (_queuedDockDocuments[context] || []).slice();
    if (!pending.length) return Promise.resolve();
    _drainingDocuments = true;
    var chain = Promise.resolve();
    var outcome;
    pending.forEach(function (arrival) {
      chain = chain.then(function () {
        if (context !== _dockContextKey) return;
        return openDocked(arrival.path, arrival.paneId, {
          activate: arrival.activate, replaces: arrival.replaces, fragment: arrival.fragment,
          source: arrival.source, automatic: true,
        }).then(function (result) {
          if (['activated', 'added', 'hidden', 'exists'].indexOf(result) < 0) return;
          outcome = result;
          _queuedDockDocuments[context] = (_queuedDockDocuments[context] || []).filter(function (item) { return item !== arrival; });
          if (context === _dockContextKey) _persistDockState();
        });
      });
    });
    return chain.then(function () { return outcome; }).finally(function () {
      _drainingDocuments = false;
      // Only retry arrivals received while loading. A failed read waits for
      // another visit, rather than turning into an immediate retry loop.
      if ((_queuedDockDocuments[_dockContextKey] || []).some(function (item) { return context !== _dockContextKey || pending.indexOf(item) < 0; })) {
        return _drainDocumentArrivals();
      }
    });
  }

  function _findFileTab(path) {
    if (!path) return null;
    for (var i = 0; i < _dockTabs.length; i++) {
      if (!_dockTabs[i].block && _dockTabs[i].path === path) return _dockTabs[i];
    }
    return null;
  }

  function _syncRestoreButton() {
    if (!_dockRestoreButton) return;
    var unread = _dockTabs.some(function (tab) { return tab.unread; });
    var unreadBlock = _dockTabs.some(function (tab) { return tab.block && tab.unread; });
    _dockRestoreButton.textContent = '预览 ' + _dockTabs.length + (unread ? (unreadBlock ? ' · 新内容' : ' · 新文档') : '');
    _dockRestoreButton.classList.toggle('has-unread', unread);
    _dockRestoreButton.title = unread ? (unreadBlock ? '有新内容' : '有新文档') : '';
  }

  /**
   * The collapsed dock takes the quiet preview as a tab without showing itself:
   * showing would resize the terminal, and the person chose to collapse it.
   */
  function _stashInHiddenDock(modalOverlay, modal, path) {
    var tab = _tabFromModal(modalOverlay, modal, path);
    tab.unread = true;
    _dockTabs.push(tab);
    // As _hideDock leaves things: nothing is live while the dock is collapsed.
    _previewGeneration++;
    _stopAutoRefresh();
    _placement = 'modal';
    _overlay = null;
    _currentFile = null;
    _currentPaneId = null;
    _currentSource = null;
    _dirContext = null;
    _currentOpenPath = null;
    _placementButton = null;
    _maximizeButton = null;
    _refreshButton = null;
    _maximized = false;
    _syncRestoreButton();
    _persistDockState();
    return tab;
  }

  /** Puts `tab` where `replaced` was and closes `replaced`, keeping which one is in front. */
  function _replaceTab(tab, replaced) {
    if (!replaced || replaced === tab) return;
    var wasActive = _activeDockTabId === replaced.id;
    _dockTabs.splice(_dockTabs.indexOf(tab), 1);
    _dockTabs.splice(_dockTabs.indexOf(replaced), 0, tab);
    if (wasActive) {
      tab.unread = false;
      if (_dockHidden) _activeDockTabId = tab.id;
      else _activateDockTab(tab.id);
    }
    _removeDockTab(_dockTabs.indexOf(replaced));
  }

  function _scrollToFragment(tab, fragment) {
    if (!fragment || !tab || !tab.modal) return;
    var run = function () {
      _scrollMarkdownHeading(tab.modal.querySelector('.fp-md-wrap'), fragment);
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  function _restoreFocus(element) {
    if (element && element !== document.activeElement && element.isConnected && typeof element.focus === 'function') {
      try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
    }
  }

  /**
   * Opens a file straight into the dock, for `anymux open --dock` and for
   * documents agents write. No modal appears and the keyboard stays where it
   * is: the person may be typing to the agent. `opts`: { activate (default
   * true; false adds the tab behind the current one), replaces (the path of a
   * tab this one takes over), fragment (a Markdown heading), source }.
   *
   * Resolves to what happened: 'activated', 'added' (behind the current tab),
   * 'exists' (already a tab, left as it was), 'hidden' (added to a collapsed
   * dock, which stays collapsed), 'skipped' (a background document with no dock
   * to join), 'busy' (a modal is open) or 'unavailable' (no room for a dock).
   */
  function openDocked(filePath, paneId, opts) {
    opts = opts || {};
    if (_restorePromise) {
      return _restorePromise.then(function () { return openDocked(filePath, paneId, opts); });
    }
    if (typeof filePath !== 'string' || filePath.charAt(0) !== '/' || !_canDockRight()) return Promise.resolve('unavailable');
    if (_overlay && _placement !== 'side') return Promise.resolve('busy');
    var activate = opts.activate !== false;
    var replaced = opts.replaces ? _findFileTab(opts.replaces) : null;
    var existing = _findFileTab(filePath);
    if (existing) {
      var source = opts.source || _sourceForPane(paneId);
      var sourcePaneId = source.paneId || paneId;
      var dirty = false;
      if (sourcePaneId) {
        existing.paneId = sourcePaneId;
        existing.source = { serverId: source.serverId, paneId: sourcePaneId };
        if (existing.id === _activeDockTabId) {
          _currentPaneId = sourcePaneId;
          _currentSource = existing.source;
        }
        _decorate(existing.modal.querySelector('.fp-body'), existing.currentFile, existing.source);
        dirty = true;
      }
      if (opts.fragment && existing.fragment !== opts.fragment) {
        existing.fragment = opts.fragment;
        dirty = true;
      }
      if (replaced && replaced !== existing) _removeDockTab(_dockTabs.indexOf(replaced));
      if (!activate) {
        if (dirty) _persistDockState();
        if (!opts.skipServerSync && dirty) {
          _syncWindowOp({
            type: 'upsert-file',
            path: filePath,
            paneId: existing.paneId || null,
            replaces: opts.replaces || null,
            fragment: existing.fragment || null,
            automatic: opts.automatic === true,
            unread: !!existing.unread,
            activate: false,
            keepUnread: true,
          });
        }
        return Promise.resolve('exists');
      }
      if (_dockHidden) {
        existing.unread = true;
        _syncRestoreButton();
        _persistDockState();
        if (!opts.skipServerSync) {
          _syncWindowOp({
            type: 'upsert-file',
            path: filePath,
            paneId: existing.paneId || null,
            replaces: opts.replaces || null,
            fragment: existing.fragment || null,
            automatic: opts.automatic === true,
            unread: true,
            activate: true,
            keepUnread: true,
          });
        }
        return Promise.resolve('hidden');
      }
      if (dirty) _persistDockState();
      _activateDockTab(existing.id);
      if (opts.automatic) { existing.automatic = true; _highlightDocumentTab(existing); _renderDockTabs(); }
      _scrollToFragment(existing, opts.fragment);
      if (!opts.skipServerSync) {
        _syncWindowOp({
          type: 'upsert-file',
          path: filePath,
          paneId: existing.paneId || null,
          replaces: opts.replaces || null,
          fragment: existing.fragment || null,
          automatic: opts.automatic === true,
          unread: false,
          activate: true,
        });
      }
      return Promise.resolve('activated');
    }
    // A log that changes all the time is not worth making room for.
    if (!activate && !_dockTabs.length) return Promise.resolve('skipped');

    var contextKey = _dockContextKey;
    var generation = _dockContextGeneration;
    var focus = document.activeElement;
    var previous = _activeDockTabId;
    var quietOverlay;
    var opened;
    _quietOpen = true;
    try {
      opened = openFile(filePath, paneId, { source: opts.source, markdownFragment: opts.fragment });
      quietOverlay = _overlay;
    } finally {
      _quietOpen = false;
    }
    return Promise.resolve(opened).then(function (ok) {
      var ours = !!quietOverlay && _overlay === quietOverlay;
      if (ok !== true || !ours || !_isDockContextCurrent(contextKey, generation) || !_canDockRight()) {
        if (ours) close();
        else if (quietOverlay && quietOverlay.isConnected) {
          // Something else took the preview over (a tab click): drop the offstage one.
          _disposePreview(quietOverlay);
          quietOverlay.remove();
        }
        _restoreFocus(focus);
        return false;
      }
      var modal = quietOverlay.querySelector('.fp-modal');
      var path = (_currentFile && _currentFile.absPath) || filePath;
      if (!modal) return false;
      // Another request for the same path finished first.
      if (_findFileTab(path)) {
        close();
        _restoreFocus(focus);
        return 'exists';
      }
      var tab;
      if (_dockOverlay && _dockHidden) {
        tab = _stashInHiddenDock(quietOverlay, modal, path);
        tab.automatic = opts.automatic === true;
        tab.fragment = opts.fragment || null;
        _replaceTab(tab, replaced && _dockTabs.indexOf(replaced) >= 0 ? replaced : null);
        if (!opts.skipServerSync) {
          _syncWindowOp({
            type: 'upsert-file',
            path: path,
            paneId: tab.paneId || null,
            replaces: opts.replaces || null,
            fragment: tab.fragment || null,
            automatic: tab.automatic,
            unread: true,
            activate: activate,
            keepUnread: true,
          });
        }
        _restoreFocus(focus);
        return 'hidden';
      }
      _dockCurrentPreview();
      tab = _activeDockTab();
      tab.fragment = opts.fragment || null;
      if (opts.automatic) { tab.automatic = true; _highlightDocumentTab(tab); }
      quietOverlay.classList.remove('fp-restoring');
      if (_dockOverlay) _dockOverlay.classList.remove('fp-restoring');
      if (!activate && previous != null && previous !== tab.id && _dockTabs.some(function (t) { return t.id === previous; })) {
        tab.unread = true;
        _activateDockTab(previous);
      }
      _replaceTab(tab, replaced && _dockTabs.indexOf(replaced) >= 0 ? replaced : null);
      _renderDockTabs();
      _persistDockState();
      if (!opts.skipServerSync) {
        _syncWindowOp({
          type: 'upsert-file',
          path: path,
          paneId: tab.paneId || null,
          replaces: opts.replaces || null,
          fragment: tab.fragment || null,
          automatic: !!tab.automatic,
          unread: !!tab.unread,
          activate: activate,
          keepUnread: !!tab.unread,
        });
      }
      _restoreFocus(focus);
      return activate ? 'activated' : 'added';
    });
  }

  // --- Tool blocks in the dock ---

  function _findBlockTab(key) {
    for (var i = 0; i < _dockTabs.length; i++) {
      if (_dockTabs[i].block && _dockTabs[i].block.key === key) return _dockTabs[i];
    }
    return null;
  }

  function _releaseBlockFrame(frame) {
    frame.removeAttribute('data-dock-block');
    frame.removeAttribute('aria-labelledby');
    frame.removeAttribute('id');
    frame.setAttribute('role', 'region');
  }

  /** Puts declared blocks into the dock whenever one can exist. */
  function _syncBlockArrival(tab) {
    if (!tab.block.arrivalId || tab.arrivalId === tab.block.arrivalId) return;
    tab.arrivalId = tab.block.arrivalId;
    tab.unread = !!tab.block.unread;
    tab.automatic = true;
    if (tab.unread) _highlightDocumentTab(tab);
  }

  function _mountBlockTabs() {
    if (!_blockTabs.length || _restoringDock || _switchingDockContext) return;
    // A file modal owns the preview globals; close() mounts once it is gone.
    if (_overlay && _placement !== 'side') return;
    if (!_canDockRight()) return;
    var blockPrefs = _fileTabs().length === 0 ? _loadPrefs(_dockContextKey) : null;
    if (blockPrefs) {
      if (!_savedTabOrder && Array.isArray(blockPrefs.order)) _savedTabOrder = blockPrefs.order;
      if (!_pendingBlockKey && typeof blockPrefs.activeBlock === 'string') _pendingBlockKey = blockPrefs.activeBlock;
    }
    var restoreHiddenBlocks = !!(blockPrefs && blockPrefs.hidden === true && (!_dockOverlay || !_dockOverlay.isConnected) && !_dockHidden);
    _blockTabs.forEach(function (block) {
      if (_findBlockTab(block.key)) return;
      _ensureDockOverlay();
      if (blockPrefs && blockPrefs.width > 0 && !_dockOverlay.style.width) {
        var clamped = _clampSideWidth(blockPrefs.width);
        _dockOverlay.style.flexBasis = clamped + 'px';
        _dockOverlay.style.width = clamped + 'px';
        if (document.body.classList.contains('fp-side-open') && !_dockOverlay.classList.contains('fp-side-maximized')) {
          _syncDockOpenWidth(clamped);
        }
      }
      var id = _nextDockTabId++;
      block.element.id = 'fp-panel-' + id;
      block.element.setAttribute('role', 'tabpanel');
      block.element.setAttribute('aria-labelledby', 'fp-tab-' + id);
      block.element.setAttribute('data-dock-block', '');
      block.element.hidden = true;
      var tab = { id: id, block: block, path: '', modal: block.element };
      _syncBlockArrival(tab);
      _dockTabs.push(tab);
    });
    _applySavedTabOrder();
    if (!_dockOverlay) return;
    if (!_activeDockTabId) {
      var preferred = _blockTabs.filter(function (block) { return block.active; })[0];
      if (preferred) _activeDockTabId = _findBlockTab(preferred.key).id;
    }
    // The block that was on top when this window's dock was last saved.
    var pendingTab = null;
    if (_pendingBlockKey) {
      var pending = _blockTabs.filter(function (block) { return block.persistKey === _pendingBlockKey; })[0];
      if (pending) {
        _pendingBlockKey = null;
        pendingTab = _findBlockTab(pending.key);
      }
    }
    if (restoreHiddenBlocks) {
      if (pendingTab) _activeDockTabId = pendingTab.id;
      _hideDock(false);
      return;
    }
    if (_dockHidden) {
      if (pendingTab) _activeDockTabId = pendingTab.id;
      _syncRestoreButton();
      return;
    }
    if (_dockOverlay.isConnected) _renderDockTabs();
    else _showDock(true);
    if (pendingTab) _activateDockTab(pendingTab.id);
  }

  /** Declares the blocks that belong in the dock; anything else leaves it. */
  function _syncBlockTabs(blocks) {
    var arrived = blocks.find(function (block) {
      var tab = _findBlockTab(block.key);
      return block.active && block.unread && (!tab || tab.arrivalId !== block.arrivalId);
    });
    if (arrived) _pendingBlockKey = arrived.persistKey;
    var byKey = {};
    blocks.forEach(function (block) { byKey[block.key] = block; });
    for (var i = _dockTabs.length - 1; i >= 0; i--) {
      if (_dockTabs[i].block && !byKey[_dockTabs[i].block.key]) _removeDockTab(i);
    }
    _blockTabs = blocks;
    _dockTabs.forEach(function (tab) {
      if (tab.block) {
        tab.block = byKey[tab.block.key];
        tab.modal = tab.block.element;
        _syncBlockArrival(tab);
      }
    });
    _mountBlockTabs();
    if (_dockOverlay && _dockTabs.length) _renderDockTabs();
  }

  function _activateBlockTab(key) {
    var tab = _findBlockTab(key);
    if (!tab) return false;
    _pendingBlockKey = null;
    if (_overlay && _placement !== 'side') {
      // Shown when the file modal on top of it closes.
      _activeDockTabId = tab.id;
      return true;
    }
    if (_dockHidden || !_dockOverlay.isConnected) {
      _activeDockTabId = tab.id;
      _showDock();
    } else {
      _activateDockTab(tab.id);
    }
    // Opened next to a narrow document: give the block room to work.
    if (_sideSetWidth && _dockOverlay && _dockOverlay.isConnected) {
      var current = parseFloat(_dockOverlay.style.width) || 0;
      if (current && current < BLOCK_SIDE_WIDTH) _persistDockState(_sideSetWidth(BLOCK_SIDE_WIDTH));
    }
    return true;
  }

  function _isDockContextCurrent(contextKey, generation) {
    return !!contextKey
      && contextKey === _dockContextKey
      && generation === _dockContextGeneration;
  }

  function switchDockContext(serverId, windowId, instanceId) {
    var nextContextKey = _makeDockContextKey(serverId, windowId, instanceId);
    if (nextContextKey === _dockContextKey) {
      if (!nextContextKey) return Promise.resolve(false);
      if (_fileTabs().length > 0) {
        _mountBlockTabs();
        return Promise.resolve(true);
      }
      return restoreDocked().then(function (result) { _drainDocumentArrivals(); return result; });
    }

    _pendingBlockKey = null;
    _dockContextGeneration++;
    if (_dockContextKey) _persistDockState();
    _savedTabOrder = null;
    _persistenceSuspended = true;
    _destroyDock(true);
    _restorePromise = null;
    _restoreContextKey = null;
    _restoringDock = false;
    _restoringHidden = false;
    _persistenceSuspended = false;
    _dockContextKey = nextContextKey;
    if (window.NotificationPanel && window.NotificationPanel.syncAttention) window.NotificationPanel.syncAttention();

    // Per-window blocks change with it. They are declared now but mounted by the
    // restore below, so they cannot land in the wrong window or ahead of its files.
    _switchingDockContext = true;
    try {
      if (_blockWindowListener) _blockWindowListener();
    } finally {
      _switchingDockContext = false;
    }

    if (!nextContextKey) return Promise.resolve(false);
    return restoreDocked(_dockContextGeneration);
  }

  function switchViewContext(serverId, viewId) {
    return switchDockContext(serverId, viewId, 'local-view');
  }

  function _createDeferredFileTab(savedTab, contextKey) {
    _ensureDockOverlay();
    var id = _nextDockTabId++;
    var modal = document.createElement('div');
    modal.className = 'fp-modal fp-deferred-panel';
    modal.id = 'fp-panel-' + id;
    modal.setAttribute('role', 'tabpanel');
    modal.setAttribute('aria-labelledby', 'fp-tab-' + id);
    var body = document.createElement('div');
    body.className = 'fp-body';
    var loading = document.createElement('div');
    loading.className = 'fp-loading';
    loading.textContent = '加载中…';
    body.appendChild(loading);
    modal.appendChild(body);
    return {
      id: id,
      path: savedTab.path,
      modal: modal,
      currentFile: null,
      paneId: savedTab.paneId || null,
      source: savedTab.source || { serverId: contextKey.split('\u0000')[0], paneId: savedTab.paneId || null },
      dirContext: null,
      placementButton: null,
      maximizeButton: null,
      refreshButton: null,
      previewReady: false,
      maximized: false,
      unread: savedTab.unread === true,
      automatic: savedTab.automatic === true,
      fragment: savedTab.fragment || null,
      deferred: true,
      hydrating: false,
      hydratePromise: null,
    };
  }

  function _hydrateDeferredTab(tab) {
    if (!tab || tab.block || !tab.deferred) return Promise.resolve(false);
    if (tab.hydrating && tab.hydratePromise) return tab.hydratePromise;
    if (_overlay && _overlay !== _dockOverlay) return Promise.resolve(false);
    var contextKey = _dockContextKey;
    var generation = _dockContextGeneration;
    tab.hydrating = true;
    var quietOverlay = null;
    var opened;
    _quietOpen = true;
    try {
      opened = openFile(tab.path, tab.paneId, {
        restoring: true,
        markdownFragment: tab.fragment,
        source: tab.source || { serverId: contextKey.split('\u0000')[0], paneId: tab.paneId },
      });
      quietOverlay = _overlay;
    } finally {
      _quietOpen = false;
    }
    var p = Promise.resolve(opened).then(function (ok) {
      var ours = !!quietOverlay && _overlay === quietOverlay;
      if (!_isDockContextCurrent(contextKey, generation) || _dockTabs.indexOf(tab) < 0) {
        if (ours) {
          _disposePreview(quietOverlay);
          quietOverlay.remove();
          _overlay = _dockOverlay;
          _placement = _dockOverlay && _dockOverlay.isConnected ? 'side' : 'modal';
        }
        return false;
      }
      if (ok !== true) {
        if (ours) {
          _disposePreview(quietOverlay);
          quietOverlay.remove();
          _overlay = _dockOverlay;
          _placement = _dockOverlay && _dockOverlay.isConnected ? 'side' : 'modal';
        }
        if (ok === false && ours) {
          var idx = _dockTabs.indexOf(tab);
          if (idx >= 0) _removeDockTab(idx);
        }
        return false;
      }
      if (!ours) return false;
      var modal = quietOverlay.querySelector('.fp-modal');
      if (!modal) return false;
      modal.remove();
      quietOverlay.remove();
      if (tab.modal && tab.modal.parentNode) tab.modal.remove();
      modal.id = 'fp-panel-' + tab.id;
      modal.setAttribute('role', 'tabpanel');
      modal.setAttribute('aria-labelledby', 'fp-tab-' + tab.id);
      modal.removeAttribute('aria-modal');
      tab.modal = modal;
      tab.currentFile = _currentFile;
      tab.paneId = _currentPaneId;
      tab.source = _currentSource;
      tab.dirContext = _dirContext;
      tab.placementButton = _placementButton;
      tab.maximizeButton = _maximizeButton;
      tab.refreshButton = _refreshButton;
      tab.previewReady = _previewReady;
      tab.deferred = false;
      if (_currentFile && _currentFile.absPath) tab.path = _currentFile.absPath;
      if (_activeDockTabId === tab.id && !_dockHidden) {
        _placement = 'modal';
        _activateDockTab(tab.id);
      } else {
        _overlay = _dockOverlay;
        _placement = _dockOverlay && _dockOverlay.isConnected ? 'side' : 'modal';
        _renderDockTabs();
        _persistDockState();
      }
      return true;
    }).catch(function () {
      if (quietOverlay && _overlay === quietOverlay) {
        _disposePreview(quietOverlay);
        quietOverlay.remove();
        _overlay = _dockOverlay;
        _placement = _dockOverlay && _dockOverlay.isConnected ? 'side' : 'modal';
      }
      return false;
    }).finally(function () {
      tab.hydrating = false;
      tab.hydratePromise = null;
    });
    tab.hydratePromise = p;
    return p;
  }

  function restoreDocked(expectedGeneration) {
    var contextKey = _dockContextKey;
    var generation = expectedGeneration == null ? _dockContextGeneration : expectedGeneration;
    if (!contextKey || !_isDockContextCurrent(contextKey, generation)) return Promise.resolve(false);
    if (_restorePromise && _restoreContextKey === contextKey) return _restorePromise;
    if (_fileTabs().length > 0) {
      if (_dockHidden) _hideDock();
      else _showDock();
      _mountBlockTabs();
      return Promise.resolve(true);
    }
    var saved = _loadDockState();
    var restoringArrivals = (_queuedDockDocuments[contextKey] || []).slice();
    if (restoringArrivals.length) {
      saved = saved || { tabs: [], width: 0, hidden: false };
      _mergeDocumentArrivals(saved, restoringArrivals);
    }
    if (!saved || !_canDockRight()) {
      _mountBlockTabs();
      return Promise.resolve(false);
    }

    var localPrefs = _loadPrefs(contextKey);
    if (localPrefs) {
      if (typeof localPrefs.hidden === 'boolean') saved.hidden = localPrefs.hidden;
      if (Number(localPrefs.width) > 0) saved.width = Number(localPrefs.width);
    }

    _restoringDock = true;
    _persistenceSuspended = true;
    _restoringHidden = saved.hidden;
    _savedTabOrder = saved.order || saved.tabs.map(function (t) { return 'file:' + t.path; });
    // The terminal measures itself next, and its tabs take a while to load. Holding
    // the space now means it attaches at the final size, not once more when they arrive.
    if (!saved.hidden) _reserveDockSpace(saved.width);

    var eagerLoaded = false;
    var primaryIndex = 0;
    if (!saved.activeBlock && saved.tabs.length > 0) {
      var foundIdx = saved.tabs.findIndex(function (t) { return t.path === saved.activePath; });
      if (foundIdx >= 0) primaryIndex = foundIdx;
    }
    var candidates = saved.activeBlock
      ? []
      : [saved.tabs[primaryIndex]].concat(saved.tabs.filter(function (_t, i) { return i !== primaryIndex; }));
    var missingPaths = {};
    var chain = Promise.resolve();
    candidates.forEach(function (tab) {
      chain = chain.then(function () {
        if (eagerLoaded || !_isDockContextCurrent(contextKey, generation)) return false;
        return openFile(tab.path, tab.paneId, { restoring: true,
          markdownFragment: tab.fragment,
          source: tab.source || { serverId: contextKey.split('\u0000')[0], paneId: tab.paneId } })
          .then(function (opened) {
            if (!_isDockContextCurrent(contextKey, generation)) return;
            if (opened === true) {
              eagerLoaded = true;
              _dockCurrentPreview();
              var restored = _activeDockTab();
              restored.unread = tab.unread;
              restored.automatic = tab.automatic;
              restored.fragment = tab.fragment;
              _queuedDockDocuments[contextKey] = (_queuedDockDocuments[contextKey] || []).filter(function (item) {
                return item.path !== tab.path || restoringArrivals.indexOf(item) < 0;
              });
              return;
            }
            missingPaths[tab.path] = true;
            if (_placement !== 'side' && _overlay) close();
          });
      });
    });

    _restoreContextKey = contextKey;
    _restorePromise = chain.then(function () {
      if (!_isDockContextCurrent(contextKey, generation)) return false;
      saved.tabs.forEach(function (tab) {
        if (missingPaths[tab.path] || _findFileTab(tab.path)) return;
        _dockTabs.push(_createDeferredFileTab(tab, contextKey));
        _queuedDockDocuments[contextKey] = (_queuedDockDocuments[contextKey] || []).filter(function (item) {
          return item.path !== tab.path || restoringArrivals.indexOf(item) < 0;
        });
      });
      if (_dockTabs.length === 0) {
        _destroyDock();
        return false;
      }
      _applySavedTabOrder();
      var active = null;
      for (var i = 0; i < _dockTabs.length; i++) {
        if (_dockTabs[i].path === saved.activePath) { active = _dockTabs[i]; break; }
      }
      _restoringDock = false;
      if (_dockOverlay) _dockOverlay.classList.remove('fp-restoring');
      _activateDockTab((active || _dockTabs[0]).id);
      if (saved.hidden) _hideDock();
      else _showDock();
      return true;
    }).catch(function () {
      if (_isDockContextCurrent(contextKey, generation)) _destroyDock();
      return false;
    }).finally(function () {
      if (!_isDockContextCurrent(contextKey, generation)) return;
      _restoringDock = false;
      _restoringHidden = false;
      _persistenceSuspended = false;
      _restorePromise = null;
      _restoreContextKey = null;
      _pendingBlockKey = _pendingBlockKey || saved.activeBlock || null;
      _mountBlockTabs();
      var currentActive = _activeDockTab();
      if (currentActive && currentActive.deferred && !_dockHidden) {
        _hydrateDeferredTab(currentActive);
      }
      _acknowledgeFilePreview();
      _persistDockState();
      _drainDocumentArrivals();
    });
    return _restorePromise;
  }

  // --- Lazy loading ---
  var _loaded = {};

  function _loadScript(url) {
    if (_loaded[url]) return _loaded[url];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      var timer = setTimeout(function () { reject(new Error('Timeout loading: ' + url)); }, 10000);
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); reject(new Error('Failed to load: ' + url)); };
      document.head.appendChild(s);
    });
    _loaded[url] = p.catch(function (err) { delete _loaded[url]; throw err; });
    return _loaded[url];
  }

  function _loadCSS(url) {
    if (_loaded[url]) return _loaded[url];
    _loaded[url] = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
    return _loaded[url];
  }

  var CDN = {
    hljs: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js',
    hljsCss: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css',
    markdownIt: 'https://unpkg.com/markdown-it@14.1.0/dist/markdown-it.min.js',
    katexCss: 'https://unpkg.com/katex@0.16.21/dist/katex.min.css',
    katexJs: 'https://unpkg.com/katex@0.16.21/dist/katex.min.js',
    markdownItKatex: 'https://unpkg.com/@iktakahiro/markdown-it-katex@4.0.1/dist/markdown-it-katex.min.js',
    mermaid: 'https://unpkg.com/mermaid@11.6.0/dist/mermaid.min.js',
    exceljs: 'https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js',
  };

  // --- Modal ---

  function _createModal(title) {
    if (_shareDialogClose) _shareDialogClose();
    var opener = document.activeElement;
    if (!_overlay || _placement === 'side' || !_overlay.contains(opener)) _modalReturnFocus = opener;
    _closeActionMenu();
    _stopAutoRefresh();
    if (document.__fpActiveMermaidDialogClose) document.__fpActiveMermaidDialogClose();
    if (_placement === 'side') {
      _pauseVideos(_overlay);
      _saveActiveDockTab();
    } else if (_overlay) {
      _pauseVideos(_overlay);
      _disposePreview(_overlay);
      _overlay.remove();
    }
    _maximized = false;
    _placement = 'modal';

    _overlay = document.createElement('div');
    _overlay.className = 'fp-overlay' + (_restoringDock || _quietOpen ? ' fp-restoring' : '');
    _overlay.addEventListener('click', function (e) {
      if (e.target === _overlay) close();
    });

    var modal = document.createElement('div');
    modal.className = 'fp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '文件预览：' + title);
    modal.setAttribute('aria-modal', 'true');

    var header = document.createElement('div');
    header.className = 'fp-header';

    var titleEl = document.createElement('span');
    titleEl.className = 'fp-title';
    titleEl.textContent = title;
    titleEl.title = title;

    var actions = document.createElement('div');
    actions.className = 'fp-actions';

    var btnBack = _btn('', '返回上级目录', function () {
      // On a phone, this is the reader's back affordance. Directories have
      // their own breadcrumb/up row; leaving them returns to the workspace.
      if (_isMobileReader() && (!_dirContext || (_currentFile && _currentFile.isDirectory))) {
        close();
        return;
      }
      if (_dirContext) {
        var parent = _dirContext;
        _dirContext = null;
        openFile(parent, _currentPaneId, { source: _currentSource });
      }
    });
    btnBack.className += ' fp-btn-back';
    _setSvgIcon(btnBack, '<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>');
    var backLabel = document.createElement('span');
    backLabel.className = 'fp-back-label';
    backLabel.textContent = '返回';
    btnBack.appendChild(backLabel);

    var btnMaximize = _btn('', '最大化预览', function () {
      _maximized = !_maximized;
      modal.classList.toggle('fp-maximized', _maximized);
      _overlay.classList.toggle('fp-side-maximized', _maximized && _placement === 'side');
      _syncMaximizeButton();
    });
    btnMaximize.className += ' fp-btn-maximize';
    _maximizeButton = btnMaximize;
    var btnPlacement = _btn('', '\u5728\u53F3\u4FA7\u5206\u680F\u6253\u5F00', function () {
      if (_placement === 'side') _hideDock();
      else _dockCurrentPreview();
    });
    btnPlacement.className += ' fp-btn-placement';
    var btnRefresh = _btn('', '刷新预览', function () { _refreshCurrent(true).finally(_syncAutoRefresh); });
    _setSvgIcon(btnRefresh,
      '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/>'
      + '<path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 9"/>'
      + '<path d="m4 15 2.4 2.6A7 7 0 0 0 17.9 15"/>');
    btnRefresh.className += ' fp-btn-refresh is-live';
    btnRefresh.title = '刷新预览（每 1.5 秒自动检查）';
    _refreshButton = btnRefresh;
    _placementButton = btnPlacement;
    var btnNewTab = _btn('', '在新标签页打开', function () { _openNewTab(); });
    _setSvgIcon(btnNewTab,
      '<path d="M15 3h6v6"/><path d="m10 14 11-11"/>'
      + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
    btnNewTab.className += ' fp-btn-file-only fp-btn-newtab';
    var btnShare = _btn('', '\u751F\u6210\u5185\u7F51\u5206\u4EAB\u94FE\u63A5', function () { _openShareDialog(); });
    _setSvgIcon(btnShare,
      '<path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/>'
      + '<path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14"/>');
    btnShare.className += ' fp-btn-file-only';
    var copyItems = [
        { label: '带格式复制', hint: '渲染后的富文本，保留标题、表格与图片',
          icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
            + '<path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
          run: _copyRendered },
        { label: '不带格式复制', hint: '无样式的纯文本',
          icon: '<path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/>'
            + '<path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/>'
            + '<path d="M8 12h8"/>',
          run: _copyPlainText },
    ];
    var downloadItems = [
        { label: '下载原文件', hint: '服务器上的原始文件',
          icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
            + '<path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
          run: _download },
        { label: '导出渲染后的 HTML', hint: '当前预览效果的自包含快照',
          icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
            + '<path d="M14 2v6h6"/><path d="M12 11v7"/><path d="m9 15 3 3 3-3"/>',
          run: _exportHtml },
    ];
    // Low-frequency commands keep their original listeners/state, but share
    // one visible menu. Flatten copy/download choices so no detached submenu
    // anchor can lose its position or keyboard focus.
    function buttonAction(button) {
      return { label: button.getAttribute('aria-label'),
        icon: button.querySelector('svg').innerHTML,
        run: function () { button.click(); } };
    }
    var btnMore = _menuBtn('更多文件操作', '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', function () {
      var items = _isMobileReader() ? [] : [buttonAction(btnMaximize)];
      if (window.Blocks && _currentFile) {
        var blockBody = _overlay && _overlay.querySelector('.fp-body');
        items = items.concat(window.Blocks.previewActions(_currentFile, {
          body: blockBody,
          paneId: _currentPaneId,
          refresh: function () { return _refreshCurrent(true); },
        }));
      }
      if (_currentFile && !_currentFile.isDirectory) {
        var html = modal.querySelector('.fp-html-wrap');
        if (html) items.push({
          label: html.getAttribute('data-source-visible') === 'true' ? '查看预览' : '查看源码',
          icon: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m14 4-4 16"/>',
          run: function () { html.__fpToggleSource(); },
        });
        if (_nativeBrowserHandler()) {
          items.push({
            label: '在浏览器中打开',
            hint: '在系统默认浏览器中打开当前预览',
            icon: btnNewTab.querySelector('svg').innerHTML,
            run: function () { _openNewTab(); },
          });
        } else {
          items.push(buttonAction(btnNewTab));
        }
        items = items.concat(copyItems, [buttonAction(btnShare)], downloadItems);
      }
      if (_isMobileReader()) items.push(buttonAction(btnClose));
      return items;
    });
    btnMore.className += ' fp-btn-more';
    var moreLabel = document.createElement('span');
    moreLabel.textContent = '更多';
    btnMore.appendChild(moreLabel);
    var btnClose = _btn('', '关闭预览', close);
    _setSvgIcon(btnClose, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
    btnClose.className += ' fp-btn-close';

    actions.appendChild(btnRefresh);
    actions.appendChild(btnPlacement);
    actions.appendChild(btnMore);
    actions.appendChild(btnClose);
    header.appendChild(btnBack);
    header.appendChild(titleEl);
    header.appendChild(actions);

    var body = document.createElement('div');
    body.className = 'fp-body';
    body.innerHTML = '<div class="fp-loading" role="status">正在读取文件\u2026</div>';

    modal.appendChild(header);
    modal.appendChild(body);
    _overlay.appendChild(modal);
    document.body.appendChild(_overlay);
    _setPreviewTitle(title);
    _syncPlacementButton();
    _syncMaximizeButton();

    if (!_quietOpen) (_isMobileReader() ? btnBack : btnClose).focus();
    _overlay.addEventListener('keydown', function (e) {
      if (window.CommandPalette && window.CommandPalette.isOpen && window.CommandPalette.isOpen()) return;
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); e.stopPropagation(); }
      if (e.key === 'Tab') {
        var focusable = Array.prototype.filter.call(modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'), function (el) {
          return !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden], [inert]')
            && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
        });
        if (focusable.length === 0) return;
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    return body;
  }

  function _btn(text, label, onclick) {
    var b = document.createElement('button');
    b.className = 'fp-btn';
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onclick);
    return b;
  }

  // Toolbar button that toggles an action menu. The ARIA menu-button contract
  // is declared up front so aria-expanded is meaningful before the first open.
  function _menuBtn(label, iconPaths, items) {
    var b = _btn('', label, function () { _openActionMenu(b, typeof items === 'function' ? items() : items); });
    _setSvgIcon(b, iconPaths);
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    return b;
  }

  function _setSvgIcon(button, paths) {
    button.classList.add('fp-btn-svg');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true" focusable="false">' + paths + '</svg>';
  }

  // One shared anchored popup for the toolbar's menu buttons. It lives on
  // document.body rather than inside the header because .fp-modal clips
  // overflow, and only one menu is ever open at a time.
  function _closeActionMenu() {
    var menu = _actionMenu;
    if (!menu) return;
    _actionMenu = null;
    document.removeEventListener('mousedown', menu.onOutside, true);
    document.removeEventListener('keydown', menu.onKeydown, true);
    window.removeEventListener('resize', menu.onDismiss);
    menu.el.remove();
    if (menu.scrim) menu.scrim.remove();
    menu.anchor.classList.remove('is-active');
    menu.anchor.setAttribute('aria-expanded', 'false');
  }

  // items: [{ label, hint, icon, disabled, run }]. `icon` is trusted SVG
  // markup from this file; label/hint are rendered as text.
  function _openActionMenu(anchor, items) {
    if (_actionMenu && _actionMenu.anchor === anchor) { _closeActionMenu(); return; }
    _closeActionMenu();

    var el = document.createElement('div');
    el.className = 'fp-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', anchor.getAttribute('aria-label') || '文件操作');

    items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fp-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('aria-label', item.label);
      if (item.icon) {
        var icon = document.createElement('span');
        icon.className = 'fp-menu-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
          + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
          + ' aria-hidden="true" focusable="false">' + item.icon + '</svg>';
        btn.appendChild(icon);
      }
      var text = document.createElement('span');
      text.className = 'fp-menu-text';
      var label = document.createElement('span');
      label.className = 'fp-menu-label';
      label.textContent = item.label;
      text.appendChild(label);
      if (item.hint) {
        var hint = document.createElement('span');
        hint.className = 'fp-menu-hint';
        hint.textContent = item.hint;
        text.appendChild(hint);
      }
      btn.appendChild(text);
      if (item.disabled) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () { _closeActionMenu(); anchor.focus(); item.run(); });
      }
      el.appendChild(btn);
    });

    var scrim = null;
    if (_isMobileReader()) {
      scrim = document.createElement('button');
      scrim.type = 'button';
      scrim.className = 'fp-menu-scrim';
      scrim.setAttribute('aria-label', '关闭文件操作');
      scrim.addEventListener('click', function () { _closeActionMenu(); anchor.focus(); });
      document.body.appendChild(scrim);
    }
    document.body.appendChild(el);
    var rect = anchor.getBoundingClientRect();
    var width = el.offsetWidth, height = el.offsetHeight;
    var left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    var top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';

    // The anchor is excluded so its own click handler performs the toggle
    // instead of the outside-mousedown closing it first.
    var onOutside = function (e) {
      if (e.target !== scrim && !el.contains(e.target) && !anchor.contains(e.target)) _closeActionMenu();
    };
    var onKeydown = function (e) {
      if (window.CommandPalette && window.CommandPalette.isOpen && window.CommandPalette.isOpen()) return;
      var buttons = Array.prototype.slice.call(el.querySelectorAll('.fp-menu-item:not([disabled])'));
      var index = buttons.indexOf(document.activeElement), next;
      if (e.key === 'ArrowDown') next = (index + 1) % buttons.length;
      else if (e.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = buttons.length - 1;
      else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        _closeActionMenu(); anchor.focus(); return;
      } else return;
      e.preventDefault(); e.stopPropagation();
      if (buttons[next]) buttons[next].focus();
    };
    var onDismiss = function () { _closeActionMenu(); };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onDismiss);

    _actionMenu = {
      el: el, anchor: anchor, scrim: scrim,
      onOutside: onOutside, onKeydown: onKeydown, onDismiss: onDismiss,
    };
    anchor.classList.add('is-active');
    anchor.setAttribute('aria-expanded', 'true');
    var first = el.querySelector('.fp-menu-item:not([disabled])');
    if (first) first.focus();
  }

  function _mermaidHex(value, fallback) {
    var color = String(value || '').trim();
    var shortHex = /^#([0-9a-f]{3})$/i.exec(color);
    if (shortHex) {
      return '#' + shortHex[1].split('').map(function (ch) { return ch + ch; }).join('');
    }
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    var rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
    if (rgb) {
      return '#' + rgb.slice(1, 4).map(function (channel) {
        return Math.max(0, Math.min(255, Number(channel))).toString(16).padStart(2, '0');
      }).join('');
    }
    return fallback;
  }

  function _mermaidThemeValue(styles, name, fallback) {
    return _mermaidHex(styles.getPropertyValue(name), fallback);
  }

  function _isDarkMermaidColor(hex) {
    var value = parseInt(hex.slice(1), 16);
    var red = (value >> 16) & 255;
    var green = (value >> 8) & 255;
    var blue = value & 255;
    return (red * 299 + green * 587 + blue * 114) / 1000 < 128;
  }

  function _mermaidThemeConfig() {
    var styles = window.getComputedStyle(document.documentElement);
    var background = _mermaidThemeValue(styles, '--bg-primary', '#1a1b26');
    var deep = _mermaidThemeValue(styles, '--bg-deep', '#16161e');
    var card = _mermaidThemeValue(styles, '--bg-card', '#24283b');
    var hover = _mermaidThemeValue(styles, '--bg-hover', '#292e42');
    var border = _mermaidThemeValue(styles, '--border', '#3b4261');
    var subtleBorder = _mermaidThemeValue(styles, '--border-subtle', '#2f3450');
    var text = _mermaidThemeValue(styles, '--text-primary', '#c0caf5');
    var secondaryText = _mermaidThemeValue(styles, '--text-secondary', '#a9b1d6');
    var accent = _mermaidThemeValue(styles, '--accent-blue', '#7aa2f7');

    return {
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'loose',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      themeVariables: {
        darkMode: _isDarkMermaidColor(background),
        background: background,
        primaryColor: card,
        primaryTextColor: text,
        primaryBorderColor: accent,
        secondaryColor: hover,
        secondaryTextColor: text,
        secondaryBorderColor: border,
        tertiaryColor: deep,
        tertiaryTextColor: text,
        tertiaryBorderColor: subtleBorder,
        lineColor: accent,
        textColor: text,
        mainBkg: card,
        nodeBorder: accent,
        clusterBkg: deep,
        clusterBorder: border,
        defaultLinkColor: accent,
        titleColor: text,
        edgeLabelBackground: background,
        nodeTextColor: text,
        noteBkgColor: hover,
        noteTextColor: text,
        noteBorderColor: border,
        actorBkg: card,
        actorBorder: accent,
        actorTextColor: text,
        signalColor: secondaryText,
        signalTextColor: text,
        labelBoxBkgColor: hover,
        labelBoxBorderColor: border,
        labelTextColor: text,
      },
      // Reserve vertical room below subgraph titles. Mermaid only sizes for a
      // single-line title, so a long wrapped title needs extra bottom room.
      flowchart: { subGraphTitleMargin: { top: 6, bottom: 24 } },
    };
  }

  function _initializeMermaidTheme() {
    window.mermaid.initialize(_mermaidThemeConfig());
  }

  function _mermaidContrast(first, second) {
    function luminance(color) {
      var channels = [1, 3, 5].map(function (offset) {
        var value = parseInt(color.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    var a = luminance(first), b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  // Authored pastel fills bypass Mermaid's theme. Rebase them onto dark panel
  // surfaces while retaining their hue, then repair label/border contrast.
  // Inline SVG styles also survive the viewer and image export.
  function _adaptMermaidPalette(svg) {
    var styles = window.getComputedStyle(document.documentElement);
    var panel = _mermaidThemeValue(styles, '--bg-primary', '#1a1b26');
    var card = _mermaidThemeValue(styles, '--bg-card', '#24283b');
    var preferred = _mermaidThemeValue(styles, '--text-primary', '#c0caf5');
    var dark = _isDarkMermaidColor(panel);
    function solidColor(value) {
      var color = String(value || '').trim();
      var alpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(color);
      if (alpha && Number(alpha[1]) !== 1) return null;
      return _mermaidHex(color, null);
    }
    function channels(color) {
      return [1, 3, 5].map(function (offset) { return parseInt(color.slice(offset, offset + 2), 16); });
    }
    function mix(base, tint, amount) {
      var target = channels(tint);
      return '#' + channels(base).map(function (value, index) {
        return Math.round(value + (target[index] - value) * amount).toString(16).padStart(2, '0');
      }).join('');
    }
    function hueTint(fill, stroke) {
      // Pale fills often carry their useful hue in the stronger outline.
      var rgb = channels(fill);
      if (Math.max.apply(null, rgb) - Math.min.apply(null, rgb) < 24 && stroke) {
        var outline = channels(stroke);
        if (Math.max.apply(null, outline) - Math.min.apply(null, outline) >= 12) rgb = outline;
      }
      var low = Math.min.apply(null, rgb), range = Math.max.apply(null, rgb) - low;
      if (range < 12) return null;
      return '#' + rgb.map(function (value) {
        return Math.round(88 + (value - low) / range * 112).toString(16).padStart(2, '0');
      }).join('');
    }
    svg.querySelectorAll('g.cluster, g.node').forEach(function (group) {
      var shape = Array.prototype.find.call(group.children, function (child) {
        return child.matches('rect,circle,ellipse,polygon,path');
      });
      var label = group.querySelector(':scope > .cluster-label, :scope > .label');
      if (!shape || !label) return;
      var shapeStyle = window.getComputedStyle(shape);
      if ((shapeStyle.opacity && Number(shapeStyle.opacity) < 1)
        || (shapeStyle.fillOpacity && Number(shapeStyle.fillOpacity) < 1)) return;
      var background = solidColor(shapeStyle.fill || shape.getAttribute('fill'));
      if (!background) return;
      var adapted = dark && !_isDarkMermaidColor(background);
      if (adapted) {
        var cluster = group.classList.contains('cluster');
        var stroke = solidColor(shapeStyle.stroke || shape.getAttribute('stroke'));
        var defaultStroke = _mermaidThemeValue(styles, cluster ? '--border' : '--accent-blue', cluster ? '#3b4261' : '#7aa2f7');
        var tint = hueTint(background, stroke && stroke.toLowerCase() !== defaultStroke.toLowerCase() ? stroke : null);
        background = tint ? mix(cluster ? panel : card, tint, cluster ? 0.14 : 0.3) : (cluster ? panel : card);
        shape.style.setProperty('fill', background, 'important');
        if (stroke && _mermaidContrast(stroke, background) < 3) {
          var outline = [0.25, 0.5, 0.75, 1].map(function (amount) { return mix(stroke, preferred, amount); })
            .find(function (color) { return _mermaidContrast(color, background) >= 3; });
          if (outline) shape.style.setProperty('stroke', outline, 'important');
        }
      }
      label.querySelectorAll('*').forEach(function (element) {
        var isSvg = element.namespaceURI === 'http://www.w3.org/2000/svg';
        if (isSvg && !element.matches('text,tspan')) return;
        var property = isSvg ? 'fill' : 'color';
        var current = solidColor(window.getComputedStyle(element)[property]);
        if (current ? _mermaidContrast(current, background) >= 4.5 : !adapted) return;
        var replacement = [preferred, _contrastText(background), '#000000', '#ffffff'].find(function (color) {
          return _mermaidContrast(color, background) >= 4.5;
        });
        element.style.setProperty(property, replacement, 'important');
      });
      // Apply glass styling only after repairing solid fills; authored
      // translucency and gradients keep their own appearance.
      shape.setAttribute('data-fp-surface', group.classList.contains('cluster') ? 'group' : 'node');
    });

    // Enforce readable contrast on custom-styled flowchart nodes/clusters even in light mode.
    if (svg.getAttribute('aria-roledescription') && String(svg.getAttribute('aria-roledescription')).indexOf('flowchart') === 0) {
      svg.querySelectorAll('.node, .cluster').forEach(function (node) {
        var shape = node.classList.contains('cluster')
          ? node.querySelector('rect')
          : node.querySelector('.label-container:not(g), .label-container :not(g)');
        if (!shape) return;
        var st = window.getComputedStyle(shape);
        var bg = solidColor(st.fill || shape.getAttribute('fill'));
        if (!bg || (st.fillOpacity && Number(st.fillOpacity) < 1) || (st.opacity && Number(st.opacity) < 1)) return;
        var best = _mermaidContrast(preferred, bg) >= _mermaidContrast(panel, bg)
          ? { color: preferred, ratio: _mermaidContrast(preferred, bg) }
          : { color: panel, ratio: _mermaidContrast(panel, bg) };
        node.querySelectorAll('text, tspan, .nodeLabel, .nodeLabel *').forEach(function (el) {
          if (el.closest('.node, .cluster') !== node) return;
          var isSvg = el.localName === 'text' || el.localName === 'tspan';
          var lst = window.getComputedStyle(el);
          if (!isSvg && solidColor(lst.backgroundColor) !== null) return;
          var cur = solidColor(isSvg ? lst.fill : lst.color);
          var ratio = cur ? _mermaidContrast(cur, bg) : 0;
          if (ratio < 4.5 && best.ratio > ratio) {
            el.style.setProperty(isSvg ? 'fill' : 'color', best.color, 'important');
          }
        });
      });
    }
  }

  // Turn Mermaid's responsive SVG into a readable, scrollable embed. Mermaid
  // emits width="100%" plus a max-width, which is useful for small diagrams but
  // makes a wide flowchart's labels unreadably tiny. Keep at least 75% of the
  // intrinsic SVG size and let the embed scroll horizontally instead.
  function _prepareMermaid(container) {
    var svg = container.querySelector('svg');
    if (!svg) return false;
    _adaptMermaidPalette(svg);
    var viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
    var width = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2]
      : parseFloat(svg.getAttribute('width')) || 800;
    var height = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3]
      : parseFloat(svg.getAttribute('height')) || 450;

    container.classList.add('fp-mermaid-embed');
    container.setAttribute('data-fp-width', String(width));
    container.setAttribute('data-fp-height', String(height));

    var scroll = document.createElement('div');
    scroll.className = 'fp-mermaid-scroll';
    scroll.setAttribute('aria-label', '\u53EF\u6EDA\u52A8\u7684 Mermaid \u56FE\u8868');
    var canvas = document.createElement('div');
    canvas.className = 'fp-mermaid-canvas';
    canvas.title = '\u70B9\u51FB\u653E\u5927\u67E5\u770B';
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    canvas.appendChild(svg);
    scroll.appendChild(canvas);

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'fp-mermaid-open';
    open.setAttribute('aria-label', '\u653E\u5927\u67E5\u770B Mermaid \u56FE\u8868');
    open.title = '\u653E\u5927\u67E5\u770B';
    open.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true"><path d="M8 3H3v5"/><path d="M16 3h5v5"/>'
      + '<path d="M8 21H3v-5"/><path d="M16 21h5v-5"/></svg>';

    container.innerHTML = '';
    container.appendChild(scroll);
    container.appendChild(open);
    return true;
  }

  // Self-contained on purpose: its source is also embedded into exported/new-
  // tab HTML, so graph behavior stays the same outside the panel document.
  function _installMermaidInteractions(root) {
    var doc = root.nodeType === 9 ? root : root.ownerDocument;
    var win = doc.defaultView || window;
    var MIN_READABLE = 0.75, MIN_ZOOM = 0.2, MAX_ZOOM = 4;

    function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
    function graphSize(embed) {
      return {
        width: parseFloat(embed.getAttribute('data-fp-width')) || 800,
        height: parseFloat(embed.getAttribute('data-fp-height')) || 450,
      };
    }
    function graphEmbeds(scope) {
      var list = Array.prototype.slice.call(scope.querySelectorAll('.fp-mermaid-embed'));
      if (scope.matches && scope.matches('.fp-mermaid-embed')) list.unshift(scope);
      return list;
    }
    function textButton(className, label, text) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'fp-mermaid-tool ' + className;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.textContent = text;
      return button;
    }
    function renderPng(svg, size) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = win.setTimeout(function () {
          finish(new Error('PNG 生成超时'));
        }, 10000);
        function finish(error, blob) {
          if (settled) return;
          settled = true;
          win.clearTimeout(timer);
          if (error) reject(error); else resolve(blob);
        }
        var copy = svg.cloneNode(true);
        var surfaces = copy.querySelectorAll('[data-fp-surface]');
        svg.querySelectorAll('[data-fp-surface]').forEach(function (surface, index) {
          surfaces[index].style.fillOpacity = win.getComputedStyle(surface).fillOpacity || '1';
        });
        copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        copy.setAttribute('width', String(size.width));
        copy.setAttribute('height', String(size.height));
        copy.style.width = size.width + 'px';
        copy.style.height = size.height + 'px';

        var svgText = new win.XMLSerializer().serializeToString(copy);
        var image = new win.Image();
        image.onerror = function () {
          finish(new Error('SVG 转换失败'));
        };
        image.onload = function () {
          try {
            var outputScale = Math.min(2, 8192 / Math.max(size.width, size.height));
            var canvas = doc.createElement('canvas');
            canvas.width = Math.max(1, Math.round(size.width * outputScale));
            canvas.height = Math.max(1, Math.round(size.height * outputScale));
            var context = canvas.getContext('2d');
            if (!context) { finish(new Error('浏览器不支持图片导出')); return; }
            context.fillStyle = win.getComputedStyle(doc.documentElement)
              .getPropertyValue('--bg-primary').trim() || '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function (blob) {
              finish(blob ? null : new Error('PNG 生成失败'), blob);
            }, 'image/png');
          } catch (error) {
            finish(error);
          }
        };
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      });
    }
    function downloadPng(blob, filename) {
      var pngUrl = win.URL.createObjectURL(blob);
      var link = doc.createElement('a');
      link.href = pngUrl;
      link.download = filename;
      link.rel = 'noopener';
      doc.body.appendChild(link);
      link.click();
      link.remove();
      win.setTimeout(function () { win.URL.revokeObjectURL(pngUrl); }, 60000);
    }
    function copyPng(blobPromise) {
      var handlers = win.webkit && win.webkit.messageHandlers;
      // tmuxPanelClipboard: a native app from before the rename.
      var clipboard = handlers && (handlers.anymuxClipboard || handlers.tmuxPanelClipboard);
      if (clipboard) {
        return blobPromise.then(function (blob) {
          if (blob.size > 16 * 1024 * 1024) throw new Error('图片超过 16 MB');
          return new Promise(function (resolve, reject) {
            var reader = new win.FileReader();
            reader.onerror = function () { reject(new Error('读取 PNG 失败')); };
            reader.onload = function () {
              var result = String(reader.result || '');
              var comma = result.indexOf(',');
              if (comma < 0) { reject(new Error('PNG 编码失败')); return; }
              clipboard.postMessage({ pngBase64: result.slice(comma + 1) });
              resolve();
            };
            reader.readAsDataURL(blob);
          });
        });
      }
      if (win.navigator.clipboard && typeof win.navigator.clipboard.write === 'function'
          && typeof win.ClipboardItem === 'function') {
        return win.navigator.clipboard.write([
          new win.ClipboardItem({ 'image/png': blobPromise }),
        ]);
      }
      return Promise.reject(new Error('当前环境不支持图片剪贴板'));
    }

    graphEmbeds(root).forEach(function (embed) {
      if (embed.__fpMermaidBound) return;
      embed.__fpMermaidBound = true;
      var scroll = embed.querySelector('.fp-mermaid-scroll');
      var canvas = embed.querySelector('.fp-mermaid-canvas');
      var sourceSvg = embed.querySelector('svg');
      var openButton = embed.querySelector('.fp-mermaid-open');
      if (!scroll || !canvas || !sourceSvg || !openButton) return;
      var size = graphSize(embed);
      var observer = null;

      function layoutInline() {
        var available = (scroll.clientWidth || embed.clientWidth || win.innerWidth || size.width) - 32;
        var fit = available > 0 ? available / size.width : 1;
        var scale = fit >= MIN_READABLE ? Math.min(1, fit) : MIN_READABLE;
        sourceSvg.style.width = Math.round(size.width * scale) + 'px';
        sourceSvg.style.height = Math.round(size.height * scale) + 'px';
        embed.setAttribute('data-fp-scale', String(scale));
        embed.classList.toggle('is-wide', scale === MIN_READABLE && fit < MIN_READABLE);
      }

      function openViewer() {
        if (doc.__fpActiveMermaidDialogClose) doc.__fpActiveMermaidDialogClose();
        var overlay = doc.createElement('div');
        overlay.className = 'fp-mermaid-dialog';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Mermaid \u56FE\u8868\u67E5\u770B\u5668');

        var panel = doc.createElement('div');
        panel.className = 'fp-mermaid-dialog-panel';
        var header = doc.createElement('div');
        header.className = 'fp-mermaid-dialog-header';
        var title = doc.createElement('strong');
        title.className = 'fp-mermaid-dialog-title';
        title.textContent = 'Mermaid \u56FE\u8868';
        var tools = doc.createElement('div');
        tools.className = 'fp-mermaid-dialog-tools';
        tools.setAttribute('role', 'toolbar');
        tools.setAttribute('aria-label', '\u56FE\u8868\u5DE5\u5177');
        var minus = textButton('fp-mermaid-zoom-out', '\u7F29\u5C0F\u56FE\u8868', '\u2212');
        var percent = textButton('fp-mermaid-percent', '\u5F53\u524D\u7F29\u653E\u6BD4\u4F8B', '100%');
        percent.disabled = true;
        var plus = textButton('fp-mermaid-zoom-in', '\u653E\u5927\u56FE\u8868', '+');
        var fitButton = textButton('fp-mermaid-fit', '\u9002\u5E94\u7A97\u53E3', '\u9002\u5E94');
        var actual = textButton('fp-mermaid-actual', '\u6062\u590D 100%', '1:1');
        var exportButton = textButton('fp-mermaid-export', '\u4E0B\u8F7D PNG \u56FE\u7247', '\u4E0B\u8F7D');
        var copyButton = textButton('fp-mermaid-copy', '\u590D\u5236 PNG \u5230\u526A\u8D34\u677F', '\u590D\u5236');
        var fullscreen = textButton('fp-mermaid-fullscreen', '\u5168\u5C4F\u67E5\u770B', '\u5168\u5C4F');
        var closeButton = textButton('fp-mermaid-close', '\u5173\u95ED\u56FE\u8868\u67E5\u770B\u5668', '\u00D7');
        [minus, percent, plus, fitButton, actual, exportButton, copyButton, fullscreen, closeButton]
          .forEach(function (button) { tools.appendChild(button); });
        header.appendChild(title);
        header.appendChild(tools);

        var viewport = doc.createElement('div');
        viewport.className = 'fp-mermaid-dialog-viewport';
        viewport.setAttribute('tabindex', '0');
        viewport.setAttribute('aria-label', '\u62D6\u52A8\u67E5\u770B\u56FE\u8868\uFF0CCtrl \u6216 Command \u52A0\u6EDA\u8F6E\u53EF\u7F29\u653E');
        var dialogCanvas = doc.createElement('div');
        dialogCanvas.className = 'fp-mermaid-dialog-canvas';
        var svg = sourceSvg.cloneNode(true);
        svg.style.maxWidth = 'none';
        svg.style.height = 'auto';
        dialogCanvas.appendChild(svg);
        viewport.appendChild(dialogCanvas);
        panel.appendChild(header);
        panel.appendChild(viewport);
        overlay.appendChild(panel);
        doc.body.appendChild(overlay);

        var scale = 1;
        var closed = false;
        var drag = null;

        function applyScale(next, anchorX, anchorY) {
          var oldWidth = Math.max(1, size.width * scale);
          var oldHeight = Math.max(1, size.height * scale);
          var viewWidth = viewport.clientWidth || win.innerWidth || 1200;
          var viewHeight = viewport.clientHeight || win.innerHeight || 760;
          var x = anchorX == null ? viewWidth / 2 : anchorX;
          var y = anchorY == null ? viewHeight / 2 : anchorY;
          var contentX = (viewport.scrollLeft + x) / oldWidth;
          var contentY = (viewport.scrollTop + y) / oldHeight;
          scale = clamp(next, MIN_ZOOM, MAX_ZOOM);
          var scaledWidth = Math.round(size.width * scale);
          var scaledHeight = Math.round(size.height * scale);
          svg.style.width = scaledWidth + 'px';
          svg.style.height = scaledHeight + 'px';
          dialogCanvas.style.width = Math.max(scaledWidth, viewWidth - 32) + 'px';
          dialogCanvas.style.height = Math.max(scaledHeight, viewHeight - 32) + 'px';
          percent.textContent = Math.round(scale * 100) + '%';
          viewport.scrollLeft = Math.max(0, contentX * scaledWidth - x);
          viewport.scrollTop = Math.max(0, contentY * scaledHeight - y);
        }

        function fitScale() {
          var viewWidth = viewport.clientWidth || win.innerWidth || 1200;
          var viewHeight = viewport.clientHeight || win.innerHeight || 760;
          return clamp(Math.min((viewWidth - 48) / size.width,
            (viewHeight - 48) / size.height), MIN_ZOOM, MAX_ZOOM);
        }
        function readableScale() { return Math.max(MIN_READABLE, Math.min(1, fitScale())); }
        function onKey(e) {
          if (win.CommandPalette && win.CommandPalette.isOpen && win.CommandPalette.isOpen()) return;
          if (e.key !== 'Escape' || doc.fullscreenElement) return;
          e.preventDefault();
          closeViewer();
        }
        function onFullscreenChange() {
          fullscreen.textContent = doc.fullscreenElement === panel ? '\u9000\u51FA\u5168\u5C4F' : '\u5168\u5C4F';
          fullscreen.setAttribute('aria-label', doc.fullscreenElement === panel ? '\u9000\u51FA\u5168\u5C4F' : '\u5168\u5C4F\u67E5\u770B');
        }
        function stopDrag() {
          drag = null;
          viewport.classList.remove('is-dragging');
          win.removeEventListener('pointermove', onPointerMove);
          win.removeEventListener('pointerup', stopDrag);
          win.removeEventListener('pointercancel', stopDrag);
        }
        function onPointerMove(e) {
          if (!drag) return;
          viewport.scrollLeft = drag.left - (e.clientX - drag.x);
          viewport.scrollTop = drag.top - (e.clientY - drag.y);
        }
        function closeViewer() {
          if (closed) return;
          closed = true;
          stopDrag();
          doc.removeEventListener('keydown', onKey, true);
          doc.removeEventListener('fullscreenchange', onFullscreenChange);
          if (doc.fullscreenElement === panel && doc.exitFullscreen) {
            try { doc.exitFullscreen(); } catch (_) { /* best effort */ }
          }
          overlay.remove();
          embed.__fpMermaidClose = null;
          if (doc.__fpActiveMermaidDialogClose === closeViewer) doc.__fpActiveMermaidDialogClose = null;
        }

        minus.addEventListener('click', function () { applyScale(scale / 1.2); });
        plus.addEventListener('click', function () { applyScale(scale * 1.2); });
        fitButton.addEventListener('click', function () { applyScale(fitScale()); });
        actual.addEventListener('click', function () { applyScale(1); });
        exportButton.addEventListener('click', function () {
          exportButton.disabled = true;
          exportButton.textContent = '\u4E0B\u8F7D\u4E2D\u2026';
          renderPng(sourceSvg, size)
            .then(function (blob) {
              downloadPng(blob,
                embed.getAttribute('data-fp-export-name') || 'mermaid-diagram.png');
            })
            .catch(function (err) {
              win.alert('\u4E0B\u8F7D\u5931\u8D25: ' + (err && err.message ? err.message : err));
            })
            .finally(function () {
              exportButton.disabled = false;
              exportButton.textContent = '\u4E0B\u8F7D';
            });
        });
        copyButton.addEventListener('click', function () {
          copyButton.disabled = true;
          copyButton.textContent = '\u590D\u5236\u4E2D\u2026';
          copyPng(renderPng(sourceSvg, size))
            .then(function () {
              copyButton.textContent = '\u5DF2\u590D\u5236';
              win.setTimeout(function () { copyButton.textContent = '\u590D\u5236'; }, 1200);
            })
            .catch(function (err) {
              copyButton.textContent = '\u590D\u5236';
              win.alert('\u590D\u5236\u5931\u8D25: ' + (err && err.message ? err.message : err));
            })
            .finally(function () { copyButton.disabled = false; });
        });
        fullscreen.addEventListener('click', function () {
          if (doc.fullscreenElement === panel) {
            if (doc.exitFullscreen) doc.exitFullscreen();
          } else if (panel.requestFullscreen) panel.requestFullscreen();
        });
        closeButton.addEventListener('click', closeViewer);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeViewer(); });
        viewport.addEventListener('pointerdown', function (e) {
          if (e.button != null && e.button !== 0) return;
          drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
          viewport.classList.add('is-dragging');
          win.addEventListener('pointermove', onPointerMove);
          win.addEventListener('pointerup', stopDrag);
          win.addEventListener('pointercancel', stopDrag);
        });
        viewport.addEventListener('wheel', function (e) {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          var rect = viewport.getBoundingClientRect();
          applyScale(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12),
            e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });
        doc.addEventListener('keydown', onKey, true);
        doc.addEventListener('fullscreenchange', onFullscreenChange);
        doc.__fpActiveMermaidDialogClose = closeViewer;
        embed.__fpMermaidClose = closeViewer;
        applyScale(readableScale());
        closeButton.focus();
      }

      function openFromGraph(e) {
        if (e && e.target && e.target.closest && e.target.closest('a')) return;
        openViewer();
      }
      openButton.addEventListener('click', openViewer);
      canvas.addEventListener('click', openFromGraph);
      if (win.ResizeObserver) {
        observer = new win.ResizeObserver(layoutInline);
        observer.observe(scroll);
      }
      layoutInline();
      if (win.requestAnimationFrame) win.requestAnimationFrame(layoutInline);
      embed.__fpMermaidCleanup = function () {
        if (observer) observer.disconnect();
        if (embed.__fpMermaidClose) embed.__fpMermaidClose();
        openButton.removeEventListener('click', openViewer);
        canvas.removeEventListener('click', openFromGraph);
        embed.__fpMermaidBound = false;
      };
    });
  }

  function _disposeMermaid(root) {
    if (!root || !root.querySelectorAll) return;
    var embeds = Array.prototype.slice.call(root.querySelectorAll('.fp-mermaid-embed'));
    if (root.matches && root.matches('.fp-mermaid-embed')) embeds.unshift(root);
    embeds.forEach(function (embed) {
      if (embed.__fpMermaidCleanup) embed.__fpMermaidCleanup();
    });
  }

  function _disposePreview(root) {
    _disposeMermaid(root);
    if (!root) return;
    root.__fpRender = null;
    root.__fpMarkdownLive = false;
    root.__fpCodeLive = false;
    root.querySelectorAll('.fp-embedded').forEach(function (box) { box.__fpRender = null; });
    root.querySelectorAll('.fp-md-wrap').forEach(function (wrap) { wrap.__fpMarkdownLive = false; });
    root.querySelectorAll('.fp-code-wrap').forEach(function (wrap) { wrap.__fpCodeLive = false; });
    root.querySelectorAll('.fp-image-wrap').forEach(function (wrap) {
      if (typeof wrap.__fpImageDispose === 'function') wrap.__fpImageDispose();
    });
    root.querySelectorAll('iframe[data-fp-blob-url]').forEach(function (frame) {
      window.URL.revokeObjectURL(frame.getAttribute('data-fp-blob-url'));
      frame.removeAttribute('data-fp-blob-url');
    });
  }

  function _refreshPresentationTheme() {
    if (!window.PanelPresentation) return;
    // Inactive file tabs live off-DOM; load also syncs their eventual placement.
    window.PanelPresentation.sync(_overlay);
    _dockTabs.forEach(function (tab) {
      if (!_overlay || !_overlay.contains(tab.modal)) window.PanelPresentation.sync(tab.modal);
    });
  }

  function _refreshMermaidTheme() {
    if (!window.mermaid || typeof window.mermaid.render !== 'function') {
      return Promise.resolve([]);
    }
    var embeds = Array.prototype.slice.call(document.querySelectorAll('.fp-mermaid-embed'));
    if (embeds.length === 0) return Promise.resolve([]);

    var generation = ++_mermaidThemeGeneration;
    _initializeMermaidTheme();
    return Promise.all(embeds.map(function (container, i) {
      var code = container.__fpMermaidSource;
      if (!code) return Promise.resolve(null);
      var id = 'fp-mmd-theme-' + Date.now() + '-' + generation + '-' + i;
      return window.mermaid.render(id, code)
        .then(function (res) {
          if (generation !== _mermaidThemeGeneration || !container.isConnected) return null;
          _disposeMermaid(container);
          container.className = 'mermaid';
          container.removeAttribute('data-fp-width');
          container.removeAttribute('data-fp-height');
          container.innerHTML = res.svg;
          container.__fpMermaidSource = code;
          _prepareMermaid(container);
          _installMermaidInteractions(container);
          return container;
        })
        .catch(function () { return null; });
    }));
  }

  function _mermaidStandaloneScript() {
    return '<script>(' + _installMermaidInteractions.toString() + ')(document);<\/script>';
  }

  // Snapshot the theme vars the main window currently has applied (Theme.apply
  // writes these onto documentElement), so the standalone tab follows whatever
  // theme — including light themes — the user has switched to.
  function _rootVars() {
    var keys = ['--bg-primary', '--bg-secondary', '--bg-card', '--bg-deep', '--bg-hover', '--border-subtle',
      '--text-primary', '--text-secondary', '--text-muted', '--accent-blue', '--accent-red', '--accent-green', '--accent-purple',
      '--fp-panel', '--fp-bg', '--fp-hover', '--fp-text', '--fp-muted', '--fp-accent', '--fp-line'];
    var rootStyles = window.getComputedStyle(document.documentElement);
    var cs = _overlay ? window.getComputedStyle(_overlay) : rootStyles;
    var out = ':root{';
    keys.forEach(function (k) {
      var v = (cs.getPropertyValue(k) || rootStyles.getPropertyValue(k) || '').trim();
      if (v) out += k + ':' + v + ';';
    });
    return out + '}';
  }

  // Inline theme so the standalone tab matches the in-modal preview (the new
  // document has none of the page's stylesheets). Mirrors the .fp-* rules in
  // public/css/style.css; keep them in sync.
  function _standaloneCss() {
    return [
      ':root{--fp-panel:var(--bg-card);--fp-bg:var(--bg-primary);--fp-hover:var(--bg-hover);--fp-text:var(--text-primary);--fp-muted:var(--text-secondary);--fp-accent:var(--accent-blue);--fp-line:var(--border-subtle);}',
      _rootVars(),
      'html,body{margin:0;background:var(--bg-card);color:var(--text-primary);',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}",
      '.fp-code-wrap,.fp-md-wrap{height:auto;min-height:100vh;box-sizing:border-box;}',
      ".fp-code-wrap pre{margin:0;padding:14px;font-size:0.82rem;line-height:1.5;font-family:'JetBrains Mono',monospace;tab-size:4;display:flex;align-items:flex-start;}",
      '.fp-code-wrap .fp-line-numbers{flex:0 0 auto;padding-right:14px;border-right:1px solid var(--border-subtle);margin-right:14px;text-align:right;color:var(--text-muted);user-select:none;white-space:pre;}',
      '.fp-code-wrap pre > code{flex:1 1 auto;min-width:0;white-space:pre;overflow-x:auto;}',
      '.fp-code-wrap pre > code.hljs{padding:0;}',
      '.fp-md-wrap{padding:20px 28px;font-size:0.9rem;line-height:1.7;color:var(--text-primary);}',
      '.fp-md-wrap h1,.fp-md-wrap h2,.fp-md-wrap h3{margin:1em 0 0.5em;}',
      '.fp-md-wrap h1{font-size:1.5rem;border-bottom:1px solid var(--border-subtle);padding-bottom:6px;}',
      '.fp-md-wrap h2{font-size:1.25rem;}.fp-md-wrap h3{font-size:1.1rem;}',
      '.fp-md-wrap pre{background:var(--bg-primary);border-radius:6px;padding:12px;overflow-x:auto;}',
      ".fp-md-wrap code{font-family:'JetBrains Mono',monospace;font-size:0.82rem;}",
      '.fp-md-wrap :not(pre) > code{background:var(--bg-primary);padding:2px 5px;border-radius:3px;}',
      '.fp-md-wrap img,.fp-md-wrap video{max-width:100%;border-radius:6px;}.fp-md-wrap video{display:block;margin:12px 0;}',
      '.fp-md-wrap table{border-collapse:collapse;width:100%;margin:1em 0;}',
      '.fp-md-wrap th,.fp-md-wrap td{border:1px solid var(--border-subtle);padding:6px 10px;text-align:left;}',
      '.fp-md-wrap th{background:var(--bg-primary);}',
      '.fp-md-wrap blockquote{border-left:3px solid var(--accent-blue);margin:1em 0;padding:4px 16px;color:var(--text-muted);}',
      '.fp-md-wrap a{color:var(--accent-blue);}',
      '.fp-md-wrap li.fp-task-item{list-style:none;}.fp-md-wrap li.fp-task-item>ul,.fp-md-wrap li.fp-task-item>ol{margin:.25em 0 .4em;padding-inline-start:1.8em;}.fp-md-wrap .fp-task-checkbox{width:1em;height:1em;margin:0 .48em 0 0;vertical-align:-.1em;accent-color:var(--accent-blue);}.fp-md-wrap .fp-task-checkbox:disabled{opacity:1;}',
      '.fp-md-wrap .fp-frontmatter{margin:0 0 1.2em;padding:10px 14px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-primary);font-size:0.84rem;}',
      '.fp-md-wrap .fp-fm-row{display:flex;gap:10px;padding:3px 0;align-items:baseline;}',
      '.fp-md-wrap .fp-fm-row+.fp-fm-row{border-top:1px solid var(--border-subtle);}',
      '.fp-md-wrap .fp-fm-key{flex:0 0 110px;color:var(--text-muted);font-weight:600;}',
      '.fp-md-wrap .fp-fm-val{flex:1 1 auto;min-width:0;word-break:break-word;}',
      '.fp-md-wrap mark.fp-hl{background:rgba(255,213,0,0.28);color:inherit;padding:0 2px;border-radius:2px;}',
      '.fp-md-wrap .fp-wikilink{color:var(--accent-blue);border-bottom:1px dashed var(--accent-blue);}',
      '.fp-md-wrap .fp-embed{color:var(--text-muted);font-style:italic;}',
      '.fp-md-wrap .fp-embed-img{max-width:100%;border-radius:6px;}',
      '.fp-md-wrap .fp-tag{display:inline-block;background:var(--bg-primary);color:var(--accent-blue);font-size:0.78rem;padding:0 7px;border-radius:10px;border:1px solid var(--border-subtle);line-height:1.5;white-space:nowrap;}',
      '.fp-md-wrap .fp-callout{border-left:4px solid var(--accent-blue);border-radius:6px;margin:1em 0;padding:10px 16px;color:var(--text-primary);background:color-mix(in srgb,var(--accent-blue) 10%,transparent);}',
      '.fp-md-wrap .fp-callout>p:last-child{margin-bottom:0;}',
      '.fp-md-wrap .fp-callout-title{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px;}',
      '.fp-md-wrap .fp-callout-tip,.fp-md-wrap .fp-callout-success,.fp-md-wrap .fp-callout-done{border-left-color:#3fb950;background:color-mix(in srgb,#3fb950 10%,transparent);}',
      '.fp-md-wrap .fp-callout-warning,.fp-md-wrap .fp-callout-caution,.fp-md-wrap .fp-callout-important{border-left-color:#d29922;background:color-mix(in srgb,#d29922 12%,transparent);}',
      '.fp-md-wrap .fp-callout-danger,.fp-md-wrap .fp-callout-error,.fp-md-wrap .fp-callout-bug,.fp-md-wrap .fp-callout-failure{border-left-color:#f85149;background:color-mix(in srgb,#f85149 12%,transparent);}',
      '.fp-md-wrap .fp-callout-question,.fp-md-wrap .fp-callout-help,.fp-md-wrap .fp-callout-example{border-left-color:#a371f7;background:color-mix(in srgb,#a371f7 12%,transparent);}',
      '.fp-md-wrap .katex-display{overflow-x:auto;padding:4px 0;}',
      '.fp-mermaid-embed{position:relative;margin:1.2em 0;border:1px solid var(--border-subtle);border-radius:10px;background:var(--bg-primary);overflow:hidden;}',
      '.fp-mermaid-scroll{overflow:auto;padding:16px;scrollbar-gutter:stable;}',
      '.fp-mermaid-canvas{display:flex;width:max-content;min-width:100%;justify-content:center;align-items:flex-start;cursor:zoom-in;}',
      '.fp-mermaid-embed svg{display:block;max-width:none!important;height:auto;flex:none;}',
      '.fp-mermaid-open{position:absolute;top:8px;right:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-card);color:var(--text-secondary);cursor:pointer;opacity:.72;}',
      '.fp-mermaid-open:hover{opacity:1;color:var(--text-primary);}.fp-mermaid-open svg{width:17px;height:17px;}',
      '.fp-mermaid-dialog{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:2vh 2vw;background:rgba(0,0,0,.72);}',
      '.fp-mermaid-dialog-panel{width:96vw;height:94vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-card);box-shadow:0 24px 80px rgba(0,0,0,.58);}',
      '.fp-mermaid-dialog-panel:fullscreen{width:100vw;height:100vh;border:0;border-radius:0;}',
      '.fp-mermaid-dialog-header{display:flex;align-items:center;gap:14px;min-height:54px;padding:8px 10px 8px 16px;border-bottom:1px solid var(--border-subtle);background:var(--bg-primary);}',
      '.fp-mermaid-dialog-title{flex:1;min-width:0;font-size:.9rem;}.fp-mermaid-dialog-tools{display:flex;align-items:center;gap:4px;}',
      '.fp-mermaid-tool{height:34px;min-width:34px;padding:0 10px;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-card);color:var(--text-secondary);cursor:pointer;font-size:.8rem;}',
      '.fp-mermaid-tool:hover{color:var(--text-primary);background:var(--bg-secondary);}.fp-mermaid-percent{min-width:58px;color:var(--text-primary);cursor:default;}',
      '.fp-mermaid-close{font-size:1.2rem;}.fp-mermaid-dialog-viewport{flex:1;overflow:auto;padding:16px;cursor:grab;outline:none;touch-action:none;background:var(--bg-primary);}',
      '.fp-mermaid-dialog-viewport.is-dragging{cursor:grabbing;user-select:none;}.fp-mermaid-dialog-canvas{display:flex;align-items:center;justify-content:center;min-width:100%;min-height:100%;}.fp-mermaid-dialog-canvas svg{display:block;max-width:none!important;flex:none;}',
      '.fp-xlsx-wrap{min-height:100vh;}',
      '.fp-xlsx-tabs{display:flex;gap:2px;padding:6px 8px 0;overflow-x:auto;border-bottom:1px solid var(--border-subtle);background:var(--bg-primary);position:sticky;top:0;}',
      '.fp-xlsx-tab{flex:0 0 auto;padding:5px 12px;border:1px solid var(--border-subtle);border-bottom:none;border-radius:6px 6px 0 0;cursor:pointer;background:transparent;color:var(--text-muted);font-size:0.82rem;white-space:nowrap;}',
      '.fp-xlsx-tab.active{color:var(--text-primary);background:var(--bg-card);}',
      '.fp-xlsx-pane{display:none;}.fp-xlsx-pane.active{display:block;}',
      '.fp-xlsx-table{border-collapse:collapse;font-size:0.82rem;background:var(--bg-card);color:var(--text-primary);}',
      '.fp-xlsx-table td{border:1px solid var(--border-subtle);padding:3px 8px;white-space:nowrap;max-width:480px;overflow:hidden;text-overflow:ellipsis;vertical-align:top;}',
      '.fp-fs-btn{position:fixed;top:12px;right:12px;z-index:9999;width:34px;height:34px;',
      'display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;',
      'background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-subtle);',
      'border-radius:6px;cursor:pointer;opacity:0.5;transition:opacity 0.15s;}',
      '.fp-fs-btn:hover{opacity:1;}',
      ':fullscreen .fp-md-wrap,:fullscreen .fp-code-wrap{min-height:100vh;}',
      // Palette overrides mirror file-preview-workspace.css for portable snapshots.
      "html,body{background:var(--fp-panel);color:var(--fp-text);}",
      ".fp-md-wrap{background:transparent;color:var(--fp-text);}",
      ".fp-md-wrap :is(h1,h2,h3,h4,h5,h6){color:var(--fp-text);}",
      ".fp-md-wrap a{color:var(--fp-accent);}",
      ".fp-md-wrap pre{background:color-mix(in srgb,var(--fp-bg) 80%,var(--fp-panel));box-shadow:inset 0 0 0 1px var(--fp-line);}",
      ".fp-md-wrap :not(pre)>code{background:color-mix(in srgb,var(--fp-bg) 65%,var(--fp-panel));color:var(--fp-text);box-shadow:inset 0 0 0 1px var(--fp-line);}",
      ".fp-md-wrap th,.fp-md-wrap td{border-color:var(--fp-line);}",
      ".fp-md-wrap th{background:color-mix(in srgb,var(--fp-bg) 72%,var(--fp-panel));color:var(--fp-text);}",
      ".fp-md-wrap tbody tr:hover{background:color-mix(in srgb,var(--fp-hover) 35%,var(--fp-panel));}",
      ".fp-md-wrap blockquote{border-color:var(--fp-accent);color:color-mix(in srgb,var(--fp-text) 78%,var(--fp-muted));}",
      ".fp-code-wrap{background:var(--fp-panel);color:var(--fp-text);}",
      ".fp-code-wrap .fp-line-numbers{color:var(--fp-muted);border-color:var(--fp-line);}",
      ".fp-mermaid-dialog,",
      ":is(.fp-md-wrap, .fp-code-wrap) .hljs { background: transparent; color: var(--fp-text); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre :is(.hljs-comment, .hljs-quote, .hljs-code, .hljs-formula) { color: var(--fp-muted); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre :is(.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type, .hljs-built_in, .hljs-doctag) { color: var(--accent-purple, var(--fp-accent)); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre :is(.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-bullet, .hljs-template-tag, .hljs-template-variable) { color: var(--accent-green, var(--fp-accent)); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre :is(.hljs-title, .hljs-section, .hljs-selector-id, .hljs-selector-class, .hljs-selector-pseudo, .hljs-name, .hljs-link, .hljs-meta) { color: var(--fp-accent); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre :is(.hljs-number, .hljs-attr, .hljs-attribute, .hljs-selector-attr, .hljs-variable, .hljs-params, .hljs-subst, .hljs-operator) { color: var(--fp-text); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre .hljs-addition { color: var(--accent-green, var(--fp-text)); background: color-mix(in srgb, var(--accent-green, var(--fp-text)) 12%, transparent); }",
      ":is(.fp-md-wrap, .fp-code-wrap) pre .hljs-deletion { color: var(--accent-red, var(--fp-text)); background: color-mix(in srgb, var(--accent-red, var(--fp-text)) 12%, transparent); }",
      ".fp-mermaid-embed { background: color-mix(in srgb, var(--fp-panel) 94%, var(--fp-bg)); border-color: var(--fp-line); }",
      ".fp-mermaid-dialog { background: color-mix(in srgb, var(--fp-bg) 70%, transparent); }",
      ".fp-mermaid-dialog-panel, .fp-mermaid-dialog-header { background: var(--fp-panel); border-color: var(--fp-line); }",
      ".fp-mermaid-dialog-viewport { background: color-mix(in srgb, var(--fp-panel) 88%, var(--fp-bg)); }",
      ".fp-mermaid-open, .fp-mermaid-tool { background: var(--fp-panel); color: var(--fp-muted); border-color: var(--fp-line); }",
      ".fp-mermaid-dialog-title, .fp-mermaid-percent, .fp-mermaid-close { color: var(--fp-text); }",
      ".fp-mermaid-open:hover, .fp-mermaid-tool:hover { background: var(--fp-hover); color: var(--fp-text); border-color: var(--fp-line); }",
      ".fp-mermaid-open:focus-visible, .fp-mermaid-tool:focus-visible { outline-color: var(--fp-accent); }",
      ".fp-mermaid-dialog-viewport:focus-visible { box-shadow: inset 0 0 0 2px var(--fp-accent); }",
      ".fp-mermaid-close:hover { color: var(--accent-red); }",
    ].join('');
  }

  // Floating fullscreen toggle injected into the standalone tab. The inline
  // script runs because blob: text/html documents execute their own scripts.
  function _fullscreenWidget() {
    return '<button class="fp-fs-btn" id="fpFs" title="全屏 / Fullscreen" aria-label="Toggle fullscreen">⛶</button>'
      + '<script>(function(){var b=document.getElementById("fpFs");if(!b)return;'
      + 'function sync(){b.textContent=document.fullscreenElement?"\\u00d7":"\\u26f6";}'
      + 'b.addEventListener("click",function(){'
      + 'if(document.fullscreenElement){document.exitFullscreen();}'
      + 'else{var el=document.documentElement;if(el.requestFullscreen)el.requestFullscreen();}});'
      + 'document.addEventListener("fullscreenchange",sync);})();<\/script>';
  }

  // Re-wire xlsx sheet tabs in the standalone tab — the modal's addEventListener
  // handlers don't survive outerHTML serialization, so delegate by index.
  function _xlsxTabScript() {
    return '<script>document.addEventListener("click",function(e){'
      + 'var t=e.target.closest&&e.target.closest(".fp-xlsx-tab");if(!t)return;'
      + 'var w=t.closest(".fp-xlsx-wrap");if(!w)return;'
      + 'var tabs=w.querySelectorAll(".fp-xlsx-tab"),panes=w.querySelectorAll(".fp-xlsx-pane");'
      + 'var i=Array.prototype.indexOf.call(tabs,t);'
      + 'for(var k=0;k<tabs.length;k++){tabs[k].classList.remove("active");}'
      + 'for(var j=0;j<panes.length;j++){panes[j].classList.remove("active");}'
      + 't.classList.add("active");if(panes[i])panes[i].classList.add("active");'
      + '});<\/script>';
  }

  function _escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Inline <img src="/api/files/raw…"> as data URIs on a CLONED subtree so the
  // standalone snapshot is fully self-contained — no auth token, no live file
  // access. Returns a promise; failures leave the original src (broken image is
  // better than a failed export).
  function _inlineAssets(root) {
    var imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var jobs = Array.prototype.map.call(imgs, function (img) {
      var src = img.getAttribute('src') || '';
      if (src.indexOf('/api/files/raw') < 0 || src.indexOf('data:') === 0) return Promise.resolve();
      return fetch(src, { headers: headers, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (blob) {
          return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onload = function () { img.setAttribute('src', fr.result); resolve(); };
            fr.onerror = function () { resolve(); };
            fr.readAsDataURL(blob);
          });
        })
        .catch(function () { /* keep original src */ });
    });
    return Promise.all(jobs);
  }

  // Build a self-contained HTML document from the current rendered preview.
  // Resolves to { html, filename } or null when there's nothing to snapshot
  // (e.g. a binary file). Shared by "open in new tab", "export HTML", "share".
  function _buildStandaloneDoc() {
    if (!_currentFile || _currentFile.isDirectory) return Promise.resolve(null);
    if (_currentFile.isHtml) {
      // Keep scripts isolated in exports and shares as well as in the panel.
      var frame = _overlay && _overlay.querySelector('.fp-html-wrap iframe');
      if (!frame) return Promise.resolve(null);
      var snapshot = window.PanelPresentation ? window.PanelPresentation.snapshot(frame) : frame.srcdoc;
      frame = frame.cloneNode(true);
      frame.srcdoc = snapshot;
      frame.hidden = false;
      return Promise.resolve({
        html: '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<title>' + _escapeHtml(_currentFile.filename || 'preview') + '</title>'
          + '<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>'
          + frame.outerHTML,
        filename: _currentFile.filename,
      });
    }
    var rendered = _overlay && _overlay.querySelector('.fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
    if (!rendered) return Promise.resolve(null);
    // Always clone: we strip interactive bits and inline images without
    // mutating what's on screen.
    var capture = rendered.cloneNode(true);
    var sheetCopies = capture.querySelectorAll('.fp-xlsx-pane');
    rendered.querySelectorAll('.fp-xlsx-pane').forEach(function (pane, i) {
      if (!sheetCopies[i].hasChildNodes() && pane.__fpRenderSheetInto) pane.__fpRenderSheetInto(sheetCopies[i]);
    });
    capture.querySelectorAll('.fp-error-download').forEach(function (control) {
      control.replaceWith(document.createTextNode('请在文件预览中下载完整文件。'));
    });
    var pages = capture.querySelector('.fp-code-pages');
    if (pages && _currentFile.rawContent != null) {
      // Snapshots and rich copy need the whole file, not the visible segment.
      pages.remove();
      capture.querySelector('pre > code').textContent = _currentFile.rawContent;
      capture.querySelector('.fp-line-numbers').remove();
    }
    var surfaces = capture.querySelectorAll('[data-fp-surface]');
    rendered.querySelectorAll('[data-fp-surface]').forEach(function (surface, index) {
      surfaces[index].style.fillOpacity = window.getComputedStyle(surface).fillOpacity || '1';
    });
    // Local video streams need live authentication and can be very large.
    // Keep their label in snapshots without exposing a token or local path.
    capture.querySelectorAll('video[src*="/api/files/raw?"]').forEach(function (video) {
      var label = document.createElement('span');
      label.textContent = (video.getAttribute('aria-label') || '视频') + '（请在文件预览中播放）';
      video.replaceWith(label);
    });
    capture.querySelectorAll('.fp-colfilter-btn, .fp-table-search').forEach(function (b) { b.remove(); });
    capture.querySelectorAll('.fp-task-checkbox').forEach(function (checkbox) {
      checkbox.disabled = true;
      checkbox.setAttribute('aria-disabled', 'true');
    });
    capture.querySelectorAll('li.fp-task-item').forEach(function (item) {
      item.removeAttribute('data-fp-task-line');
      item.removeAttribute('data-fp-task-expected');
    });
    var base = (_currentFile.filename || 'preview').replace(/\.[^.]+$/, '');
    return _inlineAssets(capture).then(function () {
      var title = _escapeHtml(_currentFile.filename || 'preview');
      var doc = '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>' + title + '</title>'
        + '<link rel="stylesheet" href="' + CDN.hljsCss + '">'
        + '<link rel="stylesheet" href="' + CDN.katexCss + '">'
        + '<style>' + _standaloneCss() + '</style></head><body>'
        + _fullscreenWidget()
        + capture.outerHTML
        + _xlsxTabScript() + _mermaidStandaloneScript() + '</body></html>';
      return { html: doc, filename: base + '.html' };
    });
  }

  var MAX_NATIVE_BROWSER_BINARY_BYTES = 32 * 1024 * 1024;

  function _nativeBrowserHandler() {
    try {
      var handlers = window.webkit && window.webkit.messageHandlers;
      var handler = handlers && (handlers.anymuxOpenBrowser || handlers.tmuxPanelOpenBrowser);
      return handler && typeof handler.postMessage === 'function' ? handler : null;
    } catch (_) {
      return null;
    }
  }

  function _blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var Reader = window.FileReader || FileReader;
      var fr = new Reader();
      fr.onload = function () {
        var result = typeof fr.result === 'string' ? fr.result : '';
        var comma = result.indexOf(',');
        if (comma < 0) return reject(new Error('无法编码文件内容'));
        resolve(result.slice(comma + 1));
      };
      fr.onerror = function () { reject(fr.error || new Error('读取文件失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function _openInNativeBrowser(browserHandler) {
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var filename = _currentFile.filename || 'preview';
    var job;

    if (_currentFile.isPdf) {
      job = fetch(_currentFile.rawUrl, { headers: headers, cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then(function (blob) {
          if (blob.size > MAX_NATIVE_BROWSER_BINARY_BYTES) {
            throw new Error('文件过大（超过 32MB），请下载原文件');
          }
          return _blobToBase64(blob);
        })
        .then(function (dataBase64) {
          browserHandler.postMessage({ dataBase64: dataBase64, filename: filename });
        });
    } else if (_currentFile.isText || _currentFile.isMarkdown || _currentFile.isXlsx) {
      var rendered = _overlay && _overlay.querySelector('.fp-html-wrap, .fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
      if (rendered) {
        job = _buildStandaloneDoc().then(function (out) {
          if (out) {
            browserHandler.postMessage({
              html: out.html,
              filename: out.filename || filename,
            });
          }
        });
      } else if (_currentFile.rawContent != null) {
        var rawHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'
          + _escapeHtml(filename)
          + '</title><style>body{margin:0;padding:16px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;}</style></head><body><pre>'
          + _escapeHtml(_currentFile.rawContent) + '</pre></body></html>';
        browserHandler.postMessage({ html: rawHtml, filename: filename + '.html' });
        job = Promise.resolve();
      } else if (_currentFile.rawUrl) {
        browserHandler.postMessage({ url: _currentFile.rawUrl });
        job = Promise.resolve();
      }
    } else if (_currentFile.isImage) {
      job = fetch(_currentFile.rawUrl, { headers: headers, cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then(function (blob) {
          if (blob.size > MAX_NATIVE_BROWSER_BINARY_BYTES) {
            throw new Error('文件过大（超过 32MB），请下载原文件');
          }
          return _blobToBase64(blob);
        })
        .then(function (dataBase64) {
          browserHandler.postMessage({ dataBase64: dataBase64, filename: filename });
        });
    } else if (_currentFile.rawUrl) {
      browserHandler.postMessage({ url: _currentFile.rawUrl });
      job = Promise.resolve();
    }

    return Promise.resolve(job).catch(function (err) {
      _notifyFailure('在浏览器中打开失败：' + (err && err.message ? err.message : err));
    });
  }

  function _openNewTab() {
    if (!_currentFile || _currentFile.isDirectory) return;
    var browserHandler = _nativeBrowserHandler();
    if (browserHandler) {
      _openInNativeBrowser(browserHandler);
      return;
    }
    if (_currentFile.isPdf) {
      var pdf = _overlay && _overlay.querySelector('.fp-pdf-wrap iframe');
      if (pdf) window.open(pdf.src, '_blank');
      return;
    }
    var nativeWindow = null;
    try {
      var handlers = window.webkit && window.webkit.messageHandlers;
      nativeWindow = handlers && (handlers.anymuxOpenWindow || handlers.tmuxPanelOpenWindow);
    } catch (_) { /* browser path below */ }
    if (_currentFile.isText || _currentFile.isMarkdown || _currentFile.isXlsx) {
      // Open the tab synchronously (popup blockers require a user-gesture-time
      // window.open), then fill it once the self-contained doc is built.
      var rendered = _overlay && _overlay.querySelector('.fp-html-wrap, .fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
      if (rendered) {
        if (nativeWindow && typeof nativeWindow.postMessage === 'function') {
          _buildStandaloneDoc().then(function (out) {
            if (out) nativeWindow.postMessage({
              html: out.html, title: _currentFile.filename || 'Preview', width: 1100, height: 760,
            });
          });
          return;
        }
        var win = window.open('', '_blank');
        _buildStandaloneDoc().then(function (out) {
          if (!out) { if (win) win.close(); return; }
          var blobUrl = URL.createObjectURL(new Blob([out.html], { type: 'text/html;charset=utf-8' }));
          if (win) { win.location = blobUrl; } else { window.open(blobUrl, '_blank'); }
        });
        return;
      }
      if (nativeWindow && typeof nativeWindow.postMessage === 'function') {
        nativeWindow.postMessage({
          url: _currentFile.rawUrl, title: _currentFile.filename || 'Preview', width: 1100, height: 760,
        });
        return;
      }
      // Not rendered yet — xlsx has no text content, hand off the raw file.
      if (_currentFile.isXlsx) { window.open(_currentFile.rawUrl, '_blank'); return; }
      // Otherwise fall back to raw text (still UTF-8 to avoid 乱码).
      var blob = new Blob([_currentFile.rawContent || ''], { type: 'text/plain;charset=utf-8' });
      window.open(URL.createObjectURL(blob), '_blank');
    } else {
      window.open(_currentFile.rawUrl, '_blank');
    }
  }

  // Download the rendered preview as a self-contained .html file.
  function _exportHtml() {
    _buildStandaloneDoc().then(function (out) {
      if (!out) { alert('当前文件无法导出渲染结果'); return; }
      var blobUrl = URL.createObjectURL(new Blob([out.html], { type: 'text/html;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = blobUrl; a.download = out.filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
    }).catch(function (err) {
      alert('导出失败: ' + (err && err.message ? err.message : err));
    });
  }

  // --- Share link (server-stored snapshot with expiry) ---

  var _HOUR = 3600 * 1000, _DAY = 24 * _HOUR, _MAX_TTL = 90 * _DAY;

  function _shareApi(method, pathSuffix, body) {
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var opts = { method: method, headers: Object.assign({}, headers), credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('/api/share' + (pathSuffix || ''), opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.success) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  var _lanHost = null;
  var _lanHostPromise = null;
  function _ensureLanHost() {
    if (_lanHost) return Promise.resolve(_lanHost);
    if (_lanHostPromise) return _lanHostPromise;
    _lanHostPromise = fetch('/api/share/lan-host', {
      headers: typeof Auth !== 'undefined' ? Auth.headers() : {}, cache: 'no-store',
    }).then(function (r) { return r.json(); }).then(function (j) {
      _lanHost = (j && j.data && j.data.host) || null;
      return _lanHost;
    }).catch(function () { return null; });
    return _lanHostPromise;
  }

  // Share links are meant for other machines, so prefer the LAN address over
  // the loopback origin the panel itself is browsed on.
  function _shareOrigin() {
    if (!_lanHost) return window.location.origin;
    var port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    return window.location.protocol + '//' + _lanHost + ':' + port;
  }

  function _copyText(text) {
    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      return window.navigator.clipboard.writeText(text).catch(function () { _copyFallback(text); });
    }
    _copyFallback(text);
    return Promise.resolve();
  }
  function _copyFallback(text) {
    var focused = document.activeElement;
    var host = (_shareDialogClose && document.querySelector('.fp-share-box')) || document.body;
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    host.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
    if (focused && focused.isConnected) focused.focus();
  }

  function _fmtExpiry(ts) {
    try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); }
  }

  function _openShareDialog() {
    if (!_currentFile || _currentFile.isDirectory) return;
    if (_shareDialogClose) _shareDialogClose();
    var opener = document.activeElement;

    var ov = document.createElement('div');
    ov.className = 'fp-share-overlay';
    var box = document.createElement('div');
    box.className = 'fp-share-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '生成内网分享链接');
    ov.appendChild(box);

    box.innerHTML =
      '<div class="fp-share-title">生成内网分享链接</div>'
      + '<div class="fp-share-sub">把当前渲染结果冻结成一份快照,内网任何人凭链接即可查看(无需登录),到期自动失效。</div>'
      + '<div class="fp-share-row">'
      + '  <label class="fp-share-label">有效期</label>'
      + '  <select class="fp-share-select" id="fpShareTtl">'
      + '    <option value="' + _HOUR + '">1 小时</option>'
      + '    <option value="' + _DAY + '" selected>1 天</option>'
      + '    <option value="' + (7 * _DAY) + '">7 天</option>'
      + '    <option value="' + (30 * _DAY) + '">30 天</option>'
      + '    <option value="custom">自定义…</option>'
      + '  </select>'
      + '  <span class="fp-share-custom" id="fpShareCustom" style="display:none">'
      + '    <input class="fp-share-num" id="fpShareNum" type="number" min="1" value="3">'
      + '    <select class="fp-share-select" id="fpShareUnit"><option value="' + _HOUR + '">小时</option><option value="' + _DAY + '" selected>天</option></select>'
      + '  </span>'
      + '</div>'
      + '<div class="fp-share-actions">'
      + '  <button class="fp-share-btn" id="fpShareCancel">关闭</button>'
      + '  <button class="fp-share-btn fp-share-primary" id="fpShareGen">生成链接</button>'
      + '</div>'
      + '<div class="fp-share-result" id="fpShareResult" style="display:none"></div>'
      + '<div class="fp-share-listwrap"><div class="fp-share-listtitle">我的分享</div><div class="fp-share-list" id="fpShareList">加载中…</div></div>';

    document.body.appendChild(ov);

    var ttlSel = box.querySelector('#fpShareTtl');
    var customWrap = box.querySelector('#fpShareCustom');
    var numEl = box.querySelector('#fpShareNum');
    var unitEl = box.querySelector('#fpShareUnit');
    var resultEl = box.querySelector('#fpShareResult');
    var listEl = box.querySelector('#fpShareList');
    var genBtn = box.querySelector('#fpShareGen');

    function paletteOpen() {
      return window.CommandPalette && window.CommandPalette.isOpen && window.CommandPalette.isOpen();
    }
    function focusable() {
      return Array.prototype.filter.call(box.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'), function (el) {
        if (el.disabled || el.tabIndex < 0) return false;
        for (var parent = el; parent && parent !== ov; parent = parent.parentElement) {
          if (parent.hidden || window.getComputedStyle(parent).display === 'none') return false;
        }
        return true;
      });
    }
    function onKey(e) {
      if (paletteOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); closeDlg();
      } else if (e.key === 'Tab') {
        var items = focusable(), first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    function onFocus(e) {
      if (!paletteOpen() && !ov.contains(e.target)) box.querySelector('#fpShareCancel').focus();
    }
    function closeDlg(restoreFocus) {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      ov.remove();
      if (_shareDialogClose === closeDlg) _shareDialogClose = null;
      if (restoreFocus !== false && opener && opener.isConnected && !opener.disabled) opener.focus();
    }
    _shareDialogClose = closeDlg;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    box.querySelector('#fpShareCancel').addEventListener('click', function () { closeDlg(); });
    ov.addEventListener('click', function (e) { if (e.target === ov) closeDlg(); });

    ttlSel.addEventListener('change', function () {
      customWrap.style.display = ttlSel.value === 'custom' ? 'inline-flex' : 'none';
    });

    function chosenTtl() {
      var ms = ttlSel.value === 'custom'
        ? (Number(numEl.value) || 0) * (Number(unitEl.value) || _DAY)
        : Number(ttlSel.value);
      return ms;
    }

    function renderList() {
      _ensureLanHost().then(function () { return _shareApi('GET', ''); }).then(function (data) {
        var shares = (data && data.shares) || [];
        if (!shares.length) { listEl.innerHTML = '<div class="fp-share-empty">暂无有效分享</div>'; return; }
        listEl.innerHTML = '';
        shares.forEach(function (s) {
          var url = _shareOrigin() + '/s/' + s.id;
          var row = document.createElement('div');
          row.className = 'fp-share-item';
          row.innerHTML = '<div class="fp-share-item-main">'
            + '<div class="fp-share-item-name">' + _escapeHtml(s.filename) + '</div>'
            + '<div class="fp-share-item-meta">到期 ' + _escapeHtml(_fmtExpiry(s.expiresAt)) + '</div></div>'
            + '<button class="fp-share-mini" data-act="copy">复制</button>'
            + '<button class="fp-share-mini fp-share-danger" data-act="revoke">回收</button>';
          row.querySelector('[data-act="copy"]').addEventListener('click', function () {
            _copyText(url); this.textContent = '已复制'; var b = this;
            setTimeout(function () { b.textContent = '复制'; }, 1200);
          });
          row.querySelector('[data-act="revoke"]').addEventListener('click', function () {
            _shareApi('DELETE', '/' + encodeURIComponent(s.id)).then(renderList);
          });
          listEl.appendChild(row);
        });
      }).catch(function (err) {
        listEl.innerHTML = '<div class="fp-share-empty">列表加载失败: ' + _escapeHtml(err.message) + '</div>';
      });
    }

    genBtn.addEventListener('click', function () {
      var ttl = chosenTtl();
      if (!ttl || ttl <= 0) { alert('请输入有效的有效期'); return; }
      if (ttl > _MAX_TTL) { alert('有效期最长 90 天'); return; }
      genBtn.disabled = true; genBtn.textContent = '生成中…';
      _buildStandaloneDoc().then(function (out) {
        if (!out) throw new Error('当前文件无法生成快照');
        return _shareApi('POST', '', { html: out.html, filename: _currentFile.filename || 'preview', ttlMs: ttl });
      }).then(function (data) {
        return _ensureLanHost().then(function () {
          var url = _shareOrigin() + data.url;
          resultEl.style.display = 'block';
          resultEl.innerHTML = '<div class="fp-share-ok">✅ 链接已生成(到期 ' + _escapeHtml(_fmtExpiry(data.expiresAt)) + ')</div>'
            + '<div class="fp-share-linkrow"><input class="fp-share-link" id="fpShareLink" readonly value="' + _escapeHtml(url) + '">'
            + '<button class="fp-share-btn fp-share-primary" id="fpShareCopy">复制</button></div>';
          var linkInput = resultEl.querySelector('#fpShareLink');
          linkInput.focus(); linkInput.select();
          resultEl.querySelector('#fpShareCopy').addEventListener('click', function () {
            _copyText(url); this.textContent = '已复制'; var b = this;
            setTimeout(function () { b.textContent = '复制'; }, 1200);
          });
          renderList();
        });
      }).catch(function (err) {
        alert('生成失败: ' + (err && err.message ? err.message : err));
      }).finally(function () {
        genBtn.disabled = false; genBtn.textContent = '生成链接';
      });
    });

    box.querySelector('#fpShareCancel').focus();
    renderList();
  }

  // Fetch authenticated bytes from the page's origin and trigger a local
  // Blob download. Avoids handing the URL to the system download manager
  // (which on Android/iOS doesn't share the browser's TLS-trust nor cookies,
  // and fails with "请检查互联网连接状况" on self-signed certs).
  function _blobDownload(url, filename) {
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return fetch(url, { headers: headers, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename || 'download';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
      });
  }

  function _download() {
    if (!_currentFile || _currentFile.isDirectory) return;
    _blobDownload(_currentFile.rawUrl, _currentFile.filename)
      .catch(function (err) {
        alert('下载失败: ' + (err && err.message ? err.message : err));
      });
  }

  // Text files keep their content in rawContent from the /content fetch;
  // xlsx and friends have none, so the rendered view is the only source.
  function _previewPlainText() {
    if (!_currentFile) return '';
    if (_currentFile.rawContent != null) return _currentFile.rawContent;
    var rendered = _overlay && _overlay.querySelector('.fp-md-wrap, .fp-code-wrap, .fp-xlsx-wrap');
    return rendered ? (rendered.textContent || '') : '';
  }

  function _copyPlainText() {
    var text = _previewPlainText();
    if (!text) { _toast('当前文件没有可复制的文本'); return; }
    _copyText(text).then(function () { _toast('已复制全文（纯文本）'); });
  }

  // Rich copy reuses the export/share snapshot so pasting keeps headings,
  // tables, syntax colours and inline images.
  function _copyRendered() {
    _buildStandaloneDoc().then(function (out) {
      if (!out) { _toast('当前文件没有可复制的渲染结果'); return null; }
      var plain = _previewPlainText();
      var supportsRich = window.ClipboardItem && window.navigator.clipboard
        && typeof window.navigator.clipboard.write === 'function';
      if (!supportsRich) {
        if (!plain) throw new Error('当前浏览器不支持带格式复制');
        return _copyText(plain).then(function () {
          _toast('当前浏览器不支持带格式复制，已复制纯文本');
        });
      }
      return window.navigator.clipboard.write([new window.ClipboardItem({
        'text/html': new Blob([out.html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]).then(function () { _toast('已复制全文（带格式）'); });
    }).catch(function (err) {
      _toast('复制失败: ' + (err && err.message ? err.message : err));
    });
  }

  function close() {
    if (_shareDialogClose) _shareDialogClose(false);
    _closeActionMenu();
    if (_placement === 'side') {
      _closeDockTab(_activeDockTabId);
      return;
    }
    _previewGeneration++;
    _previewReady = false;
    _stopAutoRefresh();
    _pauseVideos(_overlay);
    _disposePreview(_overlay);
    if (_overlay) _overlay.remove();
    _overlay = null;
    _maximized = false;
    _placement = 'modal';
    _placementButton = null;
    _maximizeButton = null;
    _refreshButton = null;
    _currentFile = null;
    _dirContext = null;
    _currentPaneId = null;
    _currentOpenPath = null;
    if (_dockOverlay && !_dockHidden && _dockTabs.length > 0) {
      _activateDockTab(_activeDockTabId || _dockTabs[0].id);
      document.body.classList.add('fp-side-open');
      if (!_dockOverlay.classList.contains('fp-side-maximized')) {
        _syncDockOpenWidth(parseFloat(_dockOverlay.style.width) || 0);
      }
    } else if (!_dockOverlay) {
      document.body.classList.remove('fp-side-open');
      _syncDockOpenWidth(0);
    }
    _mountBlockTabs();
    var returnFocus = _modalReturnFocus;
    _modalReturnFocus = null;
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    _drainDocumentArrivals().catch(function () { /* keep the arrival for the next visit */ });
  }

  function closeModal() {
    if (_shareDialogClose) _shareDialogClose(false);
    if (_overlay && _placement !== 'side') close();
  }

  function closeDocked() {
    _destroyDock();
  }

  function _showError(body, message, absPath) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-error';
    wrap.setAttribute('role', 'alert');
    var msg = document.createElement('div');
    msg.textContent = message;
    wrap.appendChild(msg);
    if (absPath) {
      var btn = document.createElement('button');
      btn.className = 'fp-error-download';
      btn.textContent = '下载原文件';
      btn.addEventListener('click', function () {
        var _tp = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
        var url = _machine() + '/api/files/raw?path=' + encodeURIComponent(absPath)
          + (_tp ? '&' + _tp : '');
        var filename = absPath.split('/').pop();
        _blobDownload(url, filename).catch(function (err) {
          alert('下载失败: ' + (err && err.message ? err.message : err));
        });
      });
      wrap.appendChild(btn);
    }
    body.appendChild(wrap);
  }

  // Transient popup for preview feedback — failures that must never be
  // silent even when the surface is hidden or docked, and copy confirmations.
  function _toast(message) {
    try {
      if (window.AppShell && typeof window.AppShell.toast === 'function') {
        window.AppShell.toast(message);
      }
    } catch (_) { /* notification must never break previewing */ }
  }
  function _notifyFailure(message) { _toast(message); }

  // --- Renderers ---

  var VIDEO_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(?:[?#]|$)/i;

  function _pauseVideos(root) {
    if (!root) return;
    root.querySelectorAll('video').forEach(function (video) { video.pause(); });
  }

  function _createVideo(url, label) {
    var video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-label', label || '视频预览');
    video.src = url;
    video.textContent = '当前浏览器不支持视频播放。';
    video.addEventListener('error', function () {
      if (video.nextElementSibling && video.nextElementSibling.classList.contains('fp-video-error')) return;
      var message = document.createElement('span');
      message.className = 'fp-video-error';
      message.textContent = '视频加载失败或浏览器不支持此编码，请下载原文件播放。';
      video.after(message);
    });
    return video;
  }

  function _renderVideo(body, url, filename) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-video-wrap';
    wrap.appendChild(_createVideo(url, filename));
    body.appendChild(wrap);
  }

  function _renderImage(body, url, filename) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-image-wrap';

    var bar = document.createElement('div');
    bar.className = 'fp-panzoom-bar';
    var mkBtn = function (label, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fp-panzoom-btn';
      b.textContent = label;
      if (title) b.title = title;
      return b;
    };
    var zoomOutBtn = mkBtn('−', '缩小');
    var zoomPct = document.createElement('span');
    zoomPct.className = 'fp-panzoom-pct';
    zoomPct.textContent = 'Fit';
    var zoomInBtn = mkBtn('+', '放大');
    var actualBtn = mkBtn('1:1', '实际尺寸');
    var fitBtn = mkBtn('适合', '适应窗口');
    var checkerBtn = mkBtn('棋盘格', '切换透明背景棋盘格');
    var dimsSpan = document.createElement('span');
    dimsSpan.className = 'fp-panzoom-meta';

    bar.append(zoomOutBtn, zoomPct, zoomInBtn, actualBtn, fitBtn, checkerBtn);
    var isSvg = /\.svg(?:$|\?)/i.test(String(filename || url || ''));
    var svgSourceBtn = null;
    if (isSvg) {
      svgSourceBtn = mkBtn('源码', '查看 SVG 文本源码');
      bar.appendChild(svgSourceBtn);
    }
    bar.appendChild(dimsSpan);

    var stage = document.createElement('div');
    stage.className = 'fp-panzoom-stage';
    var img = document.createElement('img');
    img.src = url;
    img.alt = filename || 'Preview';
    stage.appendChild(img);

    var sourceBox = document.createElement('div');
    sourceBox.className = 'fp-svg-source';
    sourceBox.hidden = true;

    var scale = 1;
    var tx = 0;
    var ty = 0;
    var fitted = true;
    var checker = false;
    var dragging = false;
    var startX = 0;
    var startY = 0;

    function fitScale() {
      var nw = img.naturalWidth || 0;
      var nh = img.naturalHeight || 0;
      var sw = (stage.clientWidth || 320) - 24;
      var sh = (stage.clientHeight || 240) - 24;
      if (!nw || !nh || sw <= 0 || sh <= 0) return 1;
      return Math.min(1, sw / nw, sh / nh);
    }

    function applyTransform() {
      var s = fitted ? fitScale() : scale;
      zoomPct.textContent = fitted ? 'Fit' : Math.round(s * 100) + '%';
      img.style.transform = 'translate3d(' + tx.toFixed(1) + 'px, ' + ty.toFixed(1) + 'px, 0) scale(' + s.toFixed(4) + ')';
    }

    img.addEventListener('load', function () {
      if (img.naturalWidth && img.naturalHeight) {
        dimsSpan.textContent = img.naturalWidth + ' × ' + img.naturalHeight;
      }
      applyTransform();
    });

    zoomOutBtn.addEventListener('click', function () {
      fitted = false;
      scale = Math.max(0.1, (fitted ? fitScale() : scale) / 1.25);
      applyTransform();
    });
    zoomInBtn.addEventListener('click', function () {
      var base = fitted ? fitScale() : scale;
      fitted = false;
      scale = Math.min(8, base * 1.25);
      applyTransform();
    });
    actualBtn.addEventListener('click', function () {
      fitted = false;
      scale = 1;
      tx = 0;
      ty = 0;
      applyTransform();
    });
    fitBtn.addEventListener('click', function () {
      fitted = true;
      tx = 0;
      ty = 0;
      applyTransform();
    });
    checkerBtn.addEventListener('click', function () {
      checker = !checker;
      checkerBtn.classList.toggle('is-active', checker);
      stage.classList.toggle('is-checkerboard', checker);
    });

    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var base = fitted ? fitScale() : scale;
      fitted = false;
      scale = Math.max(0.1, Math.min(8, base * (e.deltaY > 0 ? 0.9 : 1.1)));
      applyTransform();
    });
    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX - tx;
      startY = e.clientY - ty;
      stage.classList.add('is-dragging');
    });
    var onMove = function (e) {
      if (!dragging) return;
      tx = e.clientX - startX;
      ty = e.clientY - startY;
      applyTransform();
    };
    var onUp = function () {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('is-dragging');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    wrap.__fpImageDispose = function () {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    stage.addEventListener('dblclick', function () {
      if (fitted) {
        fitted = false;
        scale = 1;
      } else {
        fitted = true;
        tx = 0;
        ty = 0;
      }
      applyTransform();
    });

    if (svgSourceBtn) {
      var showingSource = false;
      var loadedSource = false;
      svgSourceBtn.addEventListener('click', function () {
        showingSource = !showingSource;
        svgSourceBtn.classList.toggle('is-active', showingSource);
        stage.hidden = showingSource;
        sourceBox.hidden = !showingSource;
        if (showingSource && !loadedSource) {
          loadedSource = true;
          sourceBox.innerHTML = '<div class="fp-loading">读取 SVG 源码…</div>';
          var hdrs = (window.Auth && Auth.headers) ? Auth.headers() : {};
          fetch(url, { headers: hdrs, cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (text) { _renderCode(sourceBox, text, 'xml'); })
            .catch(function (err) { sourceBox.textContent = '读取 SVG 源码失败：' + (err && err.message ? err.message : err); });
        }
      });
    }

    wrap.append(bar, stage, sourceBox);
    body.appendChild(wrap);
  }

  function _renderHtml(body, content, targetLine, showSource) {
    var wrap = document.createElement('div');
    wrap.className = 'fp-html-wrap';
    var frame = document.createElement('iframe');
    frame.title = 'HTML 预览';
    // Scripts can render interactive reports, but cannot access the panel's
    // origin, credentials, native bridge, top-level navigation or popups.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    if (window.PanelPresentation) window.PanelPresentation.mount(frame, content);
    else frame.srcdoc = content;
    var source = document.createElement('div');
    source.className = 'fp-html-source';
    var sourceRendered = false;
    function update() {
      if (showSource && !sourceRendered) {
        _renderCode(source, content, 'html', targetLine);
        sourceRendered = true;
      }
      frame.hidden = !!showSource;
      source.hidden = !showSource;
      wrap.setAttribute('data-source-visible', showSource ? 'true' : 'false');
    }
    wrap.__fpToggleSource = function () { showSource = !showSource; update(); };
    update();
    wrap.appendChild(frame);
    wrap.appendChild(source);
    body.appendChild(wrap);
  }

  function _renderPdf(body, url, filename) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-pdf-wrap';
    var iframe = document.createElement('iframe');
    iframe.title = 'PDF 预览';
    var toolbar = document.createElement('div');
    toolbar.className = 'fp-document-toolbar';
    var hint = document.createElement('span');
    hint.textContent = '无法显示 PDF 时可下载查看';
    var download = document.createElement('button');
    download.type = 'button';
    download.textContent = '下载 PDF';
    download.addEventListener('click', function () {
      _blobDownload(url + '&download=1', filename).catch(function (err) {
        _notifyFailure('下载失败：' + err.message);
      });
    });
    toolbar.appendChild(hint);
    toolbar.appendChild(download);
    wrap.appendChild(toolbar);
    body.appendChild(wrap);
    // iframe navigation sends Accept: text/html, where query tokens are
    // deliberately refused. Fetch with Bearer auth before invoking the viewer.
    return fetch(url, { headers: typeof Auth !== 'undefined' ? Auth.headers() : {}, cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('PDF 加载失败（HTTP ' + response.status + '）');
        return response.blob();
      })
      .then(function (blob) {
        var blobUrl = window.URL.createObjectURL(blob);
        iframe.setAttribute('data-fp-blob-url', blobUrl);
        iframe.src = blobUrl;
        wrap.appendChild(iframe);
      });
  }

  // --- xlsx (ExcelJS → styled HTML tables) ---

  function _argbToCss(argb) {
    // ExcelJS colors are 'AARRGGBB'. Theme/indexed colors lack argb → skip.
    if (!argb || typeof argb !== 'string' || argb.length < 6) return null;
    var hex = argb.length === 8 ? argb.slice(2) : argb;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return '#' + hex;
  }

  function _xlsxColStyle(width) {
    // ExcelJS width ≈ character units; ~7px per char is a decent approximation.
    if (!width || !isFinite(width)) return '';
    return ' style="width:' + Math.round(width * 7) + 'px"';
  }

  // Pick black/white text for a given background so a fill never hides its text.
  function _contrastText(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1f2328' : '#f5f5f5';
  }

  function _xlsxCellStyle(cell) {
    var s = [];
    var f = cell.font || {};
    if (f.bold) s.push('font-weight:600');
    if (f.italic) s.push('font-style:italic');
    if (f.underline) s.push('text-decoration:underline');
    if (f.size) s.push('font-size:' + f.size + 'px');
    var fill = cell.fill;
    var bg = (fill && fill.type === 'pattern' && fill.fgColor)
      ? _argbToCss(fill.fgColor.argb) : null;
    if (bg) s.push('background:' + bg);
    var fc = f.color && _argbToCss(f.color.argb);
    if (fc) {
      s.push('color:' + fc);
    } else if (bg) {
      // Cell has a fill but no explicit font color (Excel "auto" = black on a
      // white sheet). On our table the fill could be light or dark, so derive a
      // contrasting color from its luminance instead of inheriting the default.
      s.push('color:' + _contrastText(bg));
    }
    var a = cell.alignment || {};
    if (a.horizontal) s.push('text-align:' + a.horizontal);
    if (a.vertical) s.push('vertical-align:' + (a.vertical === 'middle' ? 'middle' : a.vertical));
    if (a.wrapText) s.push('white-space:normal');
    return s.length ? ' style="' + s.join(';') + '"' : '';
  }

  // Build a lookup of merged ranges so we emit rowspan/colspan on the
  // top-left cell and skip the cells it covers.
  function _xlsxMerges(ws, rowCount, colCount) {
    var masters = {}; // "r,c" -> {rowspan, colspan}
    var covered = {}; // "r,c" -> true (non-master cells inside a merge)
    var ranges = (ws.model && ws.model.merges) || [];
    ranges.forEach(function (range) {
      var m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
      if (!m) return;
      var c1 = _colToNum(m[1]), r1 = +m[2], c2 = _colToNum(m[3]), r2 = +m[4];
      if (r1 > rowCount || c1 > colCount) return;
      r2 = Math.min(r2, rowCount);
      c2 = Math.min(c2, colCount);
      masters[r1 + ',' + c1] = { rowspan: r2 - r1 + 1, colspan: c2 - c1 + 1 };
      for (var r = r1; r <= r2; r++) {
        for (var c = c1; c <= c2; c++) {
          if (r === r1 && c === c1) continue;
          covered[r + ',' + c] = true;
        }
      }
    });
    return { masters: masters, covered: covered };
  }

  function _colToNum(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) {
      n = n * 26 + (letters.charCodeAt(i) - 64);
    }
    return n;
  }

  function _xlsxSheetTable(ws) {
    var colCount = ws.actualColumnCount || ws.columnCount || 0;
    var rowCount = ws.actualRowCount || ws.rowCount || 0;
    if (Math.max(1, rowCount) * Math.max(1, colCount) > 5000) return null;
    var merges = _xlsxMerges(ws, rowCount, colCount);
    var chars = 0;
    var html = '<table class="fp-xlsx-table"><colgroup>';
    for (var c = 1; c <= colCount; c++) {
      var col = ws.getColumn(c);
      html += '<col' + _xlsxColStyle(col && col.width) + '>';
    }
    html += '</colgroup><tbody>';
    for (var r = 1; r <= rowCount; r++) {
      var row = ws.getRow(r);
      html += '<tr>';
      for (var cc = 1; cc <= colCount; cc++) {
        var key = r + ',' + cc;
        if (merges.covered[key]) continue;
        var cell = row.getCell(cc);
        var span = merges.masters[key];
        var attrs = _xlsxCellStyle(cell);
        if (span) {
          if (span.rowspan > 1) attrs += ' rowspan="' + span.rowspan + '"';
          if (span.colspan > 1) attrs += ' colspan="' + span.colspan + '"';
        }
        var text = cell.text != null ? String(cell.text) : '';
        chars += text.length;
        if (text.length > 4000 || chars > 65536) return null;
        html += '<td' + attrs + '>' + _escapeHtml(text) + '</td>';
      }
      html += '</tr>';
    }
    return html + '</tbody></table>';
  }

  function _renderXlsx(body, rawUrl, filename, isCurrent) {
    isCurrent = isCurrent || function () { return true; };
    body.innerHTML = '<div class="fp-loading" role="status">正在读取表格…</div>';
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return Promise.all([
      _loadScript(CDN.exceljs),
      fetch(rawUrl, { headers: headers, cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }),
    ])
      .then(function (results) {
        if (!isCurrent()) return null;
        var buf = results[1];
        var wb = new window.ExcelJS.Workbook();
        return wb.xlsx.load(buf);
      })
      .then(function (wb) {
        if (!wb || !isCurrent()) return false;
        var sheets = [];
        wb.eachSheet(function (ws) { sheets.push(ws); });
        if (!sheets.length) throw new Error('空工作簿');

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fp-xlsx-wrap';

        var tabs = document.createElement('div');
        tabs.className = 'fp-xlsx-tabs';
        var panes = document.createElement('div');
        panes.className = 'fp-xlsx-panes';

        sheets.forEach(function (ws, i) {
          var tab = document.createElement('button');
          tab.className = 'fp-xlsx-tab' + (i === 0 ? ' active' : '');
          tab.textContent = ws.name || ('Sheet' + (i + 1));
          var pane = document.createElement('div');
          pane.className = 'fp-xlsx-pane' + (i === 0 ? ' active' : '');
          var drawn = false;
          pane.__fpRenderSheetInto = function (target) {
            var html = _xlsxSheetTable(ws);
            if (html === null) {
              _renderUnavailable(target, '工作表较大，已暂停表格渲染。请下载完整文件查看。', rawUrl, filename);
            } else {
              target.innerHTML = html;
              if (target === pane) _attachColumnFilters(target.querySelector('.fp-xlsx-table'));
            }
          };
          function drawSheet() {
            if (drawn) return;
            drawn = true;
            pane.__fpRenderSheetInto(pane);
          }
          tab.addEventListener('click', function () {
            tabs.querySelectorAll('.fp-xlsx-tab').forEach(function (t) { t.classList.remove('active'); });
            panes.querySelectorAll('.fp-xlsx-pane').forEach(function (p) { p.classList.remove('active'); });
            tab.classList.add('active');
            pane.classList.add('active');
            drawSheet();
          });
          tabs.appendChild(tab);
          panes.appendChild(pane);
          if (i === 0) drawSheet();
        });

        if (sheets.length > 1) wrap.appendChild(tabs);
        wrap.appendChild(panes);
        body.appendChild(wrap);
      });
  }

  // --- csv / tsv (parsed → table, reusing the xlsx table styling) ---

  function _isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }

  function _csvDelim(absPath, text) {
    if (/\.tsv$/i.test(absPath)) return '\t';
    var first = (text.split('\n', 1)[0] || '');
    var cand = [',', ';', '\t'];
    var best = ',', bestN = -1;
    cand.forEach(function (d) {
      var n = first.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }

  // RFC 4180: handles quoted fields, escaped quotes (""), and newlines/delims
  // inside quotes.
  function _parseCsv(text, delim) {
    var rows = [], row = [], field = '', inQ = false, i = 0, n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function _renderCsv(body, content, absPath) {
    var rows = _parseCsv(content, _csvDelim(absPath, content));
    var cells = 0;
    if (rows.some(function (row) { cells += row.length; return cells > 5000; })) {
      _renderCode(body, content, 'plaintext', null, true);
      return;
    }
    // Drop a trailing blank row from a final newline.
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    if (!rows.length) { _renderCode(body, content, 'plaintext'); return; }

    var MAX_ROWS = 2000;
    var truncated = rows.length > MAX_ROWS;
    if (truncated) rows = rows.slice(0, MAX_ROWS);

    var html = '<table class="fp-xlsx-table"><tbody>';
    for (var r = 0; r < rows.length; r++) {
      html += '<tr>';
      var bold = r === 0 ? ' style="font-weight:600"' : '';
      var cells = rows[r];
      for (var c = 0; c < cells.length; c++) {
        html += '<td' + bold + '>' + _escapeHtml(cells[c]) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-xlsx-wrap';
    var panes = document.createElement('div');
    panes.className = 'fp-xlsx-panes';
    var pane = document.createElement('div');
    pane.className = 'fp-xlsx-pane active';
    pane.innerHTML = html;
    panes.appendChild(pane);
    wrap.appendChild(panes);
    if (truncated) {
      var note = document.createElement('div');
      note.className = 'fp-dir-truncated';
      note.textContent = '已截断显示前 ' + MAX_ROWS + ' 行';
      wrap.appendChild(note);
    }
    body.appendChild(wrap);
    _attachColumnFilters(wrap.querySelector('.fp-xlsx-table'));
  }

  // --- Excel-style per-column filter (xlsx & csv flat tables) ---

  function _attachColumnFilters(table) {
    if (!table || !table.tBodies || !table.tBodies[0]) return;
    // Merged cells break column/row indexing — skip those tables.
    if (table.querySelector('[rowspan],[colspan]')) return;
    var rows = Array.prototype.slice.call(table.tBodies[0].rows);
    if (rows.length < 2) return;
    var header = rows[0];
    var dataRows = rows.slice(1);
    var filters = {}; // colIndex -> Set(allowed values); absent = no filter
    var terms = [];   // global fuzzy-search terms (AND across all cells in a row)
    var openPop = null;

    // Cache each row's lowercased full text so the search stays cheap on big tables.
    var rowText = dataRows.map(function (row) { return row.textContent.toLowerCase(); });

    function applyFilters() {
      var shown = 0;
      for (var i = 0; i < dataRows.length; i++) {
        var show = true, row = dataRows[i];
        for (var col in filters) {
          var cell = row.cells[col];
          if (!filters[col].has(cell ? cell.textContent : '')) { show = false; break; }
        }
        if (show && terms.length) {
          var hay = rowText[i];
          for (var t = 0; t < terms.length; t++) {
            if (hay.indexOf(terms[t]) < 0) { show = false; break; }
          }
        }
        row.style.display = show ? '' : 'none';
        if (show) shown++;
      }
      if (counter) counter.textContent = shown + ' / ' + dataRows.length + ' 行';
    }

    function distinct(col) {
      var seen = {}, out = [];
      for (var i = 0; i < dataRows.length; i++) {
        var cell = dataRows[i].cells[col];
        var v = cell ? cell.textContent : '';
        if (!Object.prototype.hasOwnProperty.call(seen, v)) { seen[v] = 1; out.push(v); }
      }
      return out.sort();
    }

    function closePop() {
      if (!openPop) return;
      openPop.remove(); openPop = null;
      document.removeEventListener('mousedown', onDoc, true);
    }
    function onDoc(e) {
      if (openPop && !openPop.contains(e.target) && !e.target.classList.contains('fp-colfilter-btn')) closePop();
    }

    function openFilter(col, btn) {
      var reopen = openPop && openPop._col === col;
      closePop();
      if (reopen) return; // clicking the same button toggles it closed

      var values = distinct(col);
      var allowed = filters[col] || null; // null = all selected
      var pop = document.createElement('div');
      pop.className = 'fp-colfilter-pop';
      pop._col = col;

      var search = document.createElement('input');
      search.className = 'fp-colfilter-search';
      search.placeholder = '搜索…';
      pop.appendChild(search);

      var list = document.createElement('div');
      list.className = 'fp-colfilter-list';
      pop.appendChild(list);

      var allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.checked = !allowed;
      var allLabel = document.createElement('label');
      allLabel.className = 'fp-colfilter-item fp-colfilter-all';
      allLabel.appendChild(allCb); allLabel.appendChild(document.createTextNode('（全选）'));
      list.appendChild(allLabel);

      var itemCbs = [];
      values.forEach(function (v) {
        var cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = !allowed || allowed.has(v); cb.value = v;
        var label = document.createElement('label');
        label.className = 'fp-colfilter-item';
        label.appendChild(cb);
        label.appendChild(document.createTextNode(v === '' ? '（空）' : v));
        list.appendChild(label);
        itemCbs.push(cb);
      });

      function commit() {
        var checked = itemCbs.filter(function (c) { return c.checked; });
        if (checked.length === itemCbs.length) { delete filters[col]; btn.classList.remove('active'); }
        else { filters[col] = new Set(checked.map(function (c) { return c.value; })); btn.classList.add('active'); }
        applyFilters();
      }
      itemCbs.forEach(function (c) {
        c.addEventListener('change', function () {
          allCb.checked = itemCbs.every(function (x) { return x.checked; });
          commit();
        });
      });
      allCb.addEventListener('change', function () {
        itemCbs.forEach(function (c) { if (c.parentNode.style.display !== 'none') c.checked = allCb.checked; });
        commit();
      });
      search.addEventListener('input', function () {
        var q = search.value.toLowerCase();
        itemCbs.forEach(function (c) {
          c.parentNode.style.display = c.value.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
      });

      document.body.appendChild(pop);
      var r = btn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 2, window.innerHeight - pop.offsetHeight - 8) + 'px';
      openPop = pop;
      setTimeout(function () { document.addEventListener('mousedown', onDoc, true); }, 0);
      search.focus();
    }

    for (var c = 0; c < header.cells.length; c++) {
      (function (col) {
        var btn = document.createElement('span');
        btn.className = 'fp-colfilter-btn';
        btn.textContent = '▾';
        btn.title = '筛选此列';
        btn.addEventListener('click', function (e) { e.stopPropagation(); openFilter(col, btn); });
        header.cells[col].appendChild(btn);
      })(c);
    }

    // Global fuzzy search bar — matches whole rows; whitespace splits into AND terms.
    var bar = document.createElement('div');
    bar.className = 'fp-table-search';
    var input = document.createElement('input');
    input.className = 'fp-table-search-input';
    input.type = 'search';
    input.placeholder = '搜索全表…（空格分隔多个关键词）';
    var counter = document.createElement('span');
    counter.className = 'fp-table-search-count';
    counter.textContent = dataRows.length + ' / ' + dataRows.length + ' 行';
    bar.appendChild(input);
    bar.appendChild(counter);
    input.addEventListener('input', function () {
      terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      applyFilters();
    });
    table.parentNode.insertBefore(bar, table);
  }

  // Keep both text layout and syntax highlighting bounded for generated files.
  function _renderPagedCode(wrap, pre, code, lineNums, content, targetLine) {
    var pages = [], at = 0, line = 1, page = 0, targetOffset = 0;
    for (var n = 1; n < targetLine; n++) {
      var newline = content.indexOf('\n', targetOffset);
      if (newline < 0) break;
      targetOffset = newline + 1;
    }
    while (at < content.length) {
      var chunk = content.slice(at, at + 4000);
      // Prefer a line boundary; a long line still has a hard character limit.
      var lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline >= 0 && at + chunk.length < content.length) chunk = chunk.slice(0, lastNewline + 1);
      if (/[\uD800-\uDBFF]/.test(chunk.slice(-1)) && at + chunk.length < content.length) chunk = chunk.slice(0, -1);
      pages.push({ offset: at, line: line });
      if (at <= targetOffset) page = pages.length - 1;
      at += chunk.length;
      line += chunk.split('\n').length - 1;
    }
    var bar = document.createElement('div');
    bar.className = 'fp-code-pages';
    var label = document.createElement('span');
    label.setAttribute('role', 'status');
    function showPage() {
      var start = pages[page].offset;
      var end = page + 1 < pages.length ? pages[page + 1].offset : content.length;
      var chunk = content.slice(start, end);
      wrap.__fpCodeOffset = start;
      code.textContent = chunk;
      var count = chunk.split('\n').length - (end < content.length && chunk.endsWith('\n') ? 1 : 0);
      lineNums.textContent = Array.from({ length: count }, function (_, i) { return pages[page].line + i; }).join('\n');
      label.textContent = '分段纯文本 · 字符 ' + (start + 1) + '–' + end + ' / ' + content.length;
      prev.disabled = page === 0;
      next.disabled = page === pages.length - 1;
      wrap.scrollTop = 0;
      code.scrollLeft = 0;
    }
    function control(text, step) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.setAttribute('aria-label', text);
      b.addEventListener('click', function () { page += step; showPage(); });
      return b;
    }
    var prev = control('上一段', -1), next = control('下一段', 1);
    wrap.__fpRestoreCodeOffset = function (offset) {
      page = 0;
      while (page + 1 < pages.length && pages[page + 1].offset <= offset) page++;
      showPage();
    };
    bar.append(label, prev, next);
    wrap.insertBefore(bar, pre);
    showPage();
  }

  function _needsTextPaging(content) {
    if (content.length > 65536) return true;
    var lines = content.split('\n');
    return lines.length > 1000 || lines.some(function (line) { return line.length > 4000; });
  }

  function _renderCode(body, content, language, targetLine, forcePaging) {
    _disposePreview(body);
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-code-wrap';
    wrap.__fpCodeLive = true;

    var lineNums = document.createElement('div');
    lineNums.className = 'fp-line-numbers';

    var pre = document.createElement('pre');
    var code = document.createElement('code');
    pre.appendChild(lineNums);
    pre.appendChild(code);
    wrap.appendChild(pre);
    body.appendChild(wrap);
    if (forcePaging || _needsTextPaging(content)) {
      _renderPagedCode(wrap, pre, code, lineNums, content, targetLine);
      return;
    }
    var lines = content.split('\n');
    lineNums.textContent = lines.map(function (_, i) { return i + 1; }).join('\n');
    code.textContent = content;

    Promise.all([_loadScript(CDN.hljs), _loadCSS(CDN.hljsCss)])
      .then(function () {
        if (!wrap.__fpCodeLive) return;
        // highlight.js logs an error for a language it lacks before throwing: ask first.
        if (window.hljs && language && window.hljs.getLanguage(language)) {
          try {
            var result = window.hljs.highlight(content, { language: language, ignoreIllegals: true });
            code.innerHTML = result.value;
          } catch (_) {
            window.hljs.highlightElement(code);
          }
        } else if (window.hljs) {
          window.hljs.highlightElement(code);
        }
      })
      .catch(function () { /* highlight failed — show plain text */ });

    // Best-effort jump to a target line (from path:line:col). Never let a
    // scroll/measure failure block the file from opening.
    if (targetLine && targetLine > 1) {
      try {
        var per = lineNums.scrollHeight / Math.max(lines.length, 1);
        if (per > 0 && isFinite(per)) {
          wrap.scrollTop = Math.max(0, (targetLine - 1) * per - wrap.clientHeight / 3);
        }
      } catch (_e) { /* ignore */ }
    }
  }

  function _normalizeMarkdownHeading(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function _markdownHeadingSlug(text) {
    var slug = _normalizeMarkdownHeading(text)
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug || 'section';
  }

  function _wikilinkHtml(target, label, hasAlias) {
    target = String(target || '').trim();
    var display = String(label || '').trim();
    if (target.charAt(0) === '#' && target.length > 1) {
      var heading = target.slice(1).trim();
      if (!display || !hasAlias) display = heading;
      return '<a class="fp-wikilink fp-wikilink-heading" href="#' + _escapeHtml(_markdownHeadingSlug(heading))
        + '" data-fp-heading-target="' + _escapeHtml(heading) + '">' + _escapeHtml(display) + '</a>';
    }
    var hashAt = target.indexOf('#');
    var path = hashAt >= 0 ? target.slice(0, hashAt) : target;
    var fragment = hashAt >= 0 ? target.slice(hashAt + 1) : '';
    var lastSeg = path.split('/').pop() || '';
    if (path && lastSeg.indexOf('.') < 0) path += '.md';
    var href = path + (fragment ? '#' + fragment : '');
    return '<a class="fp-wikilink fp-wikilink-file" href="' + _escapeHtml(href) + '"'
      + ' title="Obsidian 链接: ' + _escapeHtml(target) + '">'
      + _escapeHtml(display || target) + '</a>';
  }

  function _decodeMarkdownPart(value) {
    try { return decodeURIComponent(value); } catch (_) { return null; }
  }

  function _encodedFileURLPath(absPath) {
    return String(absPath || '').split('/').map(function (part, index) {
      return index === 0 ? '' : encodeURIComponent(part);
    }).join('/');
  }

  function _resolveMarkdownHref(sourceAbsPath, rawHref) {
    var href = String(rawHref || '').trim();
    if (!href) return { kind: 'blocked' };

    if (href.charAt(0) === '#') {
      var localHeading = _decodeMarkdownPart(href.slice(1));
      return localHeading === null ? { kind: 'blocked' }
        : { kind: 'heading', headingRef: localHeading };
    }

    if (/^\/\//.test(href)) return { kind: 'web', href: 'https:' + href };
    var scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
    if (scheme) {
      return /^https?$/i.test(scheme[1]) ? { kind: 'web', href: href } : { kind: 'blocked' };
    }

    if (typeof sourceAbsPath !== 'string' || sourceAbsPath.charAt(0) !== '/') {
      return { kind: 'blocked' };
    }

    try {
      var origin = 'https://file-preview.invalid';
      var target = new URL(href, origin + _encodedFileURLPath(sourceAbsPath));
      if (target.origin !== origin) {
        return /^https?:$/i.test(target.protocol) ? { kind: 'web', href: target.href } : { kind: 'blocked' };
      }
      var path = _decodeMarkdownPart(target.pathname);
      var headingRef = _decodeMarkdownPart(target.hash ? target.hash.slice(1) : '');
      if (path === null || headingRef === null) return { kind: 'blocked' };
      if (path === sourceAbsPath) return { kind: 'heading', headingRef: headingRef };
      return { kind: 'file', path: path, headingRef: headingRef || null };
    } catch (_) {
      return { kind: 'blocked' };
    }
  }

  function _scrollMarkdownHeading(wrap, raw) {
    if (!wrap) return false;
    var headingRef = String(raw || '');
    try { headingRef = decodeURIComponent(headingRef); } catch (_) { /* already decoded */ }
    var headings = Array.prototype.slice.call(wrap.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    var normalized = _normalizeMarkdownHeading(headingRef);
    var target = null;
    for (var i = 0; i < headings.length; i++) {
      if (_normalizeMarkdownHeading(headings[i].textContent) === normalized) {
        target = headings[i];
        break;
      }
    }
    if (!target) {
      var slug = _markdownHeadingSlug(headingRef);
      for (var j = 0; j < headings.length; j++) {
        if (headings[j].id === slug) { target = headings[j]; break; }
      }
    }
    if (!target) return false;
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return true;
  }

  function _prepareMarkdownNavigation(wrap, sourceAbsPath, paneId) {
    if (!wrap) return;
    var headings = Array.prototype.slice.call(wrap.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    var ids = {};
    headings.forEach(function (heading) {
      var base = _markdownHeadingSlug(heading.textContent);
      var count = ids[base] || 0;
      ids[base] = count + 1;
      heading.id = count === 0 ? base : base + '-' + count;
      heading.setAttribute('tabindex', '-1');
    });

    wrap.addEventListener('click', function (event) {
      var link = event.target.closest && event.target.closest('a[href]');
      if (!link || !wrap.contains(link)) return;
      var resolved = _resolveMarkdownHref(sourceAbsPath, link.getAttribute('href'));
      event.preventDefault();
      if (resolved.kind === 'heading') {
        var heading = link.getAttribute('data-fp-heading-target') || resolved.headingRef;
        if (!_scrollMarkdownHeading(wrap, heading)) {
          _notifyFailure('未找到标题：' + heading);
        }
      } else if (resolved.kind === 'file') {
        openFile(resolved.path, paneId || _currentPaneId, { markdownFragment: resolved.headingRef, source: _currentSource });
      } else if (resolved.kind === 'web') {
        _openWeb(resolved.href);
      } else if (resolved.kind === 'blocked') {
        _notifyFailure('已阻止不安全链接：' + link.getAttribute('href'));
      }
    });
  }

  // Accept image tags without enabling arbitrary HTML in Markdown documents.
  function _installMarkdownImages(md) {
    md.inline.ruler.before('html_inline', 'fp_image_tag', function (state, silent) {
      if (state.src.charAt(state.pos) !== '<') return false;
      var match = /^<img(?=\s|\/?>)(?:"[^"]*"|'[^']*'|[^'">])*\/?>/i.exec(state.src.slice(state.pos, state.posMax));
      if (!match) return false;
      var template = document.createElement('template');
      template.innerHTML = match[0];
      var image = template.content.firstElementChild;
      if (!image || image.tagName !== 'IMG' || template.content.childElementCount !== 1) return false;
      var src = (image.getAttribute('src') || '').trim();
      if (!src || /[\x00-\x1f\x7f]/.test(src)) return false;
      var target = _resolveMarkdownHref('/__markdown__.md', src);
      if (target.kind !== 'file' && target.kind !== 'web') return false;
      if (!silent) {
        var attrs = ' src="' + _escapeHtml(src) + '"';
        ['alt', 'title'].forEach(function (name) {
          if (image.hasAttribute(name)) attrs += ' ' + name + '="' + _escapeHtml(image.getAttribute(name)) + '"';
        });
        ['width', 'height'].forEach(function (name) {
          var value = image.getAttribute(name) || '';
          if (/^[1-9]\d*$/.test(value) && Number(value) <= 4096) attrs += ' ' + name + '="' + value + '"';
        });
        var token = state.push('html_inline', '', 0);
        token.content = '<img' + attrs + '>';
      }
      state.pos += match[0].length;
      return true;
    });
  }

  // markdown-it plugin: Obsidian-flavored inline syntax.
  // We push our own html_inline tokens (rendered verbatim regardless of the
  // `html:false` option), so every bit of user text is escaped by hand first.
  function _obsidianMarkdown(md) {
    var esc = _escapeHtml;
    var IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

    // ==highlight==  ->  <mark>
    md.inline.ruler.before('emphasis', 'obs_mark', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x3D || s.charCodeAt(p + 1) !== 0x3D) return false;
      var hit = s.indexOf('==', p + 2);
      if (hit < 0) return false;
      var inner = s.slice(p + 2, hit);
      if (!inner || inner.indexOf('\n') >= 0) return false;
      if (!silent) {
        var t = state.push('html_inline', '', 0);
        t.content = '<mark class="fp-hl">' + esc(inner) + '</mark>';
      }
      state.pos = hit + 2;
      return true;
    });

    // %%comment%%  ->  removed
    md.inline.ruler.before('emphasis', 'obs_comment', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x25 || s.charCodeAt(p + 1) !== 0x25) return false;
      var hit = s.indexOf('%%', p + 2);
      if (hit < 0) return false;
      state.pos = hit + 2; // swallow, emit nothing
      return true;
    });

    // Video embeds share the image token and are promoted after rendering.
    md.inline.ruler.before('image', 'obs_embed', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x21 || s.charCodeAt(p + 1) !== 0x5B || s.charCodeAt(p + 2) !== 0x5B) return false;
      var end = s.indexOf(']]', p + 3);
      if (end < 0) return false;
      var inner = s.slice(p + 3, end);
      if (!inner || inner.indexOf('\n') >= 0 || inner.indexOf('[[') >= 0) return false;
      if (!silent) {
        var parts = inner.split('|');
        var target = parts[0].split('#')[0].trim();
        var label = (parts[1] != null ? parts[1] : parts[0]).trim();
        var t = state.push('html_inline', '', 0);
        if (IMG_RE.test(target) || VIDEO_RE.test(target)) {
          t.content = '<img class="fp-embed-img" src="' + esc(target) + '" alt="' + esc(label) + '">';
        } else {
          t.content = '<span class="fp-embed" title="Obsidian 嵌入: ' + esc(target) + '">\u{1F4CE} ' + esc(label) + '</span>';
        }
      }
      state.pos = end + 2;
      return true;
    });

    // [[#heading]] jumps in-document; [[file]] / [[file#heading]] resolve
    // relative to the current file and open through the shared link handler.
    md.inline.ruler.before('link', 'obs_wikilink', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x5B || s.charCodeAt(p + 1) !== 0x5B) return false;
      var end = s.indexOf(']]', p + 2);
      if (end < 0) return false;
      var inner = s.slice(p + 2, end);
      if (!inner || inner.indexOf('\n') >= 0 || inner.indexOf('[[') >= 0) return false;
      if (!silent) {
        var parts = inner.split('|');
        var target = parts[0].trim();
        var label = (parts[1] != null ? parts[1] : parts[0]).trim();
        var t = state.push('html_inline', '', 0);
        t.content = _wikilinkHtml(target, label, parts[1] != null);
      }
      state.pos = end + 2;
      return true;
    });

    // #tag  ->  chip. Must follow start-of-line/whitespace/( and hold a non-digit.
    var TAG_RE = /^#[A-Za-z0-9_一-鿿][\w\/\-一-鿿]*/;
    md.inline.ruler.push('obs_tag', function (state, silent) {
      var s = state.src, p = state.pos;
      if (s.charCodeAt(p) !== 0x23) return false;
      if (p > 0) {
        var b = s.charCodeAt(p - 1);
        if (b !== 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x28) return false;
      }
      var m = TAG_RE.exec(s.slice(p));
      if (!m || /^#[0-9]+$/.test(m[0])) return false;
      if (!silent) {
        var t = state.push('html_inline', '', 0);
        t.content = '<span class="fp-tag">' + esc(m[0]) + '</span>';
      }
      state.pos = p + m[0].length;
      return true;
    });
  }

  // Turn `> [!type] title` blockquotes into Obsidian callouts. Done on the
  // rendered DOM (not markdown-it) so the result is captured by the new-tab
  // export, which clones the live .fp-md-wrap.
  function _renderCallouts(wrap) {
    var ICONS = {
      note: '\u{1F5C8}', abstract: '\u{1F4CB}', summary: '\u{1F4CB}', tldr: '\u{1F4CB}',
      info: 'ℹ️', todo: '☑️', tip: '\u{1F4A1}', hint: '\u{1F4A1}',
      important: '❗', success: '✅', check: '✅', done: '✅',
      question: '❓', help: '❓', faq: '❓', warning: '⚠️',
      caution: '⚠️', attention: '⚠️', failure: '❌', fail: '❌',
      missing: '❌', danger: '\u{1F525}', error: '\u{1F525}', bug: '\u{1F41E}',
      example: '\u{1F4DD}', quote: '❝', cite: '❝',
    };
    var bqs = wrap.querySelectorAll('blockquote');
    Array.prototype.forEach.call(bqs, function (bq) {
      var first = bq.querySelector('p');
      if (!first) return;
      var m = /^\s*\[!([\w-]+)\]([+-]?)\s*([^\n]*)/.exec(first.textContent);
      if (!m) return;
      var type = m[1].toLowerCase();
      var defTitle = type.charAt(0).toUpperCase() + type.slice(1);
      bq.classList.add('fp-callout', 'fp-callout-' + type);

      var html = first.innerHTML;
      var nl = html.indexOf('\n');
      var titleHtml = (nl >= 0 ? html.slice(0, nl) : html).replace(/^\s*\[![\w-]+\][+-]?\s*/, '').trim();
      var restHtml = nl >= 0 ? html.slice(nl + 1) : '';

      var titleEl = document.createElement('div');
      titleEl.className = 'fp-callout-title';
      titleEl.innerHTML = '<span class="fp-callout-icon">' + (ICONS[type] || '\u{1F5C8}') + '</span>'
        + '<span class="fp-callout-titletext">' + (titleHtml || defTitle) + '</span>';

      if (restHtml.trim()) { first.innerHTML = restHtml; } else { first.remove(); }
      bq.insertBefore(titleEl, bq.firstChild);
    });
  }

  // Pull a leading YAML frontmatter block off the content. Returns the parsed
  // object (or null) and the body with the block removed. Deliberately a tiny
  // parser — covers `key: scalar`, `key: [a, b]`, and the multiline `- item`
  // list form that frontmatter actually uses; not a general YAML engine.
  function _extractFrontmatter(content) {
    var m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
    if (!m) return { fm: null, body: content, lineOffset: 0 };
    return {
      fm: _parseFrontmatter(m[1]),
      body: content.slice(m[0].length),
      lineOffset: (m[0].match(/\n/g) || []).length,
    };
  }

  function _stripQuotes(s) {
    s = s.trim();
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
      return s.slice(1, -1);
    }
    return s;
  }

  function _parseFrontmatter(text) {
    var obj = {}, lines = text.split(/\r?\n/), curKey = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      var li = /^\s*-\s+(.*)$/.exec(line);
      if (li && curKey) { (obj[curKey] = obj[curKey] || []).push(_stripQuotes(li[1])); continue; }
      var kv = /^([\w\-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      var k = kv[1], v = kv[2].trim();
      if (v === '') { obj[k] = []; curKey = k; }
      else if (/^\[.*\]$/.test(v)) {
        obj[k] = v.slice(1, -1).split(',').map(function (x) { return _stripQuotes(x); }).filter(Boolean);
        curKey = null;
      } else { obj[k] = _stripQuotes(v); curKey = null; }
    }
    return obj;
  }

  // Render frontmatter as an Obsidian-style properties card; `tags`/`tag`
  // values become the same chips as inline #tags.
  function _renderFrontmatter(fm) {
    var esc = _escapeHtml;
    // `anymux:` is panel metadata for the bar above an agent's draft, not a property.
    var rows = Object.keys(fm).filter(function (k) { return k !== 'anymux'; }).map(function (k) {
      var v = fm[k], valHtml;
      if (/^tags?$/i.test(k)) {
        var arr = Array.isArray(v) ? v : (v ? [v] : []);
        valHtml = arr.map(function (t) {
          var tag = String(t); if (tag.charAt(0) !== '#') tag = '#' + tag;
          return '<span class="fp-tag">' + esc(tag) + '</span>';
        }).join(' ');
      } else if (Array.isArray(v)) {
        valHtml = v.map(function (x) { return esc(String(x)); }).join(', ');
      } else { valHtml = esc(String(v)); }
      if (!valHtml) return '';
      return '<div class="fp-fm-row"><span class="fp-fm-key">' + esc(k)
        + '</span><span class="fp-fm-val">' + valHtml + '</span></div>';
    }).filter(Boolean).join('');
    return rows ? '<div class="fp-frontmatter">' + rows + '</div>' : '';
  }

  var _taskMarkerRe = /^([ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+)\[([ xX])\]/;

  function _installMarkdownTasks(md) {
    md.core.ruler.after('inline', 'fp_task_lists', function (state) {
      var lines = state.env.fpTaskLines;
      if (!lines) return;
      var lineOffset = state.env.fpTaskLineOffset || 0;
      state.tokens.forEach(function (token) {
        if (token.type !== 'list_item_open' || !token.map) return;
        var sourceLine = lines[token.map[0]];
        var match = typeof sourceLine === 'string' && _taskMarkerRe.exec(sourceLine);
        if (!match) return;
        token.attrJoin('class', 'fp-task-item');
        token.attrSet('data-fp-task-line', String(lineOffset + token.map[0]));
        token.attrSet('data-fp-task-expected', sourceLine);
      });
    });
  }

  function _replaceTaskMarkers(wrap) {
    Array.prototype.forEach.call(wrap.querySelectorAll('li.fp-task-item'), function (item) {
      var walker = document.createTreeWalker(item, 4);
      var textNode = null;
      var match = null;
      while ((textNode = walker.nextNode())) {
        match = /^\[([ xX])\][ \t]+/.exec(textNode.nodeValue);
        if (match) break;
      }
      if (!match || !textNode || !textNode.parentNode) {
        item.classList.remove('fp-task-item');
        item.removeAttribute('data-fp-task-line');
        item.removeAttribute('data-fp-task-expected');
        return;
      }
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'fp-task-checkbox';
      checkbox.checked = match[1].toLowerCase() === 'x';
      checkbox.setAttribute('aria-label', '\u5207\u6362\u4efb\u52a1\u72b6\u6001');
      textNode.parentNode.insertBefore(checkbox, textNode);
      textNode.nodeValue = textNode.nodeValue.slice(match[0].length);
    });
  }

  function _bindMarkdownTaskToggles(wrap, filePath) {
    wrap.addEventListener('change', function (event) {
      var checkbox = event.target;
      if (!checkbox || !checkbox.classList || !checkbox.classList.contains('fp-task-checkbox')) return;
      var item = checkbox.closest('li.fp-task-item');
      var current = _currentFile;
      var line = item && Number(item.getAttribute('data-fp-task-line'));
      var expectedLine = item && item.getAttribute('data-fp-task-expected');
      if (
        !current || current.absPath !== filePath || !Number.isInteger(line) || line < 0
        || !expectedLine || current.mtimeMs == null || current.size == null
      ) {
        checkbox.checked = !checkbox.checked;
        _notifyFailure('\u65e0\u6cd5\u540c\u6b65\u4efb\u52a1\u72b6\u6001');
        return;
      }

      var checked = checkbox.checked;
      checkbox.disabled = true;
      item.classList.add('fp-task-saving');
      var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
      headers['Content-Type'] = 'application/json';
      fetch(_machine() + '/api/files/markdown-task', {
        method: 'PATCH', headers: headers, cache: 'no-store',
        body: JSON.stringify({
          path: current.absPath,
          line: line,
          checked: checked,
          expectedLine: expectedLine,
          expectedMtimeMs: current.mtimeMs,
          expectedSize: current.size,
        }),
      })
        .then(function (response) {
          return response.json().then(function (result) {
            return { status: response.status, result: result };
          });
        })
        .then(function (response) {
          if (response.status === 401) { close(); return false; }
          if (!response.result.success) {
            var error = new Error(response.result.error || '\u4fdd\u5b58\u4efb\u52a1\u72b6\u6001\u5931\u8d25');
            error.status = response.status;
            throw error;
          }
          return _refreshCurrent(true);
        })
        .then(function () {
          if (checkbox.isConnected) {
            checkbox.disabled = false;
            item.classList.remove('fp-task-saving');
          }
        })
        .catch(function (err) {
          if (checkbox.isConnected) {
            checkbox.checked = !checked;
            checkbox.disabled = false;
            item.classList.remove('fp-task-saving');
          }
          if (err && err.status === 409) {
            _refreshCurrent(true);
            _notifyFailure('\u6587\u4ef6\u5df2\u88ab\u5916\u90e8\u4fee\u6539\uff0c\u9884\u89c8\u5df2\u5237\u65b0');
            return;
          }
          _notifyFailure('\u4fdd\u5b58\u4efb\u52a1\u72b6\u6001\u5931\u8d25\uff1a' + (err && err.message ? err.message : err));
        });
    });
  }

  function _prepareMarkdownMedia(wrap, filePath) {
    var tokenQs = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
    wrap.querySelectorAll('img[src], a[href]').forEach(function (element) {
      var isLink = element.tagName === 'A';
      var src = element.getAttribute(isLink ? 'href' : 'src');
      var isVideo = VIDEO_RE.test(src);
      if (isLink && !isVideo) return;
      if (!isLink && /^data:/i.test(src)) return;
      var target = _resolveMarkdownHref(filePath, src);
      if (target.kind !== 'file' && target.kind !== 'web') {
        if (!isLink) element.replaceWith(document.createTextNode(element.alt || '媒体地址无效'));
        return;
      }
      var url = target.kind === 'web' ? target.href
        : _machine() + '/api/files/raw?path=' + encodeURIComponent(target.path) + (tokenQs ? '&' + tokenQs : '');
      // Preserve media fragments such as #t=5,10 on local video URLs.
      var hashAt = src.indexOf('#');
      if (target.kind === 'file' && hashAt >= 0) url += src.slice(hashAt);
      if (!isVideo) {
        element.setAttribute('src', url);
        return;
      }
      var video = _createVideo(url, isLink ? element.textContent : element.alt);
      if (isLink) element.after(video);
      else element.replaceWith(video);
    });
  }

  function _renderMarkdown(body, content, filePath, paneId, readOnly, isCurrent) {
    isCurrent = isCurrent || function () { return true; };
    body.innerHTML = '<div class="fp-loading" role="status">正在排版文档\u2026</div>';

    return Promise.all([
      _loadScript(CDN.markdownIt),
      _loadScript(CDN.hljs),
      _loadCSS(CDN.hljsCss),
    ])
      .then(function () {
        if (!isCurrent()) return null;
        var md = window.markdownit({
          html: false,
          linkify: true,
          highlight: function (str, lang) {
            // Fences in a language highlight.js lacks (mermaid, powershell...) stay plain.
            if (window.hljs && lang && window.hljs.getLanguage(lang)) {
              try {
                return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
              } catch (_) { /* fallback */ }
            }
            return '';
          },
        });

        md.use(_installMarkdownImages);
        md.use(_obsidianMarkdown);
        _installMarkdownTasks(md);

        var katexLoaded = Promise.all([
          _loadCSS(CDN.katexCss),
          _loadScript(CDN.katexJs),
        ])
          .then(function () { return _loadScript(CDN.markdownItKatex); })
          .then(function () {
            if (window.markdownitKatex) md.use(window.markdownitKatex);
          })
          .catch(function () { /* KaTeX optional */ });

        return katexLoaded.then(function () { return md; });
      })
      .then(function (md) {
        if (!md || !isCurrent()) return false;
        var fmExtract = _extractFrontmatter(content);
        var fmHtml = fmExtract.fm ? _renderFrontmatter(fmExtract.fm) : '';
        var env = {
          fpTaskLines: fmExtract.body.split(/\r?\n/),
          fpTaskLineOffset: fmExtract.lineOffset,
        };
        var tokens = md.parse(fmExtract.body, env);
        tokens.forEach(function (token) {
          if (token.level === 0 && Array.isArray(token.map) && /_open$/.test(token.type)) {
            token.attrSet('data-fp-source-line', String(token.map[0] + 1 + fmExtract.lineOffset));
          }
        });
        var html = md.renderer.render(tokens, md.options, env);

        body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'fp-md-wrap';
        wrap.__fpMarkdownLive = true;
        wrap.innerHTML = fmHtml + html;
        _prepareMarkdownMedia(wrap, filePath);
        if (window.ReviewNotes && !readOnly) {
          var mdScopeKey = 'md:' + String(filePath || '');
          wrap.querySelectorAll('[data-fp-source-line]').forEach(function (block) {
            block.classList.add('fp-md-block-row');
            var lineNo = Math.max(1, Number(block.getAttribute('data-fp-source-line') || 1));
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fp-md-note-btn';
            btn.textContent = '+ 批注';
            btn.setAttribute('aria-label', '针对第 ' + lineNo + ' 行段落添加批注');
            btn.addEventListener('click', function (ev) {
              ev.stopPropagation();
              var old = wrap.querySelector('.fp-md-note-editor');
              if (old) old.remove();
              var editor = document.createElement('form');
              editor.className = 'fp-md-note-editor';
              editor.setAttribute('data-fp-hold-refresh', '1');
              var ta = document.createElement('textarea');
              ta.rows = 2;
              ta.placeholder = '输入对第 ' + lineNo + ' 行段落的批注…';
              var actions = document.createElement('div');
              actions.className = 'fp-md-note-actions';
              var injectBtn = document.createElement('button');
              injectBtn.type = 'submit';
              injectBtn.className = 'fp-panzoom-btn';
              injectBtn.textContent = '添加并注入终端 (不回车)';
              var cancelBtn = document.createElement('button');
              cancelBtn.type = 'button';
              cancelBtn.className = 'fp-panzoom-btn';
              cancelBtn.textContent = '取消';
              cancelBtn.addEventListener('click', function () {
                editor.remove();
                _syncAutoRefresh();
              });
              actions.append(cancelBtn, injectBtn);
              editor.append(ta, actions);
              editor.addEventListener('submit', function (subEv) {
                subEv.preventDefault();
                var text = ta.value.trim();
                if (!text) return;
                var snippet = String(block.textContent || '').replace(/\+\s*批注/, '').trim();
                var note = window.ReviewNotes.addNote({
                  scopeKey: mdScopeKey,
                  path: filePath,
                  startLine: lineNo,
                  endLine: lineNo,
                  excerpt: snippet,
                  comment: text,
                });
                if (note) {
                  window.ReviewNotes.injectToTerminal([note], { paneId: paneId }).catch(function () {});
                }
                editor.remove();
                _syncAutoRefresh();
              });
              block.after(editor);
              ta.focus();
            });
            block.appendChild(btn);
          });
        }
        body.appendChild(wrap);

        _replaceTaskMarkers(wrap);
        if (readOnly) {
          wrap.querySelectorAll('.fp-task-checkbox').forEach(function (checkbox) { checkbox.disabled = true; });
        } else {
          _bindMarkdownTaskToggles(wrap, filePath);
        }
        _renderCallouts(wrap);
        _prepareMarkdownNavigation(wrap, filePath, paneId);

        var mermaidBlocks = wrap.querySelectorAll('code.language-mermaid');
        if (mermaidBlocks.length > 0) {
          _loadScript(CDN.mermaid)
            .then(function () {
              if (!wrap.__fpMarkdownLive) return;
              // Pin a system font so mermaid measures text with the SAME
              // always-available font it renders with. Otherwise a late-loading
              // webfont reflows the text after layout is computed, pushing it
              // past the boxes/spacing mermaid already sized — the "overlapping"
              // render. Waiting on document.fonts.ready guards the same hazard.
              _initializeMermaidTheme();
              var fontsReady = (document.fonts && document.fonts.ready)
                ? document.fonts.ready : Promise.resolve();
              return fontsReady.then(function () {
                if (!wrap.__fpMarkdownLive) return;
                var jobs = Array.prototype.map.call(mermaidBlocks, function (block, i) {
                  var code = block.textContent;
                  var container = document.createElement('div');
                  container.className = 'mermaid';
                  container.__fpMermaidSource = code;
                  container.setAttribute('data-fp-export-name', 'mermaid-diagram-' + (i + 1) + '.png');
                  block.parentElement.replaceWith(container);
                  // render() lays out in mermaid's own sandbox (deterministic),
                  // then we inject the finished SVG.
                  var id = 'fp-mmd-' + Date.now() + '-' + i;
                  return window.mermaid.render(id, code)
                    .then(function (res) {
                      if (!wrap.__fpMarkdownLive) return;
                      container.innerHTML = res.svg;
                      _prepareMermaid(container);
                    })
                    .catch(function (err) {
                      if (!wrap.__fpMarkdownLive) return;
                      // Render failed (usually a syntax error) — surface the
                      // reason above the raw source so it's clear it's not a
                      // "type unsupported" issue.
                      var box = document.createElement('div');
                      var msg = document.createElement('div');
                      msg.className = 'fp-mermaid-err';
                      msg.textContent = 'Mermaid 渲染失败：' + (err && err.message ? err.message : err);
                      var p = document.createElement('pre');
                      var c = document.createElement('code');
                      c.textContent = code;
                      p.appendChild(c);
                      box.appendChild(msg);
                      box.appendChild(p);
                      container.replaceWith(box);
                    });
                });
                return Promise.all(jobs).then(function () {
                  if (wrap.__fpMarkdownLive) _installMermaidInteractions(wrap);
                });
              });
            })
            .catch(function () { /* mermaid optional */ });
        }
      })
      .catch(function () {
        if (isCurrent()) _renderCode(body, content, 'markdown');
        else return false;
      });
  }

  // --- Path / URL detection (delegated to the DOM-free LinkDetect core) ---

  // Runs on a single LOGICAL line (wrapped rows already merged); returns
  // matches { text, kind, href, lineRef, startCol, endCol }. All regex logic
  // lives in the terminal plugin's link-detect.js (window.LinkDetect) so it is unit-tested.
  //   kind 'web'       -> open href in a new browser tab
  //   kind 'file'      -> open in the file preview (lineRef jumps to a line)
  //   kind 'ambiguous' -> let the user choose web vs file (e.g. example.com)
  function _findLinks(line) {
    if (typeof LinkDetect === 'undefined') return [];
    return LinkDetect.findLinks(line).map(function (m) {
      return { text: m.text, kind: m.kind, href: m.href, lineRef: m.lineRef,
        startCol: m.start, endCol: m.end };
    });
  }

  // --- Wrapped line helpers ---

  // --- Segments: the panes and boxes in a row ---
  //
  // tmux draws a split window as one screen, so a row holds every pane beside
  // each other with a border between them, and a TUI draws boxes with text
  // inside. A row is read per segment, the cells between two vertical lines
  // (or the row's edges), and text only goes on in the segment of the next row
  // that has the same edges. A row without such lines is one segment, read as
  // it always was. Segments are { lo, hi }: cell columns, hi excluded.

  // A stroke through the cell from top to bottom, or from its middle down or
  // up: box sides, and tmux's pane borders also where they meet other borders.
  var DIVIDER_RE = /[│┃┆┇┊┋├-╋╎╏║╞-╬]/g;
  // Horizontal strokes: rules, and tmux's borders between panes above each other.
  var RULE_RE = /[─━┄┅┈┉╌╍═]/;

  function _wholeSeg(line) {
    return { lo: 0, hi: line.length };
  }

  function _segmentsOf(line) {
    var text = line.translateToString(false);
    DIVIDER_RE.lastIndex = 0;
    var m = DIVIDER_RE.exec(text);
    if (!m) return [_wholeSeg(line)];
    var segs = [];
    var lo = 0;
    var col = 0;
    var at = 0;
    for (; m; m = DIVIDER_RE.exec(text)) {
      col = _advanceCol(line, col, m.index - at);
      at = m.index;
      if (col > lo) segs.push({ lo: lo, hi: col });
      lo = col + 1;
    }
    if (line.length > lo) segs.push({ lo: lo, hi: line.length });
    return segs;
  }

  // The segment of `line` with the edges of `seg`, or null.
  function _segmentLike(line, seg) {
    if (!line || !seg) return null;
    var segs = _segmentsOf(line);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].lo === seg.lo && segs[i].hi === seg.hi) return segs[i];
    }
    return null;
  }

  function _segmentAt(line, col) {
    var segs = _segmentsOf(line);
    for (var i = 0; i < segs.length; i++) {
      if (col >= segs[i].lo && col < segs[i].hi) return segs[i];
    }
    return null;
  }

  // Where the terminal wraps, text runs from a row's last column into the next
  // row's first: out of the last segment and into the first.
  function _lastSegment(line) {
    var segs = line ? _segmentsOf(line) : [];
    var last = segs[segs.length - 1];
    return last && last.hi === line.length ? last : null;
  }

  function _firstSegment(line) {
    var first = line ? _segmentsOf(line)[0] : null;
    return first && first.lo === 0 ? first : null;
  }

  // What a caller that names no segment means: the row's first.
  function _defaultSeg(line) {
    return _segmentsOf(line)[0];
  }

  function _segText(line, seg, trim) {
    var s = seg.lo === 0 && seg.hi >= line.length
      ? line.translateToString(trim)
      : line.translateToString(false, seg.lo, seg.hi);
    return trim ? s.replace(/\s+$/, '') : s;
  }

  // The segment's last cell holds a glyph: its text reached the right edge.
  function _segFull(line, seg) {
    var s = _segText(line, seg, false);
    return s.length > 0 && !/\s$/.test(s);
  }

  // Collect a logical line by merging wrapped buffer lines.
  // Returns { text, startRow, rows } where rows is an array of
  // { line, row, strStart, strLen } for each physical row.
  // A physical row is "full" (reached the right margin) if its last printable
  // cell is non-blank — a strong signal the next line is a forced continuation.

  // Return the number of leading characters to omit from `below` when two
  // physical rows form one logical line, or -1 when they must stay separate.
  //
  // TUIs such as Codex may render their own wrapping as real newlines instead
  // of letting tmux/xterm mark the continuation with `isWrapped`. Their
  // continuation is commonly a hanging indent aligned with the path's start:
  //
  //   Documents/.../DataAnt-Android14-
  //   property_service-Wuying....md
  //
  // Accept that shape only when its trailing link begins at exactly the same
  // indentation and the ordinary seam heuristic
  // accepts the path characters after the indent. A TUI may wrap to its own
  // narrower content width, so hanging-indent joins deliberately do not require
  // the xterm row itself to be full. This keeps unrelated indented prose on a
  // new logical line while supporting Codex/Claude-style rendered paragraphs.
  function _hardJoinStrip(above, below, seg) {
    if (!above || !below || typeof LinkDetect === 'undefined') return -1;
    seg = seg || _wholeSeg(above);
    var prevText = _segText(above, seg, true);
    var nextText = _segText(below, seg, true);
    if (_segFull(above, seg) && LinkDetect.shouldJoinHardWrap(prevText, true, nextText)) return 0;

    var indentMatch = /^( +)/.exec(nextText);
    if (!indentMatch) return -1;
    var stripChars = indentMatch[1].length;
    var continuation = nextText.slice(stripChars);
    if (!continuation || !LinkDetect.shouldJoinHardWrap(prevText, true, continuation)) return -1;

    var tailLinks = LinkDetect.findLinks(prevText);
    for (var i = tailLinks.length - 1; i >= 0; i--) {
      if (tailLinks[i].start === stripChars && tailLinks[i].end === prevText.length) {
        // Validate the seam as a whole, not just as two individually plausible
        // tokens. The joined result must be one file link covering both rows.
        var joined = prevText + continuation;
        var joinedLinks = LinkDetect.findLinks(joined);
        for (var j = joinedLinks.length - 1; j >= 0; j--) {
          if (joinedLinks[j].kind === 'file' && joinedLinks[j].start === stripChars &&
              joinedLinks[j].end === joined.length) return stripChars;
        }
      }
    }
    return -1;
  }

  function _hardJoins(above, below, seg) {
    return _hardJoinStrip(above, below, seg) >= 0;
  }

  // The rows of one logical line by the strict rules: soft wraps, and at most
  // one hard newline that the rules above are sure about. Each row is read in
  // segment `seg` (the row's first when none is given), and a hard newline
  // only joins it to the segment of the next row with the same edges.
  function _strictRows(buffer, bufRow, seg) {
    var line = buffer.getLine(bufRow);
    if (!line) return { startRow: bufRow, objs: [] };
    // Walk backward to the true start: up the soft-wrap chain always, and
    // across ONE hard-newline join (Fix 10) so that the continuation row
    // resolves to the SAME merged line as the joined row (else its standalone
    // fragment would match as a wrong link / be unclickable).
    var startRow = bufRow;
    var startSeg = seg || _defaultSeg(line);
    var crossedHard = false;
    for (;;) {
      while (startRow > 0 && startSeg.lo === 0) {
        var prev = buffer.getLine(startRow);
        if (!prev || !prev.isWrapped) break;
        var before = _lastSegment(buffer.getLine(startRow - 1));
        if (!before) break;
        startRow--;
        startSeg = before;
      }
      if (crossedHard || startRow === 0) break;
      var above = buffer.getLine(startRow - 1);
      var cur = buffer.getLine(startRow);
      if (cur && !cur.isWrapped && _segmentLike(above, startSeg) && _hardJoins(above, cur, startSeg)) {
        startRow--;            // cross the hard newline upward
        crossedHard = true;
        continue;              // climb the predecessor's soft-wrap chain
      }
      break;
    }
    // Collect forward: soft-wrapped continuations always; a single hard-newline
    // row only when the conservative heuristic says the token was split.
    var first = buffer.getLine(startRow);
    if (!first) return { startRow: startRow, objs: [] };
    var lineObjs = [{ line: first, row: startRow, seg: startSeg, stripChars: 0, trimEnd: -1 }];
    var row = startRow + 1;
    var joinedHard = false;
    while (row < buffer.length) {
      var ln = buffer.getLine(row);
      if (!ln) break;
      var last = lineObjs[lineObjs.length - 1];
      if (ln.isWrapped) {
        var next = last.seg.hi === last.line.length ? _firstSegment(ln) : null;
        if (!next) break;
        lineObjs.push({ line: ln, row: row, seg: next, stripChars: 0, trimEnd: -1 });
        row++;
        continue;
      }
      if (joinedHard || !_segmentLike(ln, last.seg)) break;   // at most one hard-newline join per logical line
      var stripChars = _hardJoinStrip(last.line, ln, last.seg);
      if (stripChars < 0) break;
      lineObjs.push({ line: ln, row: row, seg: last.seg, stripChars: stripChars, trimEnd: -1 });
      joinedHard = true;
      row++;                   // keep collecting the joined row's soft-wrap chain
    }
    return { startRow: startRow, objs: lineObjs };
  }

  // Build the merged string from rows { line, row, seg, stripChars, trimEnd }:
  // only the segment's cells are read, and of those `stripChars` leading
  // characters (a continuation's indent or frame) and everything from string
  // index `trimEnd` on (a box's right edge) stay out of the text. Non-final
  // wrapped rows keep a trailing pad space when a wide CJK glyph could not
  // split across the margin; trim it so the URL/path is not severed at the
  // wrap point (D30).
  function _buildLogical(lineObjs, startRow) {
    var text = '';
    var rows = [];
    for (var i = 0; i < lineObjs.length; i++) {
      var l = lineObjs[i].line;
      var seg = lineObjs[i].seg || _wholeSeg(l);
      var strip = lineObjs[i].stripChars || 0;
      var full = _segText(l, seg, i < lineObjs.length - 1);
      var rowText = lineObjs[i].trimEnd >= 0 ? full.slice(strip, lineObjs[i].trimEnd) : full.slice(strip);
      rows.push({ line: l, row: lineObjs[i].row, strStart: text.length,
        strLen: rowText.length, cellStart: seg.lo + strip, cellLo: seg.lo, cellEnd: seg.hi });
      text += rowText;
    }
    return { text: text, startRow: lineObjs.length ? lineObjs[0].row : startRow, rows: rows };
  }

  function _getLogicalLine(buffer, bufRow) {
    var strict = _strictRows(buffer, bufRow);
    return _buildLogical(strict.objs, strict.startRow);
  }

  // The column `chars` string characters after cell `col`. A wide glyph is one
  // character over two cells; a glyph outside the BMP is two characters in one.
  function _advanceCol(line, col, chars) {
    var lineLen = line.length;
    while (chars > 0 && col < lineLen) {
      var cell = line.getCell(col);
      var glyph = cell && typeof cell.getChars === 'function' ? cell.getChars() : '';
      col += cell ? (cell.getWidth() || 1) : 1;
      chars -= glyph.length || 1;
    }
    return col;
  }

  // --- Rows a program wrapped by itself ---
  //
  // A TUI (Claude Code, Codex, an editor) wraps its own text and writes each
  // row separately, so neither tmux nor xterm knows the rows belong together,
  // and the continuation comes with an indent or a box edge in front. What
  // such a seam looks like is known, though: a program only breaks a word
  // where its row is full, or at a break opportunity such as `/` or `-`.
  //
  // _looseSeam reads two rows that way and says how sure it is:
  //   strong - the row is full at the right edge of its block and the token
  //            would not have fitted on one row; or the row ends at a break
  //            opportunity and what follows could not have fitted after it.
  //   weak   - it could be one token.
  // _linkLine then decides. A path is asked about on the pane's machine: the
  // joined path existing joins the rows, and either row's own path existing
  // keeps them apart; only when nothing exists (or nobody can say) does a
  // strong seam join on its looks. A URL has nothing to be checked against,
  // so it joins on a strong seam only. The strict rules above stay as they
  // are and need no confirmation.

  var FRAME_CLASS = '\\u2500-\\u259f';        // box drawing and block elements
  var GUTTER_RE = new RegExp('^[\\s' + FRAME_CLASS + ']*');
  var GUTTER_FRAME_RE = new RegExp('[' + FRAME_CLASS + '](\\s*)$');
  var RIGHT_FRAME_RE = new RegExp('(\\s*)[' + FRAME_CLASS + '][\\s' + FRAME_CLASS + ']*$');
  var FRAME_GLYPH_RE = new RegExp('[' + FRAME_CLASS + ']');
  var CJK_IDEOGRAPH_RE = /[一-鿿]/;
  var LOOSE_MAX_MARKER = 8;   // `10. `, `- [ ] `: how far left of its continuation a first row may start
  var LOOSE_MAX_TOKEN = 2048;
  var LOOSE_EDGE_MARGIN = 8;  // the right margin a TUI keeps
  var LOOSE_BLOCK_ROWS = 6;   // neighbours that show where a block's text ends
  var LOOSE_MAX_ROWS = 12;    // rows one link may be put together from
  // Where a wrapper that breaks inside a path may do so (Unicode line breaking
  // as Codex's textwrap applies it): after a `/` that a letter follows, after
  // a hyphen between letters or digits, and next to an ideograph.
  var BREAK_SEAM_RE = /\/[A-Za-z_]$|[A-Za-z0-9]-[A-Za-z0-9]$/;
  var PIECE_END_RE = /\/(?=[A-Za-z_])|[A-Za-z0-9]-(?=[A-Za-z0-9])|(?=[一-鿿])/;

  // What such a wrapper keeps together at the start of `head`: the text up to
  // its first break opportunity.
  function _firstPiece(head) {
    var m = PIECE_END_RE.exec(head);
    return m ? head.slice(0, m.index + m[0].length) : head;
  }

  // A segment without its frame: content is text[start, end), string indices
  // from the segment's first cell. padLeft / padRight count the spaces between
  // a frame glyph (or the line that bounds the segment) and the content, -1
  // without one; `divider` says the right one is the segment's bounding line.
  // The left gutter is spaces and frame glyphs, one cell each, so `start` is a
  // column offset as well as a string index.
  function _rowContent(line, seg) {
    seg = seg || _wholeSeg(line);
    var raw = _segText(line, seg, false);
    var text = raw.replace(/\s+$/, '');
    var gutter = GUTTER_RE.exec(text)[0];
    var start = gutter.length;
    var end = text.length;
    var padRight = -1;
    var divider = false;
    var right = RIGHT_FRAME_RE.exec(text);
    if (right) {
      end = Math.max(start, right.index);
      padRight = right[1].length;
    } else if (seg.hi < line.length) {
      padRight = raw.length - text.length;
      divider = true;
    }
    var left = GUTTER_FRAME_RE.exec(gutter);
    var padLeft = left ? left[1].length : seg.lo > 0 ? gutter.length : -1;
    return { text: text, start: start, end: end, padLeft: padLeft, padRight: padRight, divider: divider };
  }

  // As far as the screen shows, column `endCol` is where this block's text
  // ends: none of the rows around reaches further right in the same segment.
  // Blank rows, rules and rows laid out otherwise bound the block.
  function _isBlockEdge(buffer, row, endCol, seg) {
    for (var dir = -1; dir <= 1; dir += 2) {
      var r = dir < 0 ? row - 1 : row + 1;
      for (var n = 0; n < LOOSE_BLOCK_ROWS; n++, r += dir) {
        var line = r >= 0 ? buffer.getLine(r) : null;
        if (!line || !_segmentLike(line, seg)) break;
        var content = _rowContent(line, seg);
        if (content.end <= content.start) break;
        if (_advanceCol(line, seg.lo, content.end) > endCol) return false;
      }
    }
    return true;
  }

  // The hard newline between buffer rows `row` and `row + 1`. Returns null when
  // the two rows are not one token, else
  //   strip, end - what to leave out of the row below, where the row above ends
  //   strong     - see above
  //   url        - a URL may join here: strong, and either the edge is exact
  //                (the terminal's or a box's) or what follows reads like the
  //                rest of a URL and not like the next word of a sentence
  //   tail, head - the two halves, for _seamFragments
  // Both rows are read in segment `seg` (the upper row's first when none is
  // given); without that segment in both, there is no seam.
  function _looseSeam(buffer, row, seg) {
    if (typeof LinkDetect === 'undefined') return null;
    var above = buffer.getLine(row);
    var below = buffer.getLine(row + 1);
    if (!above || !below || below.isWrapped) return null;
    seg = seg || _defaultSeg(above);
    if (!_segmentLike(above, seg) || !_segmentLike(below, seg)) return null;
    var a = _rowContent(above, seg);
    var b = _rowContent(below, seg);
    if (a.end <= a.start || b.end <= b.start) return null;
    // A rule, or a pane's top border with its title, neither goes on from the
    // row above nor into the row below.
    if (RULE_RE.test(b.text.slice(0, b.start))
      || (RULE_RE.test(a.text.slice(0, a.start)) && RULE_RE.test(a.text.slice(a.end)))) return null;
    // In a pane of a split window tmux breaks a long line at the pane's edge
    // and cannot tell the terminal: the row is full to the edge, and the rest
    // starts in the pane's first column, wherever the line itself started.
    var reachesEdge = a.divider ? a.padRight === 0 : a.padRight < 0 && _segFull(above, seg);
    var inPane = seg.lo > 0 || seg.hi < above.length;
    var paneWrap = inPane && reachesEdge && b.start === 0;
    // Otherwise a first row starts where its continuation does, or left of it by a marker.
    if (!paneWrap && (a.start > b.start || b.start - a.start > LOOSE_MAX_MARKER)) return null;
    var aText = a.text.slice(a.start, a.end);
    var bText = b.text.slice(b.start, b.end);
    var tail = /\S+$/.exec(aText);
    var head = /^\S+/.exec(bText);
    if (!tail || !head) return null;
    tail = tail[0];
    head = head[0];
    if (tail.length > LOOSE_MAX_TOKEN || head.length > LOOSE_MAX_TOKEN) return null;
    // What the row below starts with has to read as the rest of a token: not
    // punctuation alone, and not the start of a link of its own.
    var cjkLead = CJK_IDEOGRAPH_RE.test(head.charAt(0));
    if (!cjkLead && !/[A-Za-z0-9_.\/~\-%?=&#]/.test(head.charAt(0))) return null;
    if (!/[A-Za-z0-9一-鿿]/.test(head)) return null;
    if (/^(?:[A-Za-z][A-Za-z0-9+.\-]*:\/\/|www\.|~\/|\.{1,2}\/|[A-Za-z]:[\\\/])/i.test(head)) return null;
    // And one link has to run across the seam.
    var seamAt = tail.length;
    var spans = LinkDetect.findLinks(tail + head).some(function (m) {
      return m.start < seamAt && m.end > seamAt;
    });
    if (!spans) return null;

    var endCol = _advanceCol(above, seg.lo, a.end);
    var headCol = seg.lo + b.start;
    // A wrapper moves a word that fits to the next row whole; it only breaks
    // one that is longer than the row. With the row above full, the token is
    // that long exactly when what continues it is wider than what precedes it.
    var lead = Math.max(0, _advanceCol(above, seg.lo, a.end - tail.length) - headCol);
    var longer = _advanceCol(below, headCol, head.length) - headCol > lead;
    // Where the row above ends: the terminal's last column or a pane's edge,
    // flush against a box (with the padding the row below shows), or the
    // block's own edge.
    var exact = reachesEdge
      || (a.padRight >= 0 && b.padLeft >= 0 && (a.padRight === 0 || a.padRight === b.padLeft));
    var blockEdge = null;
    var atBlockEdge = function () {
      if (blockEdge === null) blockEdge = _isBlockEdge(buffer, row, endCol, seg);
      return blockEdge;
    };
    var edge = exact || (a.padRight < 0 && seg.hi - endCol <= LOOSE_EDGE_MARGIN && atBlockEdge());
    // `es/12345`, `ing-started`, `v2`: not `for` or `and.`
    var rest = /[\/.\-_=&?%#~+0-9]/.test(head.replace(/[.,;:!?)\]}>'"]+$/, ''));
    // A wrapper that breaks after `/` and `-` leaves its row short instead: the
    // row ends at the last break before the piece that no longer fitted. So
    // when the piece the row below starts with would have run past the right
    // edge, the break was the wrapper's, wherever the row above ends. A plain
    // word there is more likely the sentence going on after a directory.
    var limit = a.padRight < 0 ? seg.hi
      : _advanceCol(above, seg.lo, a.end + a.padRight) - Math.max(0, b.padLeft);
    var forced = !cjkLead && rest && BREAK_SEAM_RE.test(tail.slice(-2) + head.charAt(0))
      && endCol + _advanceCol(below, headCol, _firstPiece(head).length) - headCol > limit;
    var full = !cjkLead && longer && edge;
    // tmux breaks anywhere, a word as well; text that starts with an ideograph
    // after a full row is still more likely prose.
    var wrapped = !cjkLead && paneWrap;
    if (!full && !forced && !edge && !LinkDetect.shouldJoinHardWrap(aText, true, bText) && !(longer && atBlockEdge())) {
      return null;
    }
    // A URL has nothing to be checked against, and one that ends in `/` is
    // complete as often as not: only a full row joins it.
    return { strip: b.start, end: a.end, strong: full || forced || wrapped,
      url: (full && (exact || rest)) || wrapped, tail: tail, head: head };
  }

  // What the rows of a seam name when each is read on its own: the path that
  // ends the row above and the one that starts the row below.
  function _seamFragments(seam) {
    var paths = [];
    var tails = LinkDetect.findLinks(seam.tail);
    var last = tails[tails.length - 1];
    if (last && last.kind !== 'web') paths.push(last.text);
    var first = LinkDetect.findLinks(seam.head)[0];
    if (first && first.kind !== 'web' && first.start === 0) paths.push(first.text);
    return paths;
  }

  // The strict rows, extended at both ends across the seams _looseSeam accepts.
  // A row reached that way carries `loose`; _linkLine decides whether it stays.
  function _looseRows(buffer, bufRow, seg) {
    var objs = _strictRows(buffer, bufRow, seg).objs;
    if (!objs.length) return objs;
    var added = 0;
    var seam, r, ln, s, cur;
    while (added < LOOSE_MAX_ROWS && objs[0].row > 0 && (seam = _looseSeam(buffer, objs[0].row - 1, objs[0].seg))) {
      objs[0].stripChars = seam.strip;
      objs[0].loose = seam;
      r = objs[0].row - 1;
      var head = [{ line: buffer.getLine(r), row: r, seg: objs[0].seg, stripChars: 0, trimEnd: seam.end }];
      while (head[0].line.isWrapped && head[0].seg.lo === 0 && r > 0
        && (ln = buffer.getLine(r - 1)) && (s = _lastSegment(ln))) {
        r--;
        head.unshift({ line: ln, row: r, seg: s, stripChars: 0, trimEnd: -1 });
      }
      objs = head.concat(objs);
      added++;
    }
    while (added < LOOSE_MAX_ROWS && (seam = _looseSeam(buffer, objs[objs.length - 1].row, objs[objs.length - 1].seg))) {
      objs[objs.length - 1].trimEnd = seam.end;
      r = objs[objs.length - 1].row + 1;
      cur = { line: buffer.getLine(r), row: r, seg: objs[objs.length - 1].seg, stripChars: seam.strip, trimEnd: -1, loose: seam };
      objs.push(cur);
      for (r++; r < buffer.length && (ln = buffer.getLine(r)) && ln.isWrapped
        && cur.seg.hi === cur.line.length && (s = _firstSegment(ln)); r++) {
        cur = { line: ln, row: r, seg: s, stripChars: 0, trimEnd: -1 };
        objs.push(cur);
      }
      added++;
    }
    return objs;
  }

  // The logical line the links on `bufRow` are read from.
  //
  // lookup(path) says whether a path exists: true, false, or undefined when
  // that is not known. While `settled` is false an unknown path is returned
  // in `pending` and its seam is left out for now: an unconfirmed guess never
  // changes what the strict rules found. Once the machine has been asked
  // (`settled`), unknown means nobody can say, and a strong seam goes by its
  // looks. A seam no link runs across is always left out. The row is read in
  // segment `seg`, or in its first one.
  function _linkLine(buffer, bufRow, lookup, settled, seg) {
    var objs = _looseRows(buffer, bufRow, seg);
    var logical = _buildLogical(objs, bufRow);
    var pending = [];
    if (!objs.some(function (obj) { return obj.loose; })) return { logical: logical, pending: pending };
    var ask = function (path) {
      var known = lookup ? lookup(path) : undefined;
      if (known === undefined && !settled && pending.indexOf(path) < 0) pending.push(path);
      return known;
    };
    var links = LinkDetect.findLinks(logical.text);
    var cut = {};
    var anyCut = false;
    var at = -1;
    for (var i = 0; i < objs.length; i++) {
      if (objs[i].row === bufRow) at = i;
      var seam = objs[i].loose;
      if (!seam) continue;
      var seamAt = logical.rows[i].strStart;
      var link = null;
      for (var j = 0; j < links.length && !link; j++) {
        if (links[j].start < seamAt && links[j].end > seamAt) link = links[j];
      }
      var keep = false;
      if (link && link.kind === 'web') {
        keep = seam.url;
      } else if (link) {
        var joined = ask(link.text);
        if (joined === true) {
          keep = true;
        } else if (seam.strong) {
          // A row that names a file by itself was not broken, however full it
          // looks; a false join there would take away a link that works.
          var apart = _seamFragments(seam).map(ask);
          var open = !settled && (joined === undefined || apart.indexOf(undefined) >= 0);
          keep = !open && apart.indexOf(true) < 0;
        }
      }
      if (!keep) { cut[i] = true; anyCut = true; }
    }
    if (!anyCut || at < 0) return { logical: logical, pending: pending };
    // Back to the rows between two rejected seams, each read whole again.
    var lo = at;
    while (lo > 0 && !cut[lo]) lo--;
    var hi = at;
    while (hi < objs.length - 1 && !cut[hi + 1]) hi++;
    var kept = objs.slice(lo, hi + 1).map(function (obj) {
      return { line: obj.line, row: obj.row, seg: obj.seg, stripChars: obj.stripChars, trimEnd: obj.trimEnd };
    });
    if (cut[lo]) kept[0].stripChars = 0;
    if (hi < objs.length - 1) kept[kept.length - 1].trimEnd = -1;
    return { logical: _buildLogical(kept, bufRow), pending: pending };
  }

  // The logical lines the links on row `bufRow` are read from, one for each
  // segment with text, and every path still to be asked about. `parts` keeps
  // each segment with its own: in a split window each is another pane, and a
  // relative path means something else in each. lookupFor(seg), when given,
  // is the lookup for that segment's pane.
  function _rowLinkLines(buffer, bufRow, lookup, settled, lookupFor) {
    var out = { lines: [], pending: [], parts: [] };
    var line = buffer.getLine(bufRow);
    if (!line) return out;
    _segmentsOf(line).forEach(function (seg) {
      if (!/\S/.test(_segText(line, seg, false))) return;
      var read = _linkLine(buffer, bufRow, lookupFor ? lookupFor(seg) : lookup, settled, seg);
      out.lines.push(read.logical);
      out.parts.push({ seg: seg, logical: read.logical, pending: read.pending });
      read.pending.forEach(function (path) {
        if (out.pending.indexOf(path) < 0) out.pending.push(path);
      });
    });
    return out;
  }

  // --- Which pane a link is in ---
  //
  // In a split window the screen shows every pane, and a relative path means
  // what it means in the pane it is printed in. tmux reports where each pane
  // is in the window (the workspace API's `geometry`, in cells); the screen
  // adds the status line when it is on top, and that offset is read off the
  // screen: it is where the borders between the panes are drawn.

  var LAYOUT_FRESH_MS = 3000;
  var LAYOUT_MAX_OFFSET = 5;          // tmux shows at most five status lines
  var DIVIDER_CELL_RE = new RegExp(DIVIDER_RE.source);
  var RULE_START_RE = new RegExp('^\\s*' + RULE_RE.source);

  // The pane layout of the window a terminal shows, fetched with
  // fetchPanes() and kept briefly; null without a way to fetch it. A failed
  // fetch counts as no layout until it is due again.
  function _paneLayout(term, fetchPanes) {
    if (typeof fetchPanes !== 'function') return null;
    var panes = null;
    var at = 0;
    var size = '';
    var flight = null;
    var sizeOf = function () { return term.cols + 'x' + term.rows; };
    var fresh = function () {
      return panes && Date.now() - at < LAYOUT_FRESH_MS && size === sizeOf() ? panes : null;
    };
    return {
      fresh: fresh,
      load: function () {
        var known = fresh();
        if (known) return Promise.resolve(known);
        if (!flight) {
          var asked = sizeOf();
          flight = Promise.resolve().then(fetchPanes).then(function (list) {
            return Array.isArray(list) ? list : [];
          }, function () { return []; }).then(function (list) {
            panes = list;
            at = Date.now();
            size = asked;
            flight = null;
            return list;
          });
        }
        return flight;
      },
    };
  }

  function _geometryOf(pane) {
    var g = pane && pane.geometry;
    return g && [g.x, g.y, g.width, g.height].every(function (n) { return typeof n === 'number' && n >= 0; }) ? g : null;
  }

  // Rows of status line above the window: the offset at which the most
  // borders (a horizontal line just above or below a pane) are on screen.
  function _layoutOffset(list, buffer) {
    var base = buffer.baseY || 0;
    var best = 0;
    var bestScore = 0;
    for (var off = 0; off <= LAYOUT_MAX_OFFSET; off++) {
      var score = 0;
      for (var i = 0; i < list.length; i++) {
        var g = _geometryOf(list[i]);
        var rows = [g.y - 1, g.y + g.height];
        for (var k = 0; k < rows.length; k++) {
          var line = rows[k] + off >= 0 ? buffer.getLine(base + rows[k] + off) : null;
          if (line && RULE_START_RE.test(line.translateToString(false, g.x, g.x + g.width))) score++;
        }
      }
      if (score > bestScore) { best = off; bestScore = score; }
    }
    return best;
  }

  // The layout is that of the screen: every pane that does not start at the
  // left edge has a vertical border just left of it. A zoomed window, another
  // window or borders drawn otherwise do not pass.
  function _layoutOnScreen(list, buffer, off) {
    var base = buffer.baseY || 0;
    return list.every(function (pane) {
      var g = _geometryOf(pane);
      if (g.x === 0) return true;
      var line = buffer.getLine(base + off + g.y + Math.floor(g.height / 2));
      return !!line && DIVIDER_CELL_RE.test(line.translateToString(false, g.x - 1, g.x));
    });
  }

  // The id of the pane cell (col, bufRow) is in, or null when that cannot be
  // told (a border, a layout that is not the screen's).
  function _paneAt(panes, buffer, col, bufRow) {
    var list = (panes || []).filter(function (pane) { return pane && pane.id && _geometryOf(pane); });
    if (list.length === 1) return list[0].id;
    if (!list.length) return null;
    var off = _layoutOffset(list, buffer);
    if (!_layoutOnScreen(list, buffer, off)) return null;
    var row = bufRow - (buffer.baseY || 0) - off;
    var inside = list.filter(function (pane) {
      var g = _geometryOf(pane);
      return col >= g.x && col < g.x + g.width && row >= g.y && row < g.y + g.height;
    });
    return inside.length === 1 ? inside[0].id : null;
  }

  // Convert a string offset in the merged logical line to { y (1-based
  // lineNumber), x (1-based terminal column) }, correctly handling wide
  // (CJK) characters by walking cells.
  function _logicalStrOffsetToTermPos(rows, strOffset) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (strOffset < r.strStart + r.strLen || i === rows.length - 1) {
        var strInRow = Math.max(0, Math.min(strOffset - r.strStart, r.strLen));
        return { y: r.row + 1, x: _advanceCol(r.line, r.cellStart || 0, strInRow) + 1 };
      }
    }
    var last = rows[rows.length - 1];
    return { y: last.row + 1, x: last.line.length + 1 };
  }

  // A link that runs over rows of a pane or a box, as one range per row, or
  // null for any other link. xterm takes a range as every cell from its start
  // to its end, which here would take in the pane beside it or the box's
  // edges: hovering over the next pane would open this link.
  function _rowRanges(rows, f) {
    var spanned = rows.filter(function (r) {
      return r.strLen > 0 && r.strStart < f.endCol && r.strStart + r.strLen > f.startCol;
    });
    if (spanned.length < 2) return null;
    if (!spanned.some(function (r) { return r.cellLo > 0 || r.cellEnd < r.line.length; })) return null;
    return spanned.map(function (r) {
      var start = _logicalStrOffsetToTermPos(rows, Math.max(f.startCol, r.strStart));
      var end = _logicalStrOffsetToTermPos(rows, Math.min(f.endCol, r.strStart + r.strLen) - 1);
      return { start: start, end: { y: end.y, x: Math.max(end.x, start.x) } };
    });
  }

  // --- Open from tmux paste buffer ---

  function _cleanBufferText(text) {
    // Join wrapped/indented lines, strip :line:col suffix
    var cleaned = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('');
    cleaned = cleaned.replace(/:\d+(?::\d+)?$/, '');
    cleaned = cleaned.replace(/\(\d+(?:,\d+)?\)$/, '');
    return cleaned;
  }

  function openFromBuffer(paneId) {
    var source = _sourceForPane(paneId);
    paneId = source.paneId;
    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    // No usable path → open the pane's cwd. '.' is resolved server-side against
    // #{pane_current_path} (resolveInputPath).
    var openCwd = function () { openFile('.', paneId, { source: source }); };
    fetch(_machine(source) + '/api/files/tmux-buffer', { headers: _authHeaders })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var p = (res && res.success && res.data && res.data.path) ? res.data.path : '';
        if (!p) { openCwd(); return; }
        // The buffer endpoint hands back its raw text as "path" with no
        // validation, so confirm it resolves to a real file/dir before opening;
        // otherwise (clipboard has no matching path) fall back to the cwd.
        var probe = (typeof LinkDetect !== 'undefined') ? LinkDetect.parseLineRef(p).path : p;
        var qs = '?path=' + encodeURIComponent(probe)
          + (paneId ? '&paneId=' + encodeURIComponent(paneId) : '');
        fetch(_machine(source) + '/api/files/info' + qs, { headers: _authHeaders })
          .then(function (r) { return r.json(); })
          .then(function (info) {
            if (info && info.success) { openFile(p, paneId, { source: source }); } else { openCwd(); }
          })
          .catch(openCwd);
      })
      .catch(openCwd);
  }

  // --- Link Provider ---

  // Dispatch a matched link by kind. Web opens a browser tab; file opens the
  // preview; ambiguous (e.g. example.com) asks the user which one (project rule:
  // don't guess URL-vs-file — let the user choose).
  function _activateLink(f, paneId, source) {
    if (f.unverified) { _activateUnverified(f, paneId, source); return; }
    if (f.kind === 'web') { _openWeb(f.href); return; }
    if (f.kind === 'ambiguous') { _showLinkChooser(f, paneId, source); return; }
    openFile(f.text, paneId, { lineRef: f.lineRef, source: source });
  }

  // --- Does a path exist? ---
  //
  // What decides the seams _linkLine is not sure about. Answers are kept
  // briefly: xterm asks for a row's links again on every repaint under the
  // pointer, and a file an agent just named may be created a moment later.

  var EXISTS_OK_MS = 60000;
  var EXISTS_MISS_MS = 8000;
  var EXISTS_WAIT_MS = 2500;          // a slow machine must not hold the links back
  var EXISTS_MAX_PATHS = 8;
  var EXISTS_CACHE_MAX = 400;
  var EXISTS_UNSUPPORTED_MS = 300000; // a Node from before /api/files/exists
  var _existsCache = new Map();
  var _existsFlights = new Map();
  var _existsUnsupported = new Map();

  function _existsKey(machine, paneId, path) {
    return machine + '\n' + (paneId || '') + '\n' + path;
  }

  // true / false, or undefined when there is no fresh answer.
  function _knownToExist(machine, paneId, path) {
    var hit = _existsCache.get(_existsKey(machine, paneId, path));
    if (!hit || Date.now() - hit.at > (hit.ok ? EXISTS_OK_MS : EXISTS_MISS_MS)) return undefined;
    return hit.ok;
  }

  // Asks the pane's machine about `paths` and settles once the answers are in
  // the cache, or once it is clear there will be none. Never rejects.
  function _checkExists(machine, paneId, paths) {
    if (typeof fetch !== 'function' || !paths.length) return Promise.resolve();
    if ((_existsUnsupported.get(machine) || 0) > Date.now()) return Promise.resolve();
    var wanted = paths.slice(0, EXISTS_MAX_PATHS);
    var flightKey = _existsKey(machine, paneId, wanted.join('\n'));
    var flying = _existsFlights.get(flightKey);
    if (flying) return flying;
    var query = wanted.map(function (path) { return 'path=' + encodeURIComponent(path); });
    if (paneId) query.unshift('paneId=' + encodeURIComponent(paneId));
    var done = function () { _existsFlights.delete(flightKey); };
    var flight;
    try {
      flight = Promise.resolve(fetch(machine + '/api/files/exists?' + query.join('&'), {
        headers: typeof Auth !== 'undefined' ? Auth.headers() : {},
        cache: 'no-store',
      })).then(function (response) {
        if (response.status === 404) _existsUnsupported.set(machine, Date.now() + EXISTS_UNSUPPORTED_MS);
        return response.ok ? response.json() : null;
      }).then(function (result) {
        var list = result && result.success && result.data && result.data.exists;
        if (!Array.isArray(list)) return;
        if (_existsCache.size > EXISTS_CACHE_MAX) _existsCache.clear();
        var now = Date.now();
        wanted.forEach(function (path, i) {
          _existsCache.set(_existsKey(machine, paneId, path), { ok: list[i] === true, at: now });
        });
      }).catch(function () { /* no answer: the seams stay as the strict rules left them */ }).then(done);
    } catch (_) {
      return Promise.resolve();
    }
    _existsFlights.set(flightKey, flight);
    return flight;
  }

  function _withinWait(promise) {
    return new Promise(function (resolve) {
      var timer = setTimeout(resolve, EXISTS_WAIT_MS);
      promise.then(function () { clearTimeout(timer); resolve(); });
    });
  }

  // A tap cannot wait for the answer (the terminal needs its focus in the
  // gesture), so hitTest hands over the joined path unconfirmed, with what the
  // strict rules found under the finger to fall back on. Without that, the
  // joined path is still the best reading of what was tapped.
  function _activateUnverified(f, paneId, source) {
    var origin = source || _sourceForPane(paneId);
    var machine = _machine(origin);
    _withinWait(_checkExists(machine, origin.paneId, [f.text])).then(function () {
      var known = _knownToExist(machine, origin.paneId, f.text);
      if (known === true || !f.fallback || (known === undefined && f.strong)) {
        openFile(f.text, paneId, { lineRef: f.lineRef, source: source });
      } else {
        _activateLink(f.fallback, paneId, source);
      }
    });
  }

  // --- OSC 8 hyperlinks ---
  //
  // A program that marks its own links (tmux forwards them to the panel's
  // clients, see lib/terminal/hyperlinks.js) says where each one leads, on
  // every cell of it: no guess from the text, and no wrap can break it. xterm
  // asks for these before the provider below.
  // actOnPane(col, bufRow, action) runs action(paneId, source) for the pane
  // the link's first cell is in.
  function _hyperlinkHandler(term, actOnPane, isCurrent) {
    return {
      // file: links and the bare paths some programs emit are the point.
      allowNonHttpProtocols: true,
      activate: function (_event, uri, range) {
        var target = typeof LinkDetect !== 'undefined' ? LinkDetect.parseHyperlink(uri) : null;
        if (!target) return;
        // Like a detected link: window.open stays inside the click.
        if (target.kind === 'web') { _openWeb(target.href); return; }
        if (target.kind !== 'file') {
          if (window._showToast) window._showToast('面板不打开 ' + target.text + ': 链接');
          return;
        }
        if (isCurrent && !isCurrent()) {
          if (window._showToast) window._showToast('终端来源尚未确认，请连接后重试');
          return;
        }
        var start = range && range.start ? range.start : { x: 0, y: 0 };
        actOnPane(start.x - 1, start.y - 1, function (pane, source) {
          _activateLink({ kind: 'file', text: target.text, lineRef: target.lineRef }, pane, source);
        });
      },
      // The text on screen is the program's choice; show where the link goes.
      hover: function (_event, uri, range) {
        if (term.element) term.element.title = uri;
        _underlineRows(term, _hyperlinkRows(term, uri, range));
      },
      leave: function () {
        if (term.element) term.element.removeAttribute('title');
        _underlineRows(term, []);
      },
    };
  }

  // xterm reports the cells a hyperlink has on one row as a link of their own,
  // so under the pointer only that row is underlined, although every row
  // opens the same address. The other rows are found and underlined here.

  // xterm's own provider of hyperlinks, or null in a build that keeps it
  // elsewhere: then one row is underlined, as xterm does by itself.
  function _hyperlinkProvider(term) {
    try {
      var list = term._core._linkProviderService.linkProviders;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i]._oscLinkService && typeof list[i].provideLinks === 'function') return list[i];
      }
    } catch (_) { /* not this build */ }
    return null;
  }

  // From cell `col` on in direction `dir` the row holds nothing but padding,
  // up to its end or to a frame (a box, the border of a tmux pane).
  function _onlyPadding(line, col, dir) {
    for (; col >= 0 && col < line.length; col += dir) {
      var cell = line.getCell(col);
      var glyph = cell ? cell.getChars() : '';
      if (glyph && glyph !== ' ') return FRAME_GLYPH_RE.test(glyph);
    }
    return true;
  }

  // The cells the hyperlink to `uri` has on the rows around `range` (its cells
  // on one row, as xterm counts them: from 1, both ends included). A row
  // belongs to the same link when it carries the same address, the upper of
  // two rows ends with it and the lower one starts with it.
  function _hyperlinkRows(term, uri, range) {
    var provider = _hyperlinkProvider(term);
    var buffer = term.buffer && term.buffer.active;
    if (!provider || !buffer || !range) return [];
    var linksOn = function (y) {
      var found = [];
      try {
        provider.provideLinks(y, function (links) { found = links || []; });
      } catch (_) { found = []; }
      return found;
    };
    var rows = [];
    [1, -1].forEach(function (dir) {
      var cur = range;
      for (var n = 0; n < LOOSE_MAX_ROWS; n++) {
        var here = buffer.getLine(cur.start.y - 1);
        var there = buffer.getLine(cur.start.y - 1 + dir);
        if (!here || !there) return;
        if (!_onlyPadding(here, dir > 0 ? cur.end.x : cur.start.x - 2, dir)) return;
        var next = null;
        linksOn(cur.start.y + dir).forEach(function (link) {
          if (next || link.text !== uri) return;
          if (_onlyPadding(there, dir > 0 ? link.range.start.x - 2 : link.range.end.x, -dir)) next = link.range;
        });
        if (!next) return;
        rows.push(next);
        cur = next;
      }
    });
    return rows;
  }

  var _linkUnderlines = typeof WeakMap === 'function' ? new WeakMap() : null;

  // Underline `ranges` the way xterm underlines the row under the pointer, in
  // place of whatever this terminal had underlined before.
  function _underlineRows(term, ranges) {
    if (!_linkUnderlines) return;
    (_linkUnderlines.get(term) || []).forEach(function (bar) { bar.remove(); });
    _linkUnderlines.delete(term);
    var screen = ranges.length && term.element && typeof term.element.querySelector === 'function'
      ? term.element.querySelector('.xterm-screen') : null;
    if (!screen) return;
    var box = screen.getBoundingClientRect();
    var cellWidth = box.width / term.cols;
    var cellHeight = box.height / term.rows;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return;
    var first = term.buffer.active.viewportY;
    var color = (term.options && term.options.theme && term.options.theme.foreground) || 'currentColor';
    var ratio = window.devicePixelRatio || 1;
    var bars = [];
    ranges.forEach(function (range) {
      var row = range.start.y - 1 - first;
      if (row < 0 || row >= term.rows) return;
      var bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;pointer-events:none;z-index:6;height:1px;'
        + 'left:' + (range.start.x - 1) * cellWidth + 'px;'
        + 'top:' + ((row + 1) * cellHeight - 1 - 1 / ratio) + 'px;'
        + 'width:' + (range.end.x - range.start.x + 1) * cellWidth + 'px';
      bar.style.background = color;
      screen.appendChild(bar);
      bars.push(bar);
    });
    if (bars.length) _linkUnderlines.set(term, bars);
  }

  function _openWeb(href) {
    // Only ever open http(s) — defensive gate against a future caller passing a
    // javascript:/data: href (detectors only ever emit http(s) today).
    if (href && /^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
  }

  function _showLinkChooser(f, paneId, source) {
    var ov = document.createElement('div');
    ov.className = 'fp-overlay fp-chooser';
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    var box = document.createElement('div');
    box.className = 'fp-chooser-box';
    var q = document.createElement('div');
    q.className = 'fp-chooser-q';
    q.textContent = f.text;
    var sub = document.createElement('div');
    sub.className = 'fp-chooser-sub';
    sub.textContent = '作为网址还是文件打开？';
    var row = document.createElement('div');
    row.className = 'fp-chooser-actions';
    var web = document.createElement('button');
    web.className = 'fp-btn fp-chooser-btn';
    web.textContent = '🌐 网址';
    web.addEventListener('click', function () {
      ov.remove();
      _openWeb(f.href || (typeof LinkDetect !== 'undefined' ? LinkDetect.computeHref(f.text) : 'https://' + f.text));
    });
    var file = document.createElement('button');
    file.className = 'fp-btn fp-chooser-btn';
    file.textContent = '📄 文件';
    file.addEventListener('click', function () { ov.remove(); openFile(f.text, paneId, { source: source }); });
    row.appendChild(web);
    row.appendChild(file);
    box.appendChild(q);
    box.appendChild(sub);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    web.focus();
    ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { ov.remove(); e.stopPropagation(); } });
  }

  function _resolvePaneForAction(paneId, resolvePaneId, action) {
    if (typeof resolvePaneId !== 'function') return action(paneId);
    var resolved;
    try {
      resolved = resolvePaneId();
    } catch (_) {
      return action(paneId);
    }
    return Promise.resolve(resolved).then(
      function (livePaneId) { return action(livePaneId || paneId); },
      function () { return action(paneId); }
    );
  }

  // options.panes(), when the terminal shows a whole tmux window, resolves to
  // that window's panes as the workspace API lists them; a relative path is
  // then resolved in the pane it is printed in. Without it, in the pane this
  // terminal was given (or the one resolvePaneId names).
  function registerLinkProvider(term, paneId, resolvePaneId, source, options) {
    var origin = source ? { serverId: source.serverId, paneId: source.paneId || paneId } : null;
    var isCurrent = source && typeof source.isCurrent === 'function' ? source.isCurrent : null;
    var layout = _paneLayout(term, options && options.panes);
    // action(paneId, source) for the pane of cell (col, bufRow).
    var actOnPane = function (col, bufRow, action) {
      var given = function () {
        _resolvePaneForAction(paneId, resolvePaneId, function (livePaneId) {
          action(origin ? origin.paneId : livePaneId, origin);
        });
      };
      if (!layout) return given();
      layout.load().then(function (panes) {
        var pane = _paneAt(panes, term.buffer.active, col, bufRow);
        if (!pane) return given();
        action(pane, origin ? { serverId: origin.serverId, paneId: pane } : null);
      });
    };
    // Hyperlinks the program marked itself. Set here and not at construction:
    // this is where the pane and its machine are known.
    try {
      if (term.options) term.options.linkHandler = _hyperlinkHandler(term, actOnPane, isCurrent);
    } catch (_) { /* a terminal without the option only has detected links */ }
    var latest = 0;
    var scrollSub = term.onScroll ? term.onScroll(function () { _underlineRows(term, []); }) : null;
    var el = term.element;
    var onMouseLeave = function () { _underlineRows(term, []); };
    if (el && el.addEventListener) el.addEventListener('mouseleave', onMouseLeave);
    var registration = term.registerLinkProvider({
      provideLinks: function (lineNumber, callback) {
        var seq = ++latest;
        var bufRow = lineNumber - 1;
        // Paths are checked where the pane runs, against its directory.
        var where = origin || _sourceForPane(paneId);
        var machine = _machine(where);
        // The pane a segment of this row is in; null while the layout that
        // says so has not arrived, and nothing is known about its paths then.
        var paneFor = function (panes, seg) {
          if (!layout) return where.paneId;
          if (!panes) return null;
          return _paneAt(panes, term.buffer.active, seg.lo, bufRow) || where.paneId;
        };
        var lookupFor = function (panes) {
          return function (seg) {
            var pane = paneFor(panes, seg);
            return function (path) { return pane === null ? undefined : _knownToExist(machine, pane, path); };
          };
        };
        var read = function (settled) {
          return _rowLinkLines(term.buffer.active, bufRow, null, settled, lookupFor(layout ? layout.fresh() : null));
        };
        var first = read(false);
        // Also collect spaced-path candidates on the current logical line(s) for filesystem resolution.
        if (typeof LinkDetect !== 'undefined' && typeof LinkDetect.spacedPathCandidates === 'function') {
          first.lines.forEach(function (logical) {
            _findLinks(logical.text).forEach(function (m) {
              var cands = LinkDetect.spacedPathCandidates(logical.text, m);
              var pane = paneFor(layout ? layout.fresh() : null, { lo: 0 });
              if (!pane) return;
              cands.forEach(function (c) {
                if (c.text && _knownToExist(machine, pane, c.text) === undefined && first.pending.indexOf(c.text) < 0) {
                  first.pending.push(c.text);
                }
              });
            });
          });
        }
        if (first.pending.length === 0 || (isCurrent && !isCurrent())) {
          return callback(linksOn(first.lines, lineNumber, lookupFor(layout ? layout.fresh() : null)));
        }
        var askPanes = function (panes) {
          // Each pane is asked about its own paths, against its own directory.
          var groups = [];
          _rowLinkLines(term.buffer.active, bufRow, null, false, lookupFor(panes)).parts.forEach(function (part) {
            var pane = paneFor(panes, part.seg);
            var group = groups.filter(function (g) { return g.pane === pane; })[0];
            if (!group && (part.pending.length || first.pending.length)) {
              groups.push(group = { pane: pane, paths: [] });
            }
            if (!group) return;
            part.pending.forEach(function (path) {
              if (group.paths.indexOf(path) < 0) group.paths.push(path);
            });
            first.pending.forEach(function (path) {
              if (group.paths.indexOf(path) < 0) group.paths.push(path);
            });
          });
          return Promise.all(groups.map(function (group) {
            return _checkExists(machine, group.pane, group.paths);
          }));
        };
        var known = layout ? layout.fresh() : null;
        var asked = !layout || known ? askPanes(known) : layout.load().then(askPanes);
        _withinWait(asked).then(function () {
          // xterm asked again meanwhile (the pointer moved, the row was
          // repainted). That request answers for itself; a late answer here
          // would land in its place.
          if (seq !== latest) return;
          // Read the screen again: it may have changed while the machine answered.
          var currentLookup = lookupFor(layout ? layout.fresh() : null);
          callback(linksOn(read(true).lines, lineNumber, currentLookup));
        });
      },
    });
    return {
      dispose: function () {
        _underlineRows(term, []);
        if (scrollSub && scrollSub.dispose) scrollSub.dispose();
        if (el && el.removeEventListener) el.removeEventListener('mouseleave', onMouseLeave);
        if (registration && registration.dispose) registration.dispose();
      },
    };

    // xterm's links for one row, from the logical lines of its segments, or
    // undefined without any.
    function linksOn(lines, lineNumber, lookupSeg) {
      var all = [];
      lines.forEach(function (logical) {
        all = all.concat(linksOf(logical, lineNumber, lookupSeg));
      });
      return all.length > 0 ? all : undefined;
    }

    function linksOf(logical, lineNumber, lookupSeg) {
      var found = _findLinks(logical.text);
      if (typeof LinkDetect !== 'undefined' && typeof LinkDetect.spacedPathCandidates === 'function' && lookupSeg) {
        var check = lookupSeg({ lo: 0 });
        found = found.map(function (m) {
          var cands = LinkDetect.spacedPathCandidates(logical.text, m);
          for (var ci = cands.length - 1; ci >= 0; ci--) {
            if (check(cands[ci].text) === true) {
              var extended = Object.assign({}, m, { text: cands[ci].text, endCol: cands[ci].end });
              if (extended.end !== undefined) extended.end = cands[ci].end;
              return extended;
            }
          }
          return m;
        });
      }
      if (found.length === 0) return [];

      if (window._FP_DEBUG) {
        console.log('[FP] line', lineNumber, 'text=', JSON.stringify(logical.text), 'matches=', found);
      }

      var links = [];
      found.forEach(function (f) {
        var activate = function () {
          // Keep window.open inside the original user gesture so browsers
          // do not block ordinary web links as async popups.
          if (f.kind === 'web') { _activateLink(f, paneId); return; }
          if (isCurrent && !isCurrent()) {
            if (window._showToast) window._showToast('终端来源尚未确认，请连接后重试');
            return;
          }
          // The pane the link starts in: a relative path means what it means there.
          var first = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
          actOnPane(first.x - 1, first.y - 1, function (pane, src) {
            _activateLink(f, pane, src);
          });
        };
        var pieces = _rowRanges(logical.rows, f);
        if (!pieces) {
          var start = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
          // xterm link ranges are INCLUSIVE, so map the LAST cell (endCol-1),
          // not the exclusive end. Mapping endCol directly lands on the next
          // row when the span ends exactly at a wrap boundary (over-underline).
          var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol - 1);
          links.push({
            range: { start: start, end: { y: end.y,
              x: end.y === start.y ? Math.max(end.x, start.x) : end.x } },
            text: f.text,
            activate: activate,
          });
          return;
        }
        // One link per row, all opening the same target; under the pointer
        // xterm underlines its own row, the others are drawn here.
        pieces.forEach(function (range, i) {
          var others = pieces.filter(function (_, j) { return j !== i; });
          links.push({
            range: range,
            text: f.text,
            activate: activate,
            hover: function () { _underlineRows(term, others); },
            leave: function () { _underlineRows(term, []); },
          });
        });
      });
      links = links.filter(function (link) {
        return link.range.start.y <= lineNumber && link.range.end.y >= lineNumber;
      });

      if (window._FP_DEBUG && links.length > 0) {
        console.log('[FP] returning links for line', lineNumber, links.map(function(l) {
          return { text: l.text, range: l.range };
        }));
      }

      return links.length > 0 ? links : undefined;
    }
  }

  // --- Open File ---

  function _workingRawUrl(machine, info) {
    var tokenQs = typeof Auth !== 'undefined' ? Auth.wsTokenParam() : '';
    var revision = info.mtimeMs != null ? String(Math.round(info.mtimeMs)) : '';
    return machine + '/api/files/raw?path=' + encodeURIComponent(info.absPath)
      + (tokenQs ? '&' + tokenQs : '')
      + (revision ? '&v=' + encodeURIComponent(revision) : '');
  }

  function _loadWorkingContent(machine, absPath, headers) {
    return fetch(machine + '/api/files/content?path=' + encodeURIComponent(absPath), {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) { return r.json(); })
      .then(function (cr) {
        if (!cr.success) throw new Error(cr.error || '加载文件失败');
        return cr.data;
      });
  }

  function _loadWorkingRawText(rawUrl, headers, language) {
    return fetch(rawUrl, {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) {
        if (!r.ok) {
          var readErr = typeof r.json === 'function' ? r.json().catch(function () { return null; }) : Promise.resolve(null);
          return readErr.then(function (body) {
            throw new Error((body && body.error) || ('加载文件失败（HTTP ' + r.status + '）'));
          });
        }
        return r.text().then(function (content) {
          return { content: content, language: language || null };
        });
      });
  }

  /** A file of a kind that only reads from disk, shown as some other version. */
  function _renderUnavailable(body, message, rawUrl, filename) {
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'fp-error';
    var text = document.createElement('div');
    text.textContent = message;
    wrap.appendChild(text);
    if (rawUrl) {
      var download = document.createElement('button');
      download.className = 'fp-error-download';
      download.type = 'button';
      download.textContent = '下载这个版本';
      download.addEventListener('click', function () {
        _blobDownload(rawUrl + '&download=1', filename).catch(function (err) {
          _notifyFailure('下载失败：' + err.message);
        });
      });
      wrap.appendChild(download);
    }
    body.appendChild(wrap);
  }

  /**
   * The renderers, given where the file's bytes and text come from. `source.name` is
   * its path, which decides how it is shown and what its links are relative to.
   * Resolves false when the request is no longer current.
   *
   * options: isCurrent, paneId, targetLine, htmlSource, gitGutter, onContent, and
   * readOnly, which renders nothing that writes: no TODO board, no task toggles.
   * `source.versioned` is a version other than the file on disk, which SQLite files
   * and archives cannot be shown as: they are read in place.
   */
  function _renderFileBody(body, info, source, options) {
    var name = source.name || info.absPath;
    var filename = name.split('/').pop();
    var isCurrent = options.isCurrent || function () { return true; };
    if (info.isImage) {
      _renderImage(body, source.rawUrl, filename);
      return Promise.resolve();
    }
    if (info.isVideo) {
      _renderVideo(body, source.rawUrl, filename);
      return Promise.resolve();
    }
    if (info.isPdf) return _renderPdf(body, source.rawUrl, filename);
    if (info.isXlsx) return _renderXlsx(body, source.rawUrl, filename, isCurrent);
    if ((info.isArchive || info.isSqlite) && source.versioned) {
      _renderUnavailable(body, (info.isSqlite ? 'SQLite 数据库' : '压缩包') + '只能按磁盘上的文件预览。', source.rawUrl, filename);
      return Promise.resolve();
    }
    if (info.isArchive) return _renderArchive(body, info);
    if (info.isSqlite) {
      // The sqlite plugin's view; without it, the file is only offered for download.
      if (window.Blocks && window.Blocks.renderSqlite) return window.Blocks.renderSqlite(body, info);
      _renderUnavailable(body, 'SQLite 预览没有启用。', source.rawUrl, filename);
      return Promise.resolve();
    }
    return source.loadContent().then(function (data) {
      if (!isCurrent()) return false;
      if (options.onContent) options.onContent(data.content);
      var html = !!(info.isHtml || info.language === 'html' || /\.html?$/i.test(filename));
      if (!html && !/\.(diff|patch)$/i.test(filename) && _needsTextPaging(data.content)) {
        _renderCode(body, data.content, data.language, options.targetLine);
        return true;
      }
      // Notebooks, patches and TODO.md boards have their own blocks.
      var block = window.Blocks && window.Blocks.rendererFor(name, options.readOnly);
      if (block) return block(body, data.content, info, {
        isCurrent: isCurrent, readOnly: options.readOnly,
        renderText: function () { _renderCode(body, data.content, data.language, options.targetLine, true); return true; },
      });
      if (info.isMarkdown) {
        return _renderMarkdown(body, data.content, name, options.paneId, options.readOnly, isCurrent);
      }
      if (html) {
        _renderHtml(body, data.content, options.targetLine, options.htmlSource);
      } else if (_isCsvPath(name)) {
        _renderCsv(body, data.content, name);
      } else {
        _renderCode(body, data.content, data.language, options.targetLine);
        // Git changes in the gutter, like an editor.
        if (options.gitGutter && !body.querySelector('.fp-code-pages') && window.Blocks && window.Blocks.decorateGitGutter) window.Blocks.decorateGitGutter(body, info.absPath);
      }
      return true;
    });
  }

  /**
   * The same renderers in a page of its own, outside the modal: the Git block shows a
   * file as one version or another has it. Read only. `source` is either
   * { path } for the file on disk, or { info, name, rawUrl, content, language,
   * versioned } for anything else; `machine` is the server's URL prefix.
   */
  function renderInto(container, source) {
    _disposePreview(container);
    var token = {};
    container.__fpRender = token;
    var isCurrent = function () { return container.__fpRender === token; };
    container.classList.add('fp-embedded');
    var body = document.createElement('div');
    body.className = 'fp-embedded-body';
    body.innerHTML = '<div class="fp-loading" role="status">正在读取…</div>';
    container.replaceChildren(body);
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var machine = source.machine != null ? source.machine : _machine();
    var described = source.info ? Promise.resolve(source) : fetch(machine + '/api/files/info?path=' + encodeURIComponent(source.path), {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || '无法读取文件');
        if (res.data.isDirectory) throw new Error('这是一个目录');
        var rawUrl = _workingRawUrl(machine, res.data);
        var filename = res.data.absPath.split('/').pop();
        var isHtml = !!(res.data.isHtml || res.data.language === 'html' || /\.html?$/i.test(filename));
        return {
          info: res.data,
          name: res.data.absPath,
          rawUrl: rawUrl,
          loadContent: function () {
            return isHtml
              ? _loadWorkingRawText(rawUrl, headers, res.data.language || 'html')
              : _loadWorkingContent(machine, res.data.absPath, headers);
          },
        };
      });
    return described.then(function (described) {
      if (!isCurrent()) return false;
      var loadContent = described.loadContent || function () {
        return Promise.resolve({ content: described.content, language: described.language || described.info.language });
      };
      return _renderFileBody(body, described.info, {
        name: described.name, rawUrl: described.rawUrl, loadContent: loadContent, versioned: !!described.versioned,
      }, { isCurrent: isCurrent, readOnly: true });
    }).then(function (rendered) {
      return rendered !== false && isCurrent();
    }).catch(function (err) {
      if (isCurrent()) _showError(body, err.message);
      return false;
    });
  }

  function _renderResolvedPreview(body, info, targetLine, options) {
    options = options || {};
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var requestId = options.requestId == null ? _previewGeneration : options.requestId;
    var expectedFile = options.expectedFile || null;
    var expectedPath = options.expectedPath || null;
    var renderedBody = document.createElement('div');
    var current;

    function isCurrent() {
      return _isPreviewRequestCurrent(requestId, body, expectedFile, expectedPath);
    }

    function commit(next, mode) {
      if (!isCurrent()) return false;
      next.noticeSnapshot = options.noticeSnapshot;
      var scroll = options.reuseCurrent ? _capturePreviewScroll(body) : null;
      _replacePreviewBody(body, renderedBody);
      if (options.reuseCurrent && expectedFile) Object.assign(expectedFile, next);
      else _currentFile = next;
      _previewReady = true;
      _applyMode(mode);
      _setPreviewTitle(next.absPath);
      if (scroll) _restorePreviewScroll(body, scroll);
      _decorate(body, next);
      return true;
    }

    if (info.isDirectory) {
      current = {
        absPath: info.absPath,
        isDirectory: true,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
      return _renderDirectory(renderedBody, info.absPath, {
        navBody: body, requestId: requestId,
        expectedFile: expectedFile, expectedPath: expectedPath,
      })
        .then(function (data) {
          if (!data || !isCurrent()) return false;
          current.absPath = data.absPath;
          if (!commit(current, 'dir')) return false;
          _dirContext = data.parent || null;
          _applyMode('dir');
          _setPreviewTitle(data.absPath);
          return true;
        });
    }

    var rawUrl = _workingRawUrl(_machine(), info);
    var filename = info.absPath.split('/').pop();
    var isHtml = !!(info.isHtml || info.language === 'html' || /\.html?$/i.test(filename));

    current = {
      absPath: info.absPath,
      rawUrl: rawUrl,
      filename: filename,
      isText: info.isText,
      isImage: info.isImage,
      isVideo: info.isVideo,
      isPdf: info.isPdf,
      isHtml: isHtml,
      isXlsx: info.isXlsx,
      isMarkdown: info.isMarkdown,
      isArchive: info.isArchive,
      rawContent: null,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
    var previousHtml = options.reuseCurrent && body.querySelector('.fp-html-wrap');
    var renderPromise = _renderFileBody(renderedBody, info, {
      name: info.absPath,
      rawUrl: rawUrl,
      loadContent: function () {
        return isHtml
          ? _loadWorkingRawText(rawUrl, headers, info.language || 'html')
          : _loadWorkingContent(_machine(), info.absPath, headers);
      },
    }, {
      isCurrent: isCurrent,
      paneId: options.paneId,
      targetLine: targetLine,
      htmlSource: targetLine != null || !!(previousHtml && previousHtml.getAttribute('data-source-visible') === 'true'),
      gitGutter: true,
      onContent: function (content) { current.rawContent = content; },
    });

    return Promise.resolve(renderPromise).then(function (rendered) {
      if (rendered === false || !commit(current, 'file')) {
        _disposePreview(renderedBody);
        return false;
      }
      if (current.isMarkdown && options.markdownFragment) {
        var scrollToLinkedHeading = function () {
          if (!isCurrent()) return;
          if (!_scrollMarkdownHeading(body.querySelector('.fp-md-wrap'), options.markdownFragment)) {
            _notifyFailure('未找到标题：' + options.markdownFragment);
          }
        };
        if (window.requestAnimationFrame) window.requestAnimationFrame(scrollToLinkedHeading);
        else setTimeout(scrollToLinkedHeading, 0);
      }
      return true;
    });
  }

  /**
   * Lets plugins add to a preview that has just rendered, or rendered again
   * after the file changed. `fn({ modal, body, file, paneId, source })` runs for
   * every file and directory; whatever it adds must be idempotent, and goes
   * between the header and the body (`modal.insertBefore(node, body)`) so a
   * refresh, which replaces the body, keeps it.
   */
  function registerDecorator(fn) {
    if (typeof fn !== 'function') return function () {};
    _decorators.push(fn);
    return function () {
      var at = _decorators.indexOf(fn);
      if (at >= 0) _decorators.splice(at, 1);
    };
  }

  function _decorate(body, file, source) {
    if (!_decorators.length || !body) return;
    var modal = body.closest ? body.closest('.fp-modal') : null;
    if (!modal) return;
    var context = { modal: modal, body: body, file: file,
      paneId: source ? source.paneId : _currentPaneId, source: source || _currentSource };
    _decorators.forEach(function (fn) {
      try { fn(context); } catch (err) { if (window.console) console.error('[file-preview] decorator failed', err); }
    });
  }

  // opts: `true` (legacy keep-dir-context) or { lineRef, keepDirContext, markdownFragment }.
  function openFile(filePath, paneId, opts) {
    var keepDir = opts === true || (opts && opts.keepDirContext);
    var targetLine = (opts && opts !== true && opts.lineRef != null) ? opts.lineRef : null;
    var markdownFragment = (opts && opts !== true && opts.markdownFragment) || null;
    // A path may still carry a :line[:col] suffix (e.g. from a mobile tap); split
    // it off so the server gets a clean path and we still know where to jump.
    if (targetLine == null && typeof LinkDetect !== 'undefined') {
      var parsed = LinkDetect.parseLineRef(filePath);
      filePath = parsed.path;
      targetLine = parsed.lineRef;
    }
    var noticeSnapshot = _previewNotices(filePath);
    var body = _createModal(filePath);
    // _createModal saves the previous dock tab before the new file owns these.
    var source = opts && opts !== true && opts.source || _sourceForPane(paneId);
    _currentPaneId = source.paneId || paneId || null;
    _currentSource = { serverId: source.serverId, paneId: _currentPaneId };
    _currentOpenPath = filePath;
    if (!keepDir) _dirContext = null;
    var requestId = ++_previewGeneration;
    _previewReady = false;
    _currentFile = null;
    var restoring = opts && opts.restoring;
    var infoStatus = 0;

    // A failed read is still a saved tab. Keep its error view and identity so
    // later saves cannot silently drop it; only a confirmed missing file is pruned.
    function keepFailedPreview() {
      if (!restoring || !_isPreviewRequestCurrent(requestId, body)) return false;
      _currentFile = {
        absPath: filePath, filename: filePath.split('/').pop(),
        rawUrl: _workingRawUrl(_machine(), { absPath: filePath }),
      };
      var retry = document.createElement('button');
      retry.className = 'fp-error-download';
      retry.type = 'button';
      retry.textContent = '重试加载';
      retry.setAttribute('aria-label', '重试加载文件');
      retry.addEventListener('click', function () { _refreshCurrent(true).finally(_syncAutoRefresh); });
      body.querySelector('.fp-error').appendChild(retry);
      return true;
    }

    var qs = '?path=' + encodeURIComponent(filePath);
    if (_currentPaneId) qs += '&paneId=' + encodeURIComponent(_currentPaneId);

    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};

    return fetch(_machine() + '/api/files/info' + qs, { headers: _authHeaders, cache: 'no-store' })
      .then(function (r) {
        if (!_isPreviewRequestCurrent(requestId, body)) return null;
        infoStatus = r.status;
        if (r.status === 401) {
          if (!restoring) { close(); return null; }
          return { success: false, error: '登录已失效，请重新登录后重试' };
        }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (!_isPreviewRequestCurrent(requestId, body)) return false;
        if (!res.success) {
          if (res.error === 'File not found' || res.error === 'Path not found') {
            _showError(body, '无法打开 ' + filePath + '：文件不存在或不在允许预览的目录', null);
            _notifyFailure('无法打开：' + filePath);
            return infoStatus === 404 ? false : keepFailedPreview();
          }
          var errorAbsPath = (res.data && res.data.absPath) ? res.data.absPath : null;
          _showError(body, res.error, errorAbsPath);
          _notifyFailure('预览打开失败：' + res.error);
          return keepFailedPreview();
        }
        return _renderResolvedPreview(body, res.data, targetLine, {
          requestId: requestId,
          paneId: _currentPaneId,
          markdownFragment: markdownFragment,
          noticeSnapshot: noticeSnapshot,
        });
      })
      .then(function (rendered) {
        if (rendered === true) {
          _saveActiveDockTab();
          _syncAutoRefresh();
          return true;
        }
        return false;
      })
      .catch(function (err) {
        if (_isPreviewRequestCurrent(requestId, body)) {
          _previewReady = false;
          _showError(body, err.message);
          _notifyFailure('预览打开失败：' + err.message);
          return keepFailedPreview();
        }
        return false;
      });
  }

  function _applyMode(mode) {
    if (!_overlay) return;
    _overlay.classList.toggle('fp-mode-dir', mode === 'dir');
    _overlay.classList.toggle('fp-has-back', !!_dirContext);
  }

  // --- Directory browser ---

  function _fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function _fmtMtime(ms) {
    if (!ms) return '';
    var diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' d ago';
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function _iconFor(entry) {
    var paths = entry.type === 'dir' || entry.targetType === 'dir'
      ? '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/>'
      : (entry.type === 'symlink' && entry.targetType === 'broken'
        ? '<path d="m12 3 10 18H2z"/><path d="M12 9v5m0 3h.01"/>'
        : '<path d="M14 3H5v18h14V8z"/><path d="M14 3v5h5m-11 5h8m-8 4h6"/>');
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function _navDir(body, dirPath) {
    // A directory reached from a docked preview is a new modal preview too.
    // Never replace the retained tab's directory or reading state in place.
    if (_placement === 'side') return openFile(dirPath, _currentPaneId, { source: _currentSource });
    _stopAutoRefresh();
    var requestId = ++_previewGeneration;
    var previous = _currentFile;
    _previewReady = false;
    _currentFile = {
      absPath: dirPath,
      isDirectory: true,
      size: previous && previous.isDirectory ? previous.size : null,
      mtimeMs: previous && previous.isDirectory ? previous.mtimeMs : null,
    };
    var fileAtStart = _currentFile;
    _saveActiveDockTab();
    body.innerHTML = '<div class="fp-loading" role="status">正在读取目录…</div>';
    var renderedBody = document.createElement('div');
    _renderDirectory(renderedBody, dirPath, {
      navBody: body, requestId: requestId, expectedFile: fileAtStart, expectedPath: dirPath,
    })
      .then(function (data) {
        if (!data || !_isPreviewRequestCurrent(requestId, body, fileAtStart, dirPath)) return;
        _replacePreviewBody(body, renderedBody);
        _currentFile.absPath = data.absPath;
        _dirContext = data.parent || null;
        _previewReady = true;
        _applyMode('dir');
        _setPreviewTitle(data.absPath);
        _saveActiveDockTab();
        _syncAutoRefresh();
      })
      .catch(function (err) {
        if (!_isPreviewRequestCurrent(requestId, body, fileAtStart, dirPath)) return;
        _showError(body, err.message, dirPath);
      });
  }

  function _formatBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  function _buildArchiveTree(entries) {
    var root = { children: {}, isDir: true };
    entries.forEach(function (entry) {
      var parts = String(entry.name).split('/').filter(Boolean);
      var node = root;
      parts.forEach(function (part, i) {
        node.children[part] = node.children[part] || { children: {} };
        node = node.children[part];
        if (i === parts.length - 1) {
          node.isDir = !!entry.isDir;
          node.size = entry.size || 0;
          node.mtime = entry.mtime || 0;
        } else {
          node.isDir = true;
        }
      });
    });
    return root;
  }

  function _renderArchiveTree(node, container, depth) {
    var names = Object.keys(node.children).sort(function (a, b) {
      var ad = node.children[a].isDir ? 0 : 1;
      var bd = node.children[b].isDir ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    names.forEach(function (name) {
      var child = node.children[name];
      var row = document.createElement('div');
      row.className = 'fp-dir-row fp-arch-row' + (child.isDir ? ' fp-arch-dir' : '');
      row.style.paddingLeft = (8 + depth * 16) + 'px';
      var icon = _iconFor({ type: child.isDir ? 'dir' : 'file' });
      row.innerHTML = '<span class="fp-dir-icon">' + icon + '</span>'
        + '<span class="fp-dir-name">' + _escapeHtml(name) + '</span>'
        + '<span class="fp-dir-size">' + (child.isDir ? '' : _escapeHtml(_formatBytes(child.size))) + '</span>';
      container.appendChild(row);
      if (child.isDir) {
        var sub = document.createElement('div');
        sub.className = 'fp-arch-sub';
        container.appendChild(sub);
        _renderArchiveTree(child, sub, depth + 1);
        row.addEventListener('click', function () {
          sub.hidden = !sub.hidden;
          row.classList.toggle('fp-arch-collapsed', sub.hidden);
        });
      }
    });
  }

  function _renderArchive(body, info) {
    body.innerHTML = '<div class="fp-loading" role="status">正在读取压缩包…</div>';
    var headers = typeof Auth !== 'undefined' ? Auth.headers() : {};
    return fetch(_machine() + '/api/files/archive?path=' + encodeURIComponent(info.absPath), {
      headers: headers, cache: 'no-store',
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || '压缩包解析失败');
        var data = res.data;
        var wrap = document.createElement('div');
        wrap.className = 'fp-arch-wrap';

        var head = document.createElement('div');
        head.className = 'fp-arch-head';
        head.innerHTML = '<span class="fp-arch-type">' + _escapeHtml(data.archiveType) + '</span>'
          + '<span class="fp-arch-count">' + data.totalCount + ' 项</span>'
          + (data.truncated ? '<span class="fp-arch-trunc">已截断</span>' : '');
        wrap.appendChild(head);

        var list = document.createElement('div');
        list.className = 'fp-dir-list fp-arch-list';
        var tree = _buildArchiveTree(data.entries);
        _renderArchiveTree(tree, list, 0);
        wrap.appendChild(list);

        body.innerHTML = '';
        body.appendChild(wrap);
        return true;
      });
  }

  function _renderDirectory(body, dirPath, options) {
    options = options || {};
    var navBody = options.navBody || body;
    body.innerHTML = '<div class="fp-loading" role="status">正在读取目录…</div>';
    var _authHeaders = typeof Auth !== 'undefined' ? Auth.headers() : {};
    var qs = '?path=' + encodeURIComponent(dirPath);
    if (_currentPaneId) qs += '&paneId=' + encodeURIComponent(_currentPaneId);

    return fetch(_machine() + '/api/files/list' + qs, { headers: _authHeaders, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) {
          if (options.requestId == null || _isPreviewRequestCurrent(
            options.requestId, navBody, options.expectedFile, options.expectedPath
          )) close();
          return null;
        }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (!res.success) {
          throw new Error(res.error || '目录加载失败');
        }
        var data = res.data;

        var wrap = document.createElement('div');
        wrap.className = 'fp-dir-wrap';

        // Breadcrumb
        var crumb = document.createElement('div');
        crumb.className = 'fp-dir-crumb';
        var segs = data.absPath.split('/').filter(Boolean);
        var rootLink = document.createElement('a');
        rootLink.className = 'fp-dir-crumb-seg';
        rootLink.textContent = '/';
        rootLink.href = '#';
        rootLink.addEventListener('click', function (e) {
          e.preventDefault();
          _navDir(navBody, '/');
        });
        crumb.appendChild(rootLink);
        var accum = '';
        segs.forEach(function (seg, i) {
          accum += '/' + seg;
          var sep = document.createElement('span');
          sep.className = 'fp-dir-crumb-sep';
          sep.textContent = '/';
          var el;
          if (i === segs.length - 1) {
            el = document.createElement('span');
            el.className = 'fp-dir-crumb-seg fp-dir-crumb-current';
            el.textContent = seg;
          } else {
            el = document.createElement('a');
            el.className = 'fp-dir-crumb-seg';
            el.textContent = seg;
            el.href = '#';
            var target = accum;
            el.addEventListener('click', function (e) {
              e.preventDefault();
              _navDir(navBody, target);
            });
          }
          crumb.appendChild(sep);
          crumb.appendChild(el);
        });
        wrap.appendChild(crumb);

        // List
        var list = document.createElement('div');
        list.className = 'fp-dir-list';

        if (data.parent) {
          var upRow = document.createElement('div');
          upRow.className = 'fp-dir-row fp-dir-parent';
          upRow.tabIndex = 0;
          upRow.setAttribute('role', 'button');
          upRow.setAttribute('aria-label', '返回上级目录');
          upRow.innerHTML = '<span class="fp-dir-icon">↰</span>'
            + '<span class="fp-dir-name">..</span>'
            + '<span class="fp-dir-size"></span>'
            + '<span class="fp-dir-mtime"></span>';
          var parentPath = data.parent;
          upRow.addEventListener('click', function () { _navDir(navBody, parentPath); });
          upRow.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _navDir(navBody, parentPath); }
          });
          list.appendChild(upRow);
        }

        if (data.entries.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'fp-dir-empty';
          empty.textContent = '此目录为空';
          empty.setAttribute('role', 'status');
          list.appendChild(empty);
        }

        data.entries.forEach(function (entry) {
          var row = document.createElement('div');
          row.className = 'fp-dir-row';
          if (entry.isHidden) row.className += ' fp-dir-hidden';
          if (entry.unreadable) row.className += ' fp-dir-unreadable';
          var isDir = entry.type === 'dir' || entry.targetType === 'dir';
          if (isDir) row.className += ' fp-dir-isdir';
          row.tabIndex = entry.unreadable ? -1 : 0;
          row.setAttribute('role', 'button');
          if (entry.unreadable) row.setAttribute('aria-disabled', 'true');

          var fullPath = (data.absPath === '/' ? '' : data.absPath) + '/' + entry.name;

          var icon = document.createElement('span');
          icon.className = 'fp-dir-icon';
          icon.innerHTML = _iconFor(entry);

          var name = document.createElement('span');
          name.className = 'fp-dir-name';
          var nameText = entry.name;
          if (entry.type === 'symlink') {
            var suffix = entry.targetType === 'broken'
              ? ' → (broken)'
              : ' → ' + (entry.targetType === 'dir' ? 'dir' : 'file');
            nameText += suffix;
          }
          name.textContent = nameText;
          name.title = fullPath;

          var size = document.createElement('span');
          size.className = 'fp-dir-size';
          size.textContent = isDir ? '' : _fmtSize(entry.size);

          var mtime = document.createElement('span');
          mtime.className = 'fp-dir-mtime';
          mtime.textContent = _fmtMtime(entry.mtime);

          row.appendChild(icon);
          row.appendChild(name);
          row.appendChild(size);
          row.appendChild(mtime);

          var activate = function () {
            if (entry.unreadable) return;
            if (isDir) {
              _navDir(navBody, fullPath);
            } else {
              // Remember the parent dir so the back button returns here
              _dirContext = data.absPath;
              openFile(fullPath, _currentPaneId, { keepDirContext: true, source: _currentSource });
            }
          };
          row.addEventListener('click', activate);
          row.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
          });

          list.appendChild(row);
        });

        wrap.appendChild(list);

        if (data.truncated) {
          var warn = document.createElement('div');
          warn.className = 'fp-dir-truncated';
          warn.textContent = 'Showing first ' + data.entries.length + ' of ' + data.totalCount + ' entries';
          wrap.appendChild(warn);
        }

        body.innerHTML = '';
        body.appendChild(wrap);
        return data;
      })
      ;
  }

  // Convert a terminal (bufRow, termCol) position to a string offset in
  // the merged logical line. Walks cells to skip wide-char placeholders.
  function _termPosToLogicalStrOffset(logical, bufRow, termCol) {
    for (var i = 0; i < logical.rows.length; i++) {
      var r = logical.rows[i];
      if (r.row !== bufRow) continue;
      // Walk cells on this row up to termCol, counting characters
      var col = 0;
      var chars = 0;
      var lineLen = r.line.length;
      var cellStart = r.cellStart || 0;
      if (termCol < cellStart || (r.cellEnd != null && termCol >= r.cellEnd)) return -1;
      col = cellStart;
      while (col < termCol && col < lineLen) {
        var cell = r.line.getCell(col);
        var glyph = cell && typeof cell.getChars === 'function' ? cell.getChars() : '';
        col += cell ? (cell.getWidth() || 1) : 1;
        chars += glyph.length || 1;
      }
      // Past what this row contributes (its trailing blanks, a box edge left
      // out of the text): that is no position in the row that follows.
      if (i < logical.rows.length - 1 && chars >= r.strLen) return -1;
      return r.strStart + chars;
    }
    return -1;
  }

  function _hitIn(logical, bufRow, col) {
    var strOffset = _termPosToLogicalStrOffset(logical, bufRow, col);
    if (strOffset < 0) return null;
    var links = _findLinks(logical.text);
    for (var i = 0; i < links.length; i++) {
      if (strOffset >= links[i].startCol && strOffset < links[i].endCol) return links[i];
    }
    return null;
  }

  // Check if a position falls on a link. Returns the full match object
  // { kind, text, href, lineRef, ... } (dispatch via activateHit) or null.
  // For mobile: pass term + viewportRow to enable wrapped line detection.
  function hitTest(lineText, col, term, viewportRow) {
    if (term && viewportRow !== undefined) {
      var buffer = term.buffer.active;
      var bufRow = buffer.viewportY + viewportRow;
      var tapped = buffer.getLine(bufRow);
      // The pane or box under the finger; a border is no link.
      var seg = tapped ? _segmentAt(tapped, col) : null;
      if (!seg) return null;
      var sure = _linkLine(buffer, bufRow, null, false, seg);
      var hit = _hitIn(sure.logical, bufRow, col);
      if (sure.pending.length === 0) return hit;
      // A path that joins the rows if it exists. Nothing can be asked from
      // inside a tap, so it goes out unconfirmed (_activateUnverified).
      var hoped = _hitIn(_linkLine(buffer, bufRow, function (path) {
        return sure.pending.indexOf(path) >= 0 ? true : undefined;
      }, true, seg).logical, bufRow, col);
      if (!hoped || (hit && hit.text === hoped.text) || sure.pending.indexOf(hoped.text) < 0) return hit;
      hoped.unverified = true;
      hoped.fallback = hit;
      // What the seam's looks alone say, for a machine that cannot answer.
      var looks = _hitIn(_linkLine(buffer, bufRow, null, true, seg).logical, bufRow, col);
      hoped.strong = !!looks && looks.text === hoped.text;
      return hoped;
    }
    // Fallback: single-line hit test
    var simpleLinks = _findLinks(lineText);
    for (var j = 0; j < simpleLinks.length; j++) {
      if (col >= simpleLinks[j].startCol && col < simpleLinks[j].endCol) {
        return simpleLinks[j];
      }
    }
    return null;
  }

  if (typeof document !== 'undefined') {
    window.addEventListener('terminal-context-changed', function (event) {
      var context = event.detail;
      if (context && context.onTerminal && context.serverId && context.windowId) {
        switchDockContext(context.serverId, context.windowId, context.instanceId);
      }
    });
    document.addEventListener('visibilitychange', _syncAutoRefresh);
    document.addEventListener('visibilitychange', function () {
      _drainDocumentArrivals().catch(function () {});
      var active = _dockTabs.find(function (tab) { return tab.id === _activeDockTabId; });
      if (document.visibilityState === 'visible' && !_dockHidden && _placement === 'side' && active && active.unread) _activateDockTab(active.id);
    });
    document.addEventListener('tmux-theme-change', _refreshMermaidTheme);
    ['tmux-theme-change', 'tmux-transparency-change', 'tmux-glass-change', 'tmux-wallpaper-change', 'anymux-appearance-change'].forEach(function (event) {
      document.addEventListener(event, _refreshPresentationTheme);
    });
    window.addEventListener('resize', function () {
      if (_overlay) _setPreviewTitle((_currentFile && _currentFile.absPath) || _currentOpenPath || '/');
    });
  }

  function applyServerWindow(serverId, instanceId, windowId, winState) {
    var targetContext = _makeDockContextKey(serverId, windowId, instanceId);
    if (!targetContext || targetContext !== _dockContextKey) return;
    if (_restorePromise && _restoreContextKey === targetContext) {
      _restorePromise.then(function () { applyServerWindow(serverId, instanceId, windowId, winState); });
      return;
    }
    var prevRemote = _applyingRemote;
    _applyingRemote = true;
    try {
      var fileItems = winState && Array.isArray(winState.items)
        ? winState.items.filter(function (item) { return item && item.type === 'file'; })
        : [];
      var wantedByPath = {};
      fileItems.forEach(function (item) { wantedByPath[item.path] = item; });

      for (var i = _dockTabs.length - 1; i >= 0; i--) {
        if (!_dockTabs[i].block && !wantedByPath[_dockTabs[i].path]) {
          _removeDockTab(i);
        }
      }

      fileItems.forEach(function (item) {
        var existing = _findFileTab(item.path);
        if (existing) {
          if (item.paneId && existing.paneId !== item.paneId) {
            existing.paneId = item.paneId;
            existing.source = { serverId: serverId, paneId: item.paneId };
            if (existing.id === _activeDockTabId) {
              _currentPaneId = item.paneId;
              _currentSource = existing.source;
            }
            if (!existing.deferred && existing.currentFile) {
              _decorate(existing.modal.querySelector('.fp-body'), existing.currentFile, existing.source);
            }
          }
          if (item.fragment) existing.fragment = item.fragment;
          existing.unread = item.unread === true;
          existing.automatic = item.automatic === true;
        } else if (_canDockRight()) {
          _dockTabs.push(_createDeferredFileTab({
            path: item.path,
            paneId: item.paneId || null,
            source: { serverId: serverId, paneId: item.paneId || null },
            unread: item.unread === true,
            automatic: item.automatic === true,
            fragment: item.fragment || null,
          }, targetContext));
        }
      });

      _savedTabOrder = winState && Array.isArray(winState.order) ? winState.order.slice() : null;
      _applySavedTabOrder();

      if (_dockTabs.length === 0) {
        _destroyDock(true);
        return;
      }

      var activeKey = winState && typeof winState.activeKey === 'string' ? winState.activeKey : null;
      if (activeKey && activeKey.indexOf('file:') === 0) {
        var targetTab = _findFileTab(activeKey.slice(5));
        if (targetTab) {
          if (_dockHidden) {
            _activeDockTabId = targetTab.id;
            _syncRestoreButton();
          } else {
            if (!_dockOverlay.isConnected) _showDock(true);
            _activateDockTab(targetTab.id);
          }
        }
      } else if (activeKey && activeKey.indexOf('block:') === 0) {
        _pendingBlockKey = activeKey.slice(6);
      }

      if (_dockOverlay && _dockOverlay.isConnected) _renderDockTabs();
      else if (!_dockHidden && _canDockRight()) _showDock(true);
      _syncRestoreButton();
      _persistDockState();
    } finally {
      _applyingRemote = prevRemote;
    }
  }

  function reloadLocalDock() {
    if (!_dockContextKey) return;
    var parts = _dockContextKey.split('\u0000');
    var saved = _loadDockState(_dockContextKey);
    applyServerWindow(parts[0], parts[1], parts[2], saved ? {
      order: saved.order || [],
      activeKey: saved.activeBlock ? 'block:' + saved.activeBlock : (saved.activePath ? 'file:' + saved.activePath : null),
      items: saved.tabs.map(function (t) {
        return { type: 'file', path: t.path, paneId: t.paneId, unread: t.unread, automatic: t.automatic, fragment: t.fragment };
      }),
    } : null);
  }

  function forgetServer(serverId) {
    if (!serverId) return;
    Object.keys(_queuedDockDocuments).forEach(function (ctx) {
      if (ctx.split('\u0000')[0] === serverId) delete _queuedDockDocuments[ctx];
    });
    if (_dockContextKey && _dockContextKey.split('\u0000')[0] === serverId) {
      var prevSuspended = _persistenceSuspended;
      _persistenceSuspended = true;
      try {
        switchDockContext(null, null);
      } finally {
        _persistenceSuspended = prevSuspended;
      }
    }
    _clearPrefsForServer(serverId);
    try {
      var storage = window.localStorage;
      for (var i = storage.length - 1; i >= 0; i--) {
        var key = storage.key(i);
        if (!key) continue;
        var prefix = key.indexOf(DOCK_STATE_PREFIX) === 0 ? DOCK_STATE_PREFIX
          : key.indexOf(VIEW_DOCK_STATE_PREFIX) === 0 ? VIEW_DOCK_STATE_PREFIX : null;
        if (!prefix) continue;
        try {
          if (decodeURIComponent(key.slice(prefix.length)).split('\u0000')[0] === serverId) {
            storage.removeItem(key);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  function toggleDock() {
    if (_dockOverlay && _dockOverlay.isConnected && !_dockHidden) {
      _hideDock();
      return false;
    }
    if (_dockTabs.length > 0 && _canDockRight()) {
      _showDock();
      return true;
    }
    return false;
  }

  return {
    registerLinkProvider: registerLinkProvider, openFile: openFile, openDocked: openDocked, queueDocked: queueDocked,
    registerDecorator: registerDecorator,
    renderInto: renderInto, disposeRendered: _disposePreview,
    openFromBuffer: openFromBuffer, close: close, closeModal: closeModal, closeDocked: closeDocked, toggleDock: toggleDock,
    restoreDocked: restoreDocked, switchDockContext: switchDockContext, hitTest: hitTest,
    switchViewContext: switchViewContext,
    reconcileWorkspace: reconcileWorkspace,
    forgetWindow: forgetWindow,
    forgetServer: forgetServer,
    applyServerWindow: applyServerWindow,
    reloadLocalDock: reloadLocalDock,
    activateHit: _activateLink,
    // Lets BlockHost put tool blocks in this dock's tab strip.
    blockDock: {
      available: _canDockRight,
      ready: function () { return _restoreContextKey === _dockContextKey && _restorePromise || Promise.resolve(); },
      sync: _syncBlockTabs,
      activate: _activateBlockTab,
      hide: function () {
        _hideDock();
        if (_dockRestoreButton) _dockRestoreButton.focus();
      },
      onChange: function (listener) { _blockListener = listener; },
      context: function () { return _dockContextKey; },
      onWindowChange: function (listener) { _blockWindowListener = listener; },
      onWindowsGone: function (listener) { _blockWindowsGoneListener = listener; },
      onReorder: function (listener) { _blockOrderListener = listener; },
    },
    // Test seam (no DOM): exercised by test/file-preview-links.test.js.
    _test: {
      getLogicalLine: _getLogicalLine,
      linkLine: _linkLine,
      looseSeam: _looseSeam,
      hyperlinkRows: _hyperlinkRows,
      rowLinkLines: _rowLinkLines,
      segments: _segmentsOf,
      paneAt: _paneAt,
      rowRanges: _rowRanges,
      hitTest: hitTest,
      knownToExist: _knownToExist,
      checkExists: _checkExists,
      strOffsetToTermPos: _logicalStrOffsetToTermPos,
      findLinks: _findLinks,
      resolvePaneForAction: _resolvePaneForAction,
      tabKind: _tabKind,
      refreshCurrent: _refreshCurrent,
      syncAutoRefresh: _syncAutoRefresh,
      hasAutoRefreshTimer: function () { return _autoRefreshTimer != null; },
      autoRefreshMs: AUTO_REFRESH_MS,
      prepareMermaid: _prepareMermaid,
      installMermaidInteractions: _installMermaidInteractions,
      disposeMermaid: _disposeMermaid,
      mermaidThemeConfig: _mermaidThemeConfig,
      refreshMermaidTheme: _refreshMermaidTheme,
      mermaidStandaloneScript: _mermaidStandaloneScript,
      markdownHeadingSlug: _markdownHeadingSlug,
      wikilinkHtml: _wikilinkHtml,
      resolveMarkdownHref: _resolveMarkdownHref,
      scrollMarkdownHeading: _scrollMarkdownHeading,
      extractFrontmatter: _extractFrontmatter,
      installMarkdownTasks: _installMarkdownTasks,
      replaceTaskMarkers: _replaceTaskMarkers,
      prepareMarkdownNavigation: _prepareMarkdownNavigation,
      prepareMarkdownMedia: _prepareMarkdownMedia,
      obsidianMarkdown: _obsidianMarkdown,
      installMarkdownImages: _installMarkdownImages,
      renderImage: _renderImage,
      adaptMermaidPalette: _adaptMermaidPalette,
      canAutoRefresh: _canAutoRefresh,
      buildStandaloneDoc: _buildStandaloneDoc,
      buildArchiveTree: _buildArchiveTree,
      renderArchiveTree: _renderArchiveTree,
      formatBytes: _formatBytes,
      notifyFailure: _notifyFailure,
      shareOrigin: _shareOrigin,
      setLanHost: function (host) { _lanHost = host; },
      loadDockState: _loadDockState,
      persistDockState: _persistDockState,
      dockStateKey: function (serverId, windowId, instanceId) {
        return _dockStateStorageKey(_makeDockContextKey(serverId, windowId, instanceId));
      },
      legacyDockStateKey: LEGACY_DOCK_STATE_KEY,
      dockContextKey: function () { return _dockContextKey; },
      dockCurrent: _dockCurrentPreview,
      buildLinkRange: function (logical, f) {
        var start = _logicalStrOffsetToTermPos(logical.rows, f.startCol);
        var end = _logicalStrOffsetToTermPos(logical.rows, f.endCol - 1);
        return { start: start, end: { y: end.y,
          x: end.y === start.y ? Math.max(end.x, start.x) : end.x } };
      },
    },
  };
})();

if (typeof window !== 'undefined') window.FilePreview = FilePreview;
