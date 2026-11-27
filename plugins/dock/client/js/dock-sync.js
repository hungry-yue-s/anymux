/* global Api, AppShell, FilePreview, BlockHost, NotificationPanel */

(function (global) {
  'use strict';

  var PREFS_KEY = 'anymux_dock_prefs_v1';
  var MAX_PREFS_ENTRIES = 64;
  var MIGRATED_PREFIX = 'anymux_dock_migrated_v1:';
  var FILE_DOCK_PREFIX = 'tmux_file_preview_dock_v4:';
  var VIEW_DOCK_PREFIX = 'tmux_file_preview_view_dock_v1:';
  var WINDOW_BLOCK_PREFIX = 'anymux_window_blocks_v1:';
  var VIEW_BLOCK_PREFIX = 'anymux_view_blocks_v1:';
  var SERVER_BLOCK_PREFIX = 'anymux_blocks_v1:';
  var DOCUMENT_NOTICES_KEY = 'anymux_document_notifications_v1';

  var clientId = 'dock-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  var unsupportedServers = new Set();
  var serverRevisions = new Map();
  var serverInstances = new Map();
  var inflightSync = new Map();
  var opQueues = new Map();
  var applyingRemote = false;

  function activeServerId() {
    return (global.Api && typeof global.Api.activeServerId === 'function' && global.Api.activeServerId()) || 'local';
  }

  function storage() {
    try { return global.localStorage || null; } catch (_) { return null; }
  }

  function readJson(key, fallback) {
    var ls = storage();
    if (!ls) return fallback;
    try {
      var raw = ls.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode or quota */ }
  }

  function removeKey(key) {
    var ls = storage();
    if (!ls) return;
    try { ls.removeItem(key); } catch (_) {}
  }

  function encodeKey(prefix, value) {
    return prefix + encodeURIComponent(value);
  }

  function decodeKey(prefix, fullKey) {
    if (!fullKey || fullKey.indexOf(prefix) !== 0) return null;
    try { return decodeURIComponent(fullKey.slice(prefix.length)); } catch (_) { return null; }
  }

  function contextParts(contextKey) {
    if (typeof contextKey !== 'string' || !contextKey) return null;
    var parts = contextKey.split('\u0000');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    return { serverId: parts[0], instanceId: parts[1], windowId: parts[2] };
  }

  // --- Viewport preferences (browser-local: hidden, width, block-only fallback order) ---

  function readPrefsMap() {
    var parsed = readJson(PREFS_KEY, null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  function writePrefsMap(map) {
    var entries = Object.entries(map);
    if (entries.length > MAX_PREFS_ENTRIES) {
      entries.sort(function (a, b) {
        return Number((b[1] && b[1].updatedAt) || 0) - Number((a[1] && a[1].updatedAt) || 0);
      });
      var trimmed = {};
      entries.slice(0, MAX_PREFS_ENTRIES).forEach(function (pair) { trimmed[pair[0]] = pair[1]; });
      writeJson(PREFS_KEY, trimmed);
      return;
    }
    writeJson(PREFS_KEY, map);
  }

  function getLocalPrefs(contextKey) {
    if (!contextKey) return null;
    var map = readPrefsMap();
    return map[contextKey] && typeof map[contextKey] === 'object' ? map[contextKey] : null;
  }

  function setLocalPrefs(contextKey, patch) {
    if (!contextKey || !patch || typeof patch !== 'object') return;
    var map = readPrefsMap();
    var current = map[contextKey] && typeof map[contextKey] === 'object' ? map[contextKey] : {};
    var next = Object.assign({}, current, patch, { updatedAt: Date.now() });
    map[contextKey] = next;
    writePrefsMap(map);
  }

  function clearLocalPrefs(contextKey) {
    if (!contextKey) return;
    var map = readPrefsMap();
    if (!(contextKey in map)) return;
    delete map[contextKey];
    writePrefsMap(map);
  }

  // --- Mirroring server state into localStorage for zero-latency first paint ---

  function withRemote(fn) {
    var prev = applyingRemote;
    applyingRemote = true;
    try {
      return fn();
    } finally {
      applyingRemote = prev;
    }
  }

  function mirrorWindowToLocal(serverId, instanceId, windowId, winState) {
    if (!serverId || !instanceId || !windowId) return;
    var contextKey = [serverId, instanceId, windowId].join('\u0000');
    var fileStorageKey = encodeKey(FILE_DOCK_PREFIX, contextKey);
    var blockStorageKey = encodeKey(WINDOW_BLOCK_PREFIX, contextKey);
    var prefs = getLocalPrefs(contextKey);

    if (!winState || !Array.isArray(winState.items) || winState.items.length === 0) {
      removeKey(fileStorageKey);
      removeKey(blockStorageKey);
      clearLocalPrefs(contextKey);
      return;
    }

    var fileItems = winState.items.filter(function (item) { return item && item.type === 'file'; });
    var blockItems = winState.items.filter(function (item) { return item && item.type === 'block'; });
    var activeKey = typeof winState.activeKey === 'string' ? winState.activeKey : null;
    var activeBlock = activeKey && activeKey.indexOf('block:') === 0 ? activeKey.slice(6) : null;

    if (fileItems.length > 0) {
      var existingFile = readJson(fileStorageKey, null);
      var hidden = prefs && typeof prefs.hidden === 'boolean'
        ? prefs.hidden
        : !!(existingFile && existingFile.hidden);
      var width = prefs && Number(prefs.width) > 0
        ? Number(prefs.width)
        : Number(existingFile && existingFile.width) || 0;
      var activePath = activeKey && activeKey.indexOf('file:') === 0
        ? activeKey.slice(5)
        : fileItems[0].path;
      var nextFileState = {
        version: 1,
        tabs: fileItems.map(function (item) {
          var tab = { path: item.path, paneId: item.paneId || null };
          if (item.unread) tab.unread = true;
          if (item.automatic) tab.automatic = true;
          if (item.fragment) tab.fragment = item.fragment;
          return tab;
        }),
        activePath: activePath,
        hidden: hidden,
        width: width,
        order: Array.isArray(winState.order) ? winState.order.slice() : [],
      };
      if (activeBlock) nextFileState.activeBlock = activeBlock;
      writeJson(fileStorageKey, nextFileState);
      setLocalPrefs(contextKey, { hidden: hidden, width: width, order: nextFileState.order, activeBlock: activeBlock });
    } else {
      removeKey(fileStorageKey);
      setLocalPrefs(contextKey, {
        order: Array.isArray(winState.order) ? winState.order.slice() : [],
        activeBlock: activeBlock,
      });
    }

    if (blockItems.length > 0) {
      var existingBlocks = readJson(blockStorageKey, null);
      var prevList = existingBlocks && Array.isArray(existingBlocks.blocks) ? existingBlocks.blocks : [];
      var activeIdx = blockItems.findIndex(function (item) { return item.key === activeKey; });
      var mappedBlocks = blockItems.map(function (item) {
        var prevMatch = prevList.find(function (b) {
          return b && b.kind === item.kind && (item.persistKey === b.kind + ':' + (b.params && b.params.path ? b.params.path : '')
            || JSON.stringify(b.params || {}) === JSON.stringify(item.params || {}));
        });
        var saved = {
          kind: item.kind,
          params: item.params || {},
          mode: item.mode || 'dock',
          geom: (prevMatch && prevMatch.geom) || null,
        };
        if (item.arrivalId) {
          saved.unread = !!item.unread;
          saved.arrivalId = item.arrivalId;
        }
        return saved;
      });
      writeJson(blockStorageKey, { version: 1, blocks: mappedBlocks, active: activeIdx });
    } else {
      removeKey(blockStorageKey);
    }
  }

  function mirrorServerBlocksToLocal(serverId, serverBlocks) {
    if (!serverId) return;
    var key = encodeKey(SERVER_BLOCK_PREFIX, serverId);
    var items = serverBlocks && Array.isArray(serverBlocks.items) ? serverBlocks.items : [];
    if (items.length === 0) {
      removeKey(key);
      return;
    }
    var existing = readJson(key, null);
    var prevList = existing && Array.isArray(existing.blocks) ? existing.blocks : [];
    var activeKey = serverBlocks && typeof serverBlocks.activeKey === 'string' ? serverBlocks.activeKey : null;
    var activeIdx = items.findIndex(function (item) { return item.key === activeKey; });
    writeJson(key, {
      version: 1,
      blocks: items.map(function (item) {
        var prevMatch = prevList.find(function (b) { return b && b.kind === item.kind; });
        return {
          kind: item.kind,
          params: item.params || {},
          mode: item.mode || 'dock',
          geom: (prevMatch && prevMatch.geom) || null,
        };
      }),
      active: activeIdx,
    });
  }

  function pruneMirrorWindows(serverId, instanceId, liveWindowsMap) {
    var ls = storage();
    if (!ls || !serverId || !instanceId) return;
    var keep = liveWindowsMap || {};
    var toRemove = [];
    for (var i = 0; i < ls.length; i++) {
      var key = ls.key(i);
      var ctx = decodeKey(FILE_DOCK_PREFIX, key) || decodeKey(WINDOW_BLOCK_PREFIX, key);
      if (!ctx) continue;
      var parts = contextParts(ctx);
      if (!parts || parts.serverId !== serverId) continue;
      if (parts.instanceId !== instanceId || !Object.prototype.hasOwnProperty.call(keep, parts.windowId)) {
        toRemove.push({ key: key, ctx: ctx });
      }
    }
    toRemove.forEach(function (entry) {
      removeKey(entry.key);
      clearLocalPrefs(entry.ctx);
    });
  }

  function mirrorSnapshotToLocal(serverId, snapshot) {
    if (!snapshot) return;
    if (snapshot.instanceId) {
      pruneMirrorWindows(serverId, snapshot.instanceId, snapshot.windows || {});
      Object.entries(snapshot.windows || {}).forEach(function (pair) {
        mirrorWindowToLocal(serverId, snapshot.instanceId, pair[0], pair[1]);
      });
    }
    mirrorServerBlocksToLocal(serverId, snapshot.serverBlocks);
  }

  // --- Cold migration of pre-existing localStorage state to server ---

  function collectLegacyImportPayload(serverId, snapshot) {
    var ls = storage();
    if (!ls || !snapshot || !snapshot.instanceId) return null;
    var instanceId = snapshot.instanceId;
    var migrationKey = encodeKey(MIGRATED_PREFIX, serverId + '\u0000' + instanceId);
    if (ls.getItem(migrationKey) === '1') return null;

    var windows = {};
    var hasWindowData = false;
    var serverWindows = snapshot.windows || {};

    for (var i = 0; i < ls.length; i++) {
      var key = ls.key(i);
      var fileCtx = decodeKey(FILE_DOCK_PREFIX, key);
      if (fileCtx) {
        var fp = contextParts(fileCtx);
        if (fp && fp.serverId === serverId && fp.instanceId === instanceId
          && (!serverWindows[fp.windowId] || !(serverWindows[fp.windowId].items || []).length)) {
          var parsedFile = readJson(key, null);
          if (parsedFile && Array.isArray(parsedFile.tabs) && parsedFile.tabs.length > 0) {
            var win = windows[fp.windowId] = windows[fp.windowId] || { items: [], order: [], activeKey: null };
            parsedFile.tabs.forEach(function (tab) {
              if (!tab || typeof tab.path !== 'string' || tab.path.charAt(0) !== '/') return;
              win.items.push({
                type: 'file',
                path: tab.path,
                paneId: tab.paneId || null,
                fragment: tab.fragment || null,
                unread: tab.unread === true,
                automatic: tab.automatic === true,
              });
            });
            if (Array.isArray(parsedFile.order)) win.order = parsedFile.order;
            if (parsedFile.activeBlock) win.activeKey = 'block:' + parsedFile.activeBlock;
            else if (parsedFile.activePath) win.activeKey = 'file:' + parsedFile.activePath;
            hasWindowData = true;
          }
        }
      }

      var blockCtx = decodeKey(WINDOW_BLOCK_PREFIX, key);
      if (blockCtx) {
        var bp = contextParts(blockCtx);
        if (bp && bp.serverId === serverId && bp.instanceId === instanceId
          && (!serverWindows[bp.windowId] || !(serverWindows[bp.windowId].items || []).length)) {
          var parsedBlocks = readJson(key, null);
          if (parsedBlocks && Array.isArray(parsedBlocks.blocks) && parsedBlocks.blocks.length > 0) {
            var bwin = windows[bp.windowId] = windows[bp.windowId] || { items: [], order: [], activeKey: null };
            parsedBlocks.blocks.forEach(function (blk, idx) {
              if (!blk || !blk.kind) return;
              var params = blk.params || {};
              var persistKey = blk.kind === 'git' && params.path && params.path !== '.'
                ? 'git:' + params.path
                : (blk.kind === 'git' ? 'git:pane:' + (params.paneId || '') : blk.kind);
              bwin.items.push({
                type: 'block',
                kind: blk.kind,
                persistKey: persistKey,
                params: params,
                mode: blk.mode || 'dock',
                unread: !!blk.unread,
                arrivalId: blk.arrivalId || null,
              });
              if (parsedBlocks.active === idx && !bwin.activeKey) {
                bwin.activeKey = 'block:' + persistKey;
              }
            });
            hasWindowData = true;
          }
        }
      }
    }

    var serverBlocksPayload = null;
    if (!(snapshot.serverBlocks && Array.isArray(snapshot.serverBlocks.items) && snapshot.serverBlocks.items.length > 0)) {
      var savedServerBlocks = readJson(encodeKey(SERVER_BLOCK_PREFIX, serverId), null);
      if (savedServerBlocks && Array.isArray(savedServerBlocks.blocks) && savedServerBlocks.blocks.length > 0) {
        var sbItems = savedServerBlocks.blocks.map(function (blk) {
          return {
            type: 'block',
            kind: blk.kind,
            persistKey: blk.kind,
            params: blk.params || {},
            mode: blk.mode || 'dock',
          };
        });
        var activeBlockItem = sbItems[savedServerBlocks.active];
        serverBlocksPayload = {
          items: sbItems,
          activeKey: activeBlockItem ? 'block:' + activeBlockItem.persistKey : null,
        };
      }
    }

    var noticesPayload = [];
    var savedNotices = readJson(DOCUMENT_NOTICES_KEY, []);
    if (Array.isArray(savedNotices)) {
      savedNotices.forEach(function (n) {
        if (!n || (n.serverId || 'local') !== serverId) return;
        if (n.target && n.target.instanceId && n.target.instanceId !== instanceId) return;
        noticesPayload.push(n);
      });
    }

    if (!hasWindowData && !serverBlocksPayload && noticesPayload.length === 0) {
      try { ls.setItem(migrationKey, '1'); } catch (_) {}
      return null;
    }

    return {
      migrationKey: migrationKey,
      body: {
        instanceId: instanceId,
        windows: windows,
        serverBlocks: serverBlocksPayload,
        notices: noticesPayload,
        clientId: clientId,
      },
    };
  }

  // --- Applying server state to active UI ---

  function currentDockParts() {
    var ctx = global.FilePreview && global.FilePreview.blockDock && global.FilePreview.blockDock.context
      ? global.FilePreview.blockDock.context()
      : null;
    return contextParts(ctx);
  }

  function applySnapshotToUi(serverId, snapshot) {
    if (!snapshot) return;
    withRemote(function () {
      if (global.NotificationPanel && typeof global.NotificationPanel.syncServerPreviews === 'function') {
        global.NotificationPanel.syncServerPreviews(serverId, snapshot.notices || []);
      }
      if (global.BlockHost && typeof global.BlockHost.applyServerScope === 'function') {
        global.BlockHost.applyServerScope(serverId, null, snapshot.serverBlocks || { items: [], activeKey: null });
      }
      var activeDock = currentDockParts();
      if (activeDock && activeDock.serverId === serverId && (!snapshot.instanceId || activeDock.instanceId === snapshot.instanceId)) {
        var winState = (snapshot.windows && snapshot.windows[activeDock.windowId]) || null;
        var contextKey = [serverId, activeDock.instanceId, activeDock.windowId].join('\u0000');
        if (global.FilePreview && typeof global.FilePreview.applyServerWindow === 'function') {
          global.FilePreview.applyServerWindow(serverId, activeDock.instanceId, activeDock.windowId, winState);
        }
        if (global.BlockHost && typeof global.BlockHost.applyServerScope === 'function') {
          var blockItems = winState && Array.isArray(winState.items)
            ? winState.items.filter(function (item) { return item && item.type === 'block'; })
            : [];
          global.BlockHost.applyServerScope(serverId, contextKey, {
            items: blockItems,
            activeKey: winState ? winState.activeKey : null,
          });
        }
      }
    });
  }

  function syncServer(serverId, opts) {
    var sid = serverId || activeServerId();
    var options = opts || {};
    if (!global.Api || typeof global.Api.get !== 'function') return Promise.resolve(null);
    if (unsupportedServers.has(sid) && !options.force) return Promise.resolve(null);
    if (inflightSync.has(sid) && !options.force) return inflightSync.get(sid);

    var url = global.Api.nodeUrl(sid, '/api/dock');
    var promise = global.Api.get(url).then(function (snapshot) {
      unsupportedServers.delete(sid);
      if (!snapshot || typeof snapshot !== 'object') return null;

      var migration = collectLegacyImportPayload(sid, snapshot);
      if (migration) {
        return global.Api.post(global.Api.nodeUrl(sid, '/api/dock/import'), migration.body)
          .then(function (imported) {
            try { storage() && storage().setItem(migration.migrationKey, '1'); } catch (_) {}
            return imported || snapshot;
          }, function () {
            return snapshot;
          });
      }
      return snapshot;
    }).then(function (finalSnapshot) {
      if (!finalSnapshot) return null;
      if (typeof finalSnapshot.revision === 'number') serverRevisions.set(sid, finalSnapshot.revision);
      if (finalSnapshot.instanceId) serverInstances.set(sid, finalSnapshot.instanceId);
      mirrorSnapshotToLocal(sid, finalSnapshot);
      applySnapshotToUi(sid, finalSnapshot);
      return finalSnapshot;
    }).catch(function (err) {
      if (err && (err.status === 404 || err.status === 501)) {
        unsupportedServers.add(sid);
      }
      return null;
    }).finally(function () {
      if (inflightSync.get(sid) === promise) inflightSync.delete(sid);
    });

    inflightSync.set(sid, promise);
    return promise;
  }

  // --- Sending semantic ops to server ---

  function enqueueOp(serverId, fn) {
    var sid = serverId || activeServerId();
    var prev = opQueues.get(sid) || Promise.resolve();
    var next = prev.then(fn, fn);
    opQueues.set(sid, next.catch(function () {}));
    return next;
  }

  function postOp(serverId, path, payload) {
    var sid = serverId || activeServerId();
    if (applyingRemote || unsupportedServers.has(sid)) return Promise.resolve(null);
    if (!global.Api || typeof global.Api.post !== 'function') return Promise.resolve(null);
    return enqueueOp(sid, function () {
      if (unsupportedServers.has(sid)) return null;
      return global.Api.post(global.Api.nodeUrl(sid, path), Object.assign({}, payload, { clientId: clientId }))
        .then(function (res) {
          if (res && typeof res.revision === 'number') serverRevisions.set(sid, res.revision);
          return res;
        })
        .catch(function (err) {
          if (err && (err.status === 404 || err.status === 501)) {
            unsupportedServers.add(sid);
          }
          return null;
        });
    });
  }

  function sendWindowOp(serverId, instanceId, windowId, op, meta) {
    if (!serverId || !instanceId || instanceId === 'local-view' || !/^@\d+$/.test(String(windowId || ''))) {
      return Promise.resolve(null);
    }
    var payload = Object.assign({ instanceId: instanceId, op: op }, meta || {});
    return postOp(serverId, '/api/dock/windows/' + encodeURIComponent(windowId) + '/ops', payload);
  }

  function sendServerBlockOp(serverId, op) {
    if (!serverId) return Promise.resolve(null);
    return postOp(serverId, '/api/dock/server-blocks/ops', { op: op });
  }

  function sendNoticeOp(serverId, op) {
    var sid = serverId || activeServerId();
    return postOp(sid, '/api/dock/notices/ops', { op: op });
  }

  function noteServerRevision(serverId, revision) {
    if (!serverId || typeof revision !== 'number') return;
    var prev = serverRevisions.get(serverId) || 0;
    if (revision > prev) serverRevisions.set(serverId, revision);
  }

  function handleServerEvent(event) {
    if (!event || event.type !== 'dock-changed' || !event.serverId) return;
    var sid = event.serverId;
    if (event.originClientId && event.originClientId === clientId) {
      noteServerRevision(sid, event.revision);
      return;
    }
    var prevRev = serverRevisions.get(sid);
    if (event.scope === 'all' || (typeof prevRev === 'number' && typeof event.revision === 'number' && event.revision > prevRev + 1)) {
      syncServer(sid, { force: true });
      return;
    }
    if (typeof event.revision === 'number') serverRevisions.set(sid, event.revision);
    if (event.instanceId) serverInstances.set(sid, event.instanceId);

    withRemote(function () {
      if (event.scope === 'window' && event.instanceId && event.windowId) {
        mirrorWindowToLocal(sid, event.instanceId, event.windowId, event.window || null);
        var activeDock = currentDockParts();
        if (activeDock && activeDock.serverId === sid && activeDock.instanceId === event.instanceId && activeDock.windowId === event.windowId) {
          var contextKey = [sid, event.instanceId, event.windowId].join('\u0000');
          if (global.FilePreview && typeof global.FilePreview.applyServerWindow === 'function') {
            global.FilePreview.applyServerWindow(sid, event.instanceId, event.windowId, event.window || null);
          }
          if (global.BlockHost && typeof global.BlockHost.applyServerScope === 'function') {
            var blockItems = event.window && Array.isArray(event.window.items)
              ? event.window.items.filter(function (item) { return item && item.type === 'block'; })
              : [];
            global.BlockHost.applyServerScope(sid, contextKey, {
              items: blockItems,
              activeKey: event.window ? event.window.activeKey : null,
            });
          }
        }
      } else if (event.scope === 'server-blocks') {
        mirrorServerBlocksToLocal(sid, event.serverBlocks || { items: [], activeKey: null });
        if (global.BlockHost && typeof global.BlockHost.applyServerScope === 'function') {
          global.BlockHost.applyServerScope(sid, null, event.serverBlocks || { items: [], activeKey: null });
        }
      } else if (event.scope === 'notices') {
        if (global.NotificationPanel && typeof global.NotificationPanel.syncServerPreviews === 'function') {
          global.NotificationPanel.syncServerPreviews(sid, event.notices || []);
        }
      }
    });
  }

  function onWorkspace(serverId, workspace) {
    if (!serverId || !workspace || workspace.provider !== 'tmux' || !workspace.instanceId) return;
    var prevInstance = serverInstances.get(serverId);
    if (prevInstance && prevInstance !== workspace.instanceId) {
      serverInstances.set(serverId, workspace.instanceId);
      syncServer(serverId, { force: true });
    } else if (!prevInstance) {
      serverInstances.set(serverId, workspace.instanceId);
    }
  }

  function forgetServer(serverId) {
    if (!serverId) return;
    unsupportedServers.delete(serverId);
    serverRevisions.delete(serverId);
    serverInstances.delete(serverId);
    inflightSync.delete(serverId);
    opQueues.delete(serverId);

    var ls = storage();
    if (ls) {
      var prefixMatches = [FILE_DOCK_PREFIX, VIEW_DOCK_PREFIX, WINDOW_BLOCK_PREFIX, VIEW_BLOCK_PREFIX, MIGRATED_PREFIX];
      var removeKeys = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k) continue;
        if (k === encodeKey(SERVER_BLOCK_PREFIX, serverId)) {
          removeKeys.push(k);
          continue;
        }
        for (var j = 0; j < prefixMatches.length; j++) {
          var decoded = decodeKey(prefixMatches[j], k);
          if (decoded && decoded.split('\u0000')[0] === serverId) {
            removeKeys.push(k);
            break;
          }
        }
      }
      removeKeys.forEach(removeKey);
    }

    var map = readPrefsMap();
    var mapChanged = false;
    Object.keys(map).forEach(function (ctx) {
      if (ctx.split('\u0000')[0] === serverId) {
        delete map[ctx];
        mapChanged = true;
      }
    });
    if (mapChanged) writePrefsMap(map);

    if (global.NotificationPanel && typeof global.NotificationPanel.forgetServerPreviews === 'function') {
      global.NotificationPanel.forgetServerPreviews(serverId);
    }
  }

  // Cross-tab synchronization within the same browser (also helps legacy Nodes).
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', function (event) {
      if (!event || !event.key) return;
      var k = event.key;
      var activeDock = currentDockParts();
      if (k === DOCUMENT_NOTICES_KEY) {
        withRemote(function () {
          if (global.NotificationPanel && typeof global.NotificationPanel.reloadLocalPreviews === 'function') {
            global.NotificationPanel.reloadLocalPreviews();
          }
        });
        return;
      }
      if (k.indexOf(SERVER_BLOCK_PREFIX) === 0) {
        var sid = decodeKey(SERVER_BLOCK_PREFIX, k);
        if (sid && global.BlockHost && typeof global.BlockHost.reloadLocalScope === 'function') {
          withRemote(function () { global.BlockHost.reloadLocalScope(sid, null); });
        }
        return;
      }
      var ctx = decodeKey(FILE_DOCK_PREFIX, k) || decodeKey(WINDOW_BLOCK_PREFIX, k);
      if (ctx && activeDock && ctx === [activeDock.serverId, activeDock.instanceId, activeDock.windowId].join('\u0000')) {
        withRemote(function () {
          if (k.indexOf(FILE_DOCK_PREFIX) === 0 && global.FilePreview && typeof global.FilePreview.reloadLocalDock === 'function') {
            global.FilePreview.reloadLocalDock();
          }
          if (k.indexOf(WINDOW_BLOCK_PREFIX) === 0 && global.BlockHost && typeof global.BlockHost.reloadLocalScope === 'function') {
            global.BlockHost.reloadLocalScope(activeDock.serverId, ctx);
          }
        });
      }
    });
  }

  global.DockSync = {
    clientId: function () { return clientId; },
    isApplyingRemote: function () { return applyingRemote; },
    isSupported: function (serverId) { return !unsupportedServers.has(serverId || activeServerId()); },
    getLocalPrefs: getLocalPrefs,
    setLocalPrefs: setLocalPrefs,
    clearLocalPrefs: clearLocalPrefs,
    syncServer: syncServer,
    sendWindowOp: sendWindowOp,
    sendServerBlockOp: sendServerBlockOp,
    sendNoticeOp: sendNoticeOp,
    noteServerRevision: noteServerRevision,
    handleServerEvent: handleServerEvent,
    onWorkspace: onWorkspace,
    forgetServer: forgetServer,
    _test: {
      reset: function () {
        unsupportedServers.clear();
        serverRevisions.clear();
        serverInstances.clear();
        inflightSync.clear();
        opQueues.clear();
        applyingRemote = false;
      },
      withRemote: withRemote,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
