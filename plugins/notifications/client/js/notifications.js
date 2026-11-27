/* global escapeHtml, navigate, state, api */

var NotificationPanel = (function () {
  var _notifications = [];
  var _isOpen = false;
  var _loaded = false;
  var DOCUMENT_KEY = 'anymux_document_notifications_v1';
  var _documentOpeners = Object.create(null);
  var _documents = [];
  var _attentionUntil = Object.create(null);
  var _attentionTimer = null;
  function isPreview(n) { return n.type === 'document' || n.type === 'git'; }
  function _isStaleAgentNotice(n) {
    if (!n || isPreview(n)) return false;
    if (n.stale) return true;
    var activeServer = (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
    var workspace = window.AppShell && AppShell.workspace ? AppShell.workspace(n.serverId || activeServer) : null;
    if (workspace && workspace.instanceId) {
      if (n.serverInstance && n.serverInstance !== workspace.instanceId) return true;
      if (!n.serverInstance && n.timestamp) {
        var m = String(workspace.instanceId).match(/^\d+:(\d+)$/);
        if (m && Number(n.timestamp) < Number(m[1]) * 1000 - 2000) return true;
      }
    }
    return false;
  }
  function previewKey(n) {
    var target = n.target;
    return n.serverId && target && target.instanceId && target.windowId
      ? JSON.stringify([n.serverId, target.instanceId, target.windowId, n.type, n.path]) : 'id:' + n.id;
  }
  try {
    var savedDocuments = JSON.parse(window.localStorage.getItem(DOCUMENT_KEY) || '[]');
    var seen = Object.create(null);
    if (Array.isArray(savedDocuments)) _documents = savedDocuments.filter(function (n) {
      if (!n || !isPreview(n) || typeof n.id !== 'string' || typeof n.path !== 'string') return false;
      var key = previewKey(n);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, 50);
    if (Array.isArray(savedDocuments) && savedDocuments.length !== _documents.length) _saveDocuments();
  } catch (_) { /* notification history is best effort */ }
  _notifications = _documents.slice();

  function _saveDocuments() {
    try { window.localStorage.setItem(DOCUMENT_KEY, JSON.stringify(_documents)); } catch (_) {}
  }

  /** Browser-local document arrivals share the existing, persistent notice list. */
  function addDocument(notice, open) {
    if (!notice || typeof notice.id !== 'string' || typeof notice.path !== 'string') return;
    var exact = _documents.find(function (n) { return n.id === notice.id; });
    var entry = Object.assign({}, exact, notice, { type: notice.type === 'git' ? 'git' : 'document' });
    var key = previewKey(entry);
    var previous = _documents.find(function (n) { return previewKey(n) === key; });
    // Replayed commits stay acknowledged; an explicit file open can carry new content.
    if (previous && entry.type === 'git' && (previous.commit === entry.commit || (entry.commit === 'WORKTREE' && previous.reminderSeen))) {
      if (typeof open === 'function') _documentOpeners[previous.id] = open;
      return;
    }
    entry.read = notice.read == null ? !!(exact && exact.read) : !!notice.read;
    entry.timestamp = notice.timestamp || Date.now();
    entry.reminderSeen = false;
    if (!entry.read) delete entry.readAt;
    if (typeof open === 'function') _documentOpeners[entry.id] = open;
    _documents = _documents.filter(function (n) { return n.id !== entry.id && previewKey(n) !== key; });
    if (previous) delete _attentionUntil[previous.id];
    if (!entry.read) _attentionUntil[entry.id] = Date.now() + 2400;
    _documents.unshift(entry);
    _documents = _documents.slice(0, 50);
    _notifications = _notifications.filter(function (n) { return !isPreview(n); }).concat(_documents)
      .sort(function (a, b) { return b.timestamp - a.timestamp; });
    Object.keys(_documentOpeners).forEach(function (id) {
      if (!_documents.some(function (n) { return n.id === id; })) delete _documentOpeners[id];
    });
    _saveDocuments();
    if (!notice.skipServerSync && window.DockSync && typeof window.DockSync.sendNoticeOp === 'function'
      && !(window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote())) {
      window.DockSync.sendNoticeOp(entry.serverId, { type: 'upsert', notice: entry });
    }
    _updateBadge();
    _syncAttention();
    if (_isOpen) _rerenderPanel();
  }

  // --- Server API helpers ---

  function _fetchAll() {
    return api.get('/api/notifications').then(function (res) {
      if (res.success && Array.isArray(res.data)) {
        _notifications = res.data.concat(_documents).sort(function (a, b) { return b.timestamp - a.timestamp; });
        _loaded = true;
        _updateBadge();
        if (_isOpen) _rerenderPanel();
      }
    }).catch(function () { /* ignore */ });
  }

  function _serverMarkRead(id) {
    api.post('/api/notifications/' + id + '/read').catch(function () { /* ignore */ });
  }

  function _serverMarkReadByWindow(session, windowIndex) {
    api.post('/api/notifications/read-by-window', {
      session: session,
      windowIndex: windowIndex,
    }).catch(function () { /* ignore */ });
  }

  function _serverClearAll() {
    api.delete('/api/notifications').catch(function () { /* ignore */ });
  }

  // The macOS shell registers this WKScriptMessageHandler. Browsers do not
  // expose it, so the bridge is inert outside the native app.
  function _postNativeNotification(notification) {
    try {
      var webkit = window.webkit;
      var handlers = webkit && webkit.messageHandlers;
      var handler = handlers && (handlers.anymuxNotification || handlers.tmuxPanelNotification);
      if (!handler || typeof handler.postMessage !== 'function') return;

      handler.postMessage({
        id: String(notification.id || ''),
        session: String(notification.session || ''),
        windowIndex: String(notification.windowIndex ?? ''),
        windowName: String(notification.windowName || ''),
        command: notification.type === 'agent-event'
          ? String(_notificationText(notification) || notification.command || '')
          : String(notification.command || notification.reason || notification.state || ''),
      });
    } catch (_err) {
      // Native notification delivery must never break the in-page panel.
    }
  }

  // NOTE: Do not call _fetchAll() here — this IIFE runs before app.js
  // creates the `api` object. Instead, app.js calls NotificationPanel.refresh()
  // after the StatusSocket connects.

  /**
   * Handle real-time notifications pushed via WebSocket.
   * Called from app.js when a { type: 'notifications', data: [...] } message arrives.
   */
  function handleServerPush(newNotifications) {
    if (!Array.isArray(newNotifications)) return;
    for (var i = 0; i < newNotifications.length; i++) {
      var n = newNotifications[i];
      // Skip if already exists (dedup by id)
      var exists = _notifications.some(function (existing) { return existing.id === n.id; });
      if (!exists) {
        var isCurrentWindow = false;
        // Auto-mark as read if user is currently viewing this window
        if (
          typeof state !== 'undefined' &&
          state.currentTab === 'terminal' &&
          state.currentSession === n.session &&
          String(state.currentWindow) === String(n.windowIndex)
        ) {
          isCurrentWindow = true;
          n.read = true;
          n.readAt = Date.now();
          _serverMarkRead(n.id);
        }
        _notifications.unshift(n);
        if (!n.read) _attentionUntil[n.id] = Date.now() + 2400;
        if (!isCurrentWindow) {
          var activePaneFocused = document.visibilityState !== 'hidden'
            && window.Workbench
            && typeof window.Workbench.context === 'function'
            && n.paneId
            && window.Workbench.context().paneId === n.paneId;
          if (!activePaneFocused) _postNativeNotification(n);
        }
      }
    }
    _updateBadge();
    _syncAttention();
    if (_isOpen) _rerenderPanel();
  }

  function markRead(id) {
    var n = _notifications.find(function (n) { return n.id === id; });
    if (n && !n.read) {
      n.read = true;
      n.readAt = Date.now();
      delete _attentionUntil[id];
      _updateBadge();
      _syncAttention();
      if (isPreview(n)) {
        _saveDocuments();
        if (window.DockSync && typeof window.DockSync.sendNoticeOp === 'function'
          && !(window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote())) {
          window.DockSync.sendNoticeOp(n.serverId, {
            type: 'mark-read',
            id: n.id,
            path: n.path,
            noticeType: n.type,
            commit: n.commit || null,
            instanceId: n.target && n.target.instanceId,
            windowId: n.target && n.target.windowId,
          });
        }
      } else _serverMarkRead(id);
    }
  }

  function clearAll() {
    _notifications = [];
    _documents = [];
    _documentOpeners = Object.create(null);
    _attentionUntil = Object.create(null);
    _saveDocuments();
    if (window.DockSync && typeof window.DockSync.sendNoticeOp === 'function'
      && !(window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote())) {
      var activeServer = (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
      window.DockSync.sendNoticeOp(activeServer, { type: 'clear' });
    }
    _updateBadge();
    _syncAttention();
    _serverClearAll();
    if (_isOpen) _rerenderPanel();
  }

  function unreadCount() {
    return _notifications.filter(function (n) { return !n.read; }).length;
  }

  function needsYou() {
    var activeServer = (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
    var items = _notifications.filter(function (n) {
      if (n.read || _isStaleAgentNotice(n)) return false;
      var isAttention = n.state === 'waiting_attention' || n.state === 'failed'
        || n.event === 'PermissionRequest' || n.event === 'Notification' || n.event === 'StopFailure';
      if (!isAttention) return false;
      if (n.paneId && window.AgentStatus && typeof AgentStatus.getPane === 'function') {
        var live = AgentStatus.getPane(n.serverId || activeServer, n.paneId);
        if (live && (live.status === 'working' || live.status === 'idle')) return false;
      }
      return true;
    });
    if (window.AgentStatus && typeof AgentStatus.getAttentionPanes === 'function') {
      var seenPanes = Object.create(null);
      items.forEach(function (n) { if (n.paneId) seenPanes[n.paneId] = true; });
      var livePanes = AgentStatus.getAttentionPanes(activeServer) || [];
      livePanes.forEach(function (entry) {
        if (!entry || !entry.paneId || seenPanes[entry.paneId]) return;
        seenPanes[entry.paneId] = true;
        items.push({
          id: 'agent-status:' + (entry.serverId || activeServer) + ':' + entry.paneId,
          type: 'agent-event',
          state: entry.status === 'failed' ? 'failed' : 'waiting_attention',
          source: entry.agentType || entry.appKind || 'agent',
          session: entry.session || '',
          sessionId: entry.sessionId || '',
          windowIndex: entry.windowIndex ?? '',
          windowId: entry.windowId || '',
          windowName: entry.windowName || '',
          paneId: entry.paneId,
          serverId: entry.serverId || activeServer,
          reason: entry.lastMessage || entry.prompt || entry.label || '',
          timestamp: entry.updatedAt || Date.now(),
          read: false,
          _ephemeral: true,
        });
      });
    }
    return items;
  }

  function markReadByPane(paneId) {
    if (!paneId) return;
    var target = String(paneId);
    var changed = false;
    _notifications.forEach(function (n) {
      if (isPreview(n)) return;
      if (!n.read && n.paneId === target) {
        n.read = true;
        n.readAt = Date.now();
        delete _attentionUntil[n.id];
        _serverMarkRead(n.id);
        changed = true;
      }
    });
    if (changed) {
      _updateBadge();
      _syncAttention();
      if (_isOpen) _rerenderPanel();
    }
  }

  function _notifyChanged() {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      try { window.dispatchEvent(new CustomEvent('notifications-changed')); } catch (_) {}
    }
  }

  function _updateBadge() {
    var count = unreadCount();
    var badges = document.querySelectorAll('.notification-bell-count');
    badges.forEach(function (el) {
      el.textContent = count;
      el.style.display = count > 0 ? '' : 'none';
    });
    var waiting = needsYou();
    var pill = document.getElementById('ms-needs-you-pill');
    if (pill) {
      pill.hidden = waiting.length === 0;
      pill.textContent = waiting.length > 0 ? ('◆ 待处理 ' + waiting.length) : '';
      pill.title = waiting.length > 0 ? (waiting.length + ' 个 Agent 等待处理') : '';
    }
    _notifyChanged();
  }

  function _relativeTime(ts) {
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
  }

  var _closeHandler = null;
  var _closeTimer = null;
  var _anchor = null;

  function _closePanel() {
    var panel = document.getElementById('notification-panel');
    var overlay = document.getElementById('notification-sheet-overlay');
    if (panel) panel.remove();
    if (overlay) overlay.remove();
    if (_anchor) _anchor.setAttribute('aria-expanded', 'false');
    _anchor = null;
    _isOpen = false;
    clearTimeout(_closeTimer);
    if (_closeHandler) document.removeEventListener('click', _closeHandler);
    _closeHandler = null;
    document.removeEventListener('keydown', _onKeydown);
    window.removeEventListener('resize', _closePanel);
  }

  function _onKeydown(event) {
    if (event.key !== 'Escape') return;
    var anchor = _anchor;
    _closePanel();
    if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  function _notificationText(n) {
    if (isPreview(n)) {
      var name = n.path.split('/').pop();
      return (n.message || '新文档') + ((n.message || '').indexOf(name) >= 0 ? '' : ' · ' + name);
    }
    if (n.type !== 'agent-event') {
      return '命令完成: ' + (n.command || '');
    }
    var labels = {
      waiting_attention: '等待交互',
      agent_stopped: 'Agent 已停止',
      session_ended: '会话已结束',
      process_exited: '进程已退出',
      failed: 'Agent 异常停止'
    };
    var label = labels[n.state] || 'Agent 事件';
    var parts = [label];
    if (n.source) parts.push(n.source);
    if (n.reason) parts.push(n.reason);
    else if (n.command) parts.push(n.command);
    return parts.join(' · ');
  }

  function _rerenderPanel() {
    var panel = document.getElementById('notification-panel');
    if (panel) _renderInto(panel, false);
  }

  function render(event, anchor) {
    // Stop the click from propagating to the document close handler
    if (event && event.stopPropagation) event.stopPropagation();

    var isMobile = window.MobileUI ? window.MobileUI.isMobile() : window.innerWidth < 768;
    if (isMobile) {
      // Mobile: bottom sheet with overlay
      var existing = document.getElementById('notification-panel');
      if (existing) {
        _closePanel();
        return;
      }

      var overlay = document.createElement('div');
      overlay.id = 'notification-sheet-overlay';
      overlay.className = 'notification-sheet-overlay';

      var panel = document.createElement('div');
      panel.id = 'notification-panel';
      panel.className = 'notification-panel notification-mobile-sheet';
      _renderInto(panel, false);

      document.body.appendChild(overlay);
      document.body.appendChild(panel);
      _isOpen = true;

      overlay.addEventListener('click', _closePanel);
    } else {
      // Toggle: if already open, close it
      var existing = document.getElementById('notification-panel');
      if (existing) {
        _closePanel();
        return;
      }

      var panel = document.createElement('div');
      panel.id = 'notification-panel';
      panel.className = 'notification-panel';
      _renderInto(panel, false);
      document.body.appendChild(panel);

      // Position below the bell icon that was clicked
      var bell = anchor || (event && event.currentTarget);
      if (!bell || typeof bell.getBoundingClientRect !== 'function') {
        bell = Array.from(document.querySelectorAll('.workspace-notification,.notification-bell,[data-action="notifications"]'))
          .find(function (button) { return button.getClientRects().length > 0; });
      }
      if (bell) {
        var rect = bell.getBoundingClientRect();
        var size = panel.getBoundingClientRect();
        var width = size.width || Math.min(360, window.innerWidth - 24);
        var height = size.height;
        var top = rect.bottom + 4;
        if (top + height > window.innerHeight - 12) top = (rect.top || 0) - height - 4;
        panel.style.top = Math.max(12, Math.min(top, window.innerHeight - height - 12)) + 'px';
        var left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
        panel.style.left = left + 'px';
        panel.style.right = 'auto';
        _anchor = bell;
        bell.setAttribute('aria-expanded', 'true');
      }

      _isOpen = true;

      // Close on outside click (delay to avoid catching current click)
      _closeHandler = function (e) {
        if (!panel.contains(e.target) && !(_anchor && _anchor.contains(e.target))) _closePanel();
      };
      _closeTimer = setTimeout(function () {
        document.addEventListener('click', _closeHandler);
      }, 10);
      document.addEventListener('keydown', _onKeydown);
      window.addEventListener('resize', _closePanel);
    }
  }

  function _renderInto(container, isMobile) {
    var html = '';
    if (isMobile) {
      html += '<div class="notification-mobile-header">';
      html += '<button class="notification-back-btn" onclick="navigate(\'windows\')">&larr; 通知</button>';
      html += '<button type="button" class="notification-clear-btn">全部清除</button>';
      html += '</div>';
    } else {
      html += '<div class="notification-panel-header">';
      html += '<span class="notification-panel-title"><svg class="notification-title-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg> 通知 <span class="notification-bell-count" style="' +
        (unreadCount() > 0 ? '' : 'display:none') + '">' + unreadCount() + '</span></span>';
      html += '<button type="button" class="notification-clear-btn">全部清除</button>';
      html += '</div>';
    }

    var esc = typeof escapeHtml === 'function' ? escapeHtml : function (v) { return String(v == null ? '' : v); };
    var waitingList = needsYou();

    if (_notifications.length === 0 && waitingList.length === 0) {
      html += '<div class="notification-empty">暂无通知</div>';
    } else {
      if (waitingList.length > 0) {
        html += '<div class="notification-needs-you" aria-label="待处理 Agent">';
        html += '<div class="notification-needs-you-head"><span>◆ 待处理 (' + waitingList.length + ')</span></div>';
        waitingList.forEach(function (n) {
          var label = (n.windowName || n.session || n.source || 'agent') + (n.paneId ? ' · ' + n.paneId : '');
          html += '<div class="notification-needs-you-item" data-notif-id="' + esc(n.id) + '">';
          html += '<div class="notification-needs-you-row">';
          html += '<span class="notification-needs-you-target">' + esc(label) + '</span>';
          html += '<span class="notification-item-time">' + _relativeTime(n.timestamp) + '</span>';
          html += '<button type="button" class="notification-jump-btn" data-jump-id="' + esc(n.id) + '">跳转</button>';
          html += '<button type="button" class="notification-dismiss-btn" data-dismiss-id="' + esc(n.id) + '" aria-label="忽略此提醒">忽略</button>';
          html += '</div>';
          html += '<div class="notification-needs-you-msg">' + esc(_notificationText(n)) + '</div>';
          if (n.paneId) {
            html += '<form class="notification-reply-form" data-reply-id="' + esc(n.id) + '">';
            html += '<input type="text" class="notification-reply-input" placeholder="预填回复（不自动回车）" aria-label="预填回复到 ' + esc(n.paneId) + '">';
            html += '<button type="submit" class="notification-reply-btn">填入</button>';
            html += '</form>';
          }
          html += '</div>';
        });
        html += '</div>';
      }
      if (_notifications.length > 0) {
        html += '<div class="notification-list">';
        _notifications.forEach(function (n) {
          var readClass = n.read ? ' notification-item-read' : '';
          var staleClass = _isStaleAgentNotice(n) ? ' notification-item-stale' : '';
          html += '<div class="notification-item' + readClass + staleClass + '" role="button" tabindex="0" data-notif-id="' + esc(n.id) +
            '" data-session="' + esc(n.session) +
            '" data-window-index="' + n.windowIndex + '">';
          html += '<div class="notification-item-header">';
          var hasWindowIndex = n.windowIndex !== '' && n.windowIndex !== null && n.windowIndex !== undefined;
          var displayName = n.windowName
            ? (hasWindowIndex ? n.windowIndex + ': ' : '') + n.windowName
            : (hasWindowIndex ? 'window ' + n.windowIndex : (n.session || n.source || 'agent'));
          html += '<span class="notification-item-target">' + esc(displayName) + '</span>';
          html += '<span class="notification-item-time">' + _relativeTime(n.timestamp) + '</span>';
          html += '</div>';
          var text = _notificationText(n);
          html += '<div class="notification-item-command">' + esc(text) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
    }

    var findNoticeById = function (id) {
      return waitingList.find(function (n) { return n.id === id; })
        || _notifications.find(function (n) { return n.id === id; });
    };

    container.innerHTML = html;
    container.querySelector('.notification-clear-btn').addEventListener('click', function (event) {
      // Rerender replaces the clicked node. Keep the outside-click listener
      // from mistaking that detached target for a click outside the panel.
      event.stopPropagation();
      clearAll();
    });

    container.querySelectorAll('.notification-jump-btn').forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        event.stopPropagation();
        var id = btn.getAttribute('data-jump-id');
        var notice = findNoticeById(id);
        if (!notice) return;
        _jumpToNotice(notice);
        _closePanel();
      });
    });

    container.querySelectorAll('.notification-dismiss-btn').forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        event.stopPropagation();
        var id = btn.getAttribute('data-dismiss-id');
        var notice = findNoticeById(id);
        if (!notice) return;
        if (notice.paneId && window.AgentStatus && typeof AgentStatus.acknowledge === 'function') {
          var sid = notice.serverId || (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
          AgentStatus.acknowledge(sid, {
            paneId: notice.paneId,
            windowId: notice.windowId || '',
            sessionId: notice.sessionId || '',
            includeAttention: true,
          });
        }
        if (!notice._ephemeral) markRead(notice.id);
        _updateBadge();
        if (_isOpen) _rerenderPanel();
      });
    });

    container.querySelectorAll('.notification-reply-form').forEach(function (form) {
      form.addEventListener('click', function (event) { event.stopPropagation(); });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var id = form.getAttribute('data-reply-id');
        var notice = findNoticeById(id);
        var input = form.querySelector('.notification-reply-input');
        var text = input ? input.value : '';
        if (!notice || !text.trim()) return;
        _prefillReply(notice, text).then(function (ok) {
          if (ok && input) input.value = '';
        });
      });
    });

    container.querySelectorAll('.notification-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-notif-id');
        var sess = el.getAttribute('data-session');
        var winIdx = el.getAttribute('data-window-index');
        var notice = _notifications.find(function (n) { return n.id === id; });
        if (notice && isPreview(notice)) {
          _openPreview(notice);
        } else if (notice && _isStaleAgentNotice(notice)) {
          markRead(id);
          if (window.AppShell && AppShell.toast) AppShell.toast('原窗格所属 tmux 已重启，无法跳转');
        } else if (typeof navigate === 'function' && winIdx !== '' && winIdx !== null) {
          markRead(id);
          navigate('terminal', { currentSession: sess, currentWindow: winIdx, currentPane: null });
        } else {
          markRead(id);
        }
        _closePanel();
      });
      el.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
      });
    });
  }

  function markReadByWindow(session, windowIndex) {
    var changed = false;
    var serverChanged = false;
    _notifications.forEach(function (n) {
      // Visiting a terminal window does not mean its document tabs were read
      // (the dock may be collapsed), and names/indexes are not global IDs.
      if (isPreview(n)) return;
      if (!n.read && n.session === session && String(n.windowIndex) === String(windowIndex)) {
        n.read = true;
        n.readAt = Date.now();
        changed = true;
        if (!isPreview(n)) serverChanged = true;
      }
    });
    if (changed) {
      _updateBadge();
      _syncAttention();
      _saveDocuments();
      if (serverChanged) _serverMarkReadByWindow(session, windowIndex);
    }
  }

  function _jumpToNotice(notice) {
    if (!notice) return;
    markRead(notice.id);
    if (_isStaleAgentNotice(notice)) {
      if (window.AppShell && AppShell.toast) AppShell.toast('原窗格所属 tmux 已重启，无法跳转');
      return;
    }
    if (notice.paneId && window.Workbench && window.Workbench.selectPane) {
      window.Workbench.selectPane(notice.paneId);
    }
    var hasWindowIndex = notice.windowIndex !== '' && notice.windowIndex !== null && notice.windowIndex !== undefined;
    if (typeof navigate === 'function' && hasWindowIndex) {
      navigate('terminal', { currentSession: notice.session, currentWindow: notice.windowIndex, currentPane: notice.paneId || null });
    }
  }

  function _prefillReply(notice, rawText) {
    var safeText = String(rawText || '').replace(/[\r\n]+/g, ' ').trim();
    if (!notice || !notice.paneId || !safeText) return Promise.resolve(false);
    if (_isStaleAgentNotice(notice)) {
      if (window.AppShell && AppShell.toast) AppShell.toast('原窗格已随 tmux 重启失效，已阻止写入');
      return Promise.resolve(false);
    }
    var serverId = notice.serverId || (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
    var workspace = window.AppShell && AppShell.workspace ? AppShell.workspace(serverId) : null;
    var serverInstance = notice.serverInstance || (workspace && workspace.instanceId) || '';
    var payload = { paneId: notice.paneId, text: safeText };
    if (serverInstance) payload.serverInstance = serverInstance;
    var url = window.Api && Api.nodeUrl ? Api.nodeUrl(serverId, '/api/agent-docs/reply') : '/api/agent-docs/reply';
    var headers = Object.assign({ 'Content-Type': 'application/json' }, window.Auth && Auth.headers ? Auth.headers() : {});
    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error('填入失败');
      _jumpToNotice(notice);
      if (window.AppShell && AppShell.toast) AppShell.toast('已填入窗格 ' + notice.paneId + '，请在终端按回车发送');
      return true;
    }).catch(function (err) {
      if (window.AppShell && AppShell.toast) AppShell.toast('填入失败：' + (err && err.message ? err.message : '未知错误'));
      return false;
    });
  }

  function _openPreview(notice) {
    var open = _documentOpeners[notice.id];
    if (!open && window.Blocks) open = notice.type === 'git' ? Blocks.openGitNotice : Blocks.openDocumentNotice;
    if (!open) return Promise.resolve(false);
    // View acknowledges the arrival batch, independently of whether its content
    // loads. Keep unread history for retry; later arrivals still get a reminder.
    if (notice.target) {
      _notifications.forEach(function (n) {
        if (!isPreview(n) || !n.target || n.serverId !== notice.serverId
          || n.target.instanceId !== notice.target.instanceId || n.target.windowId !== notice.target.windowId) return;
        n.reminderSeen = true;
        delete _attentionUntil[n.id];
      });
      _saveDocuments();
      if (window.DockSync && typeof window.DockSync.sendNoticeOp === 'function'
        && !(window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote())) {
        window.DockSync.sendNoticeOp(notice.serverId, {
          type: 'dismiss-window',
          instanceId: notice.target.instanceId,
          windowId: notice.target.windowId,
        });
      }
      _syncAttention();
    }
    if (window.AppShell && AppShell.closeMobileWorkspaceSheet) AppShell.closeMobileWorkspaceSheet({ restoreFocus: false });
    try {
      var result = open(notice);
      if (!result || typeof result.then !== 'function') {
        if (notice.type !== 'git' && result !== false && document.visibilityState !== 'hidden' && _notifications.indexOf(notice) >= 0) markRead(notice.id);
        return Promise.resolve(result);
      }
      return result.then(function (result) {
        if (notice.type !== 'git' && result !== false && document.visibilityState !== 'hidden' && _notifications.indexOf(notice) >= 0) markRead(notice.id);
        return result;
      }, function () { return false; });
    } catch (_) { return Promise.resolve(false); }
  }

  function matchesPreview(n, view) {
    return n.type === view.type && n.path === view.path && (n.type !== 'git' || n.commit === view.commit)
      && n.target && [n.serverId, n.target.instanceId, n.target.windowId].join('\u0000') === view.contextKey;
  }

  /** Capture the arrivals a file read can acknowledge, including across tab changes. */
  function previewSnapshot(view) {
    return _documents.filter(function (n) { return matchesPreview(n, view); });
  }

  /** Called by the preview that is actually visible, never just by navigation. */
  function previewViewed(view) {
    if (!view || document.visibilityState === 'hidden') return;
    _documents.forEach(function (n) {
      if (!n.read && matchesPreview(n, view) && (!view.snapshot || view.snapshot.indexOf(n) >= 0)) markRead(n.id);
    });
  }

  function _dismissPreviewBatch(notice) {
    if (!notice) return;
    var changed = false;
    _notifications.forEach(function (n) {
      if (!isPreview(n)) return;
      if (notice.target && n.target) {
        if (n.serverId !== notice.serverId || n.target.instanceId !== notice.target.instanceId || n.target.windowId !== notice.target.windowId) return;
      } else if (n.id !== notice.id) {
        return;
      }
      if (!n.reminderSeen) changed = true;
      n.reminderSeen = true;
      delete _attentionUntil[n.id];
    });
    if (changed) {
      _saveDocuments();
      if (window.DockSync && typeof window.DockSync.sendNoticeOp === 'function'
        && !(window.DockSync.isApplyingRemote && window.DockSync.isApplyingRemote())) {
        window.DockSync.sendNoticeOp(notice.serverId, notice.target
          ? { type: 'dismiss-window', instanceId: notice.target.instanceId, windowId: notice.target.windowId }
          : { type: 'dismiss-window', id: notice.id });
      }
    }
    _syncAttention();
  }

  function _previewReminder(row, notices) {
    var notice = notices[0];
    var card = row.querySelector('.preview-window-notice');
    if (card && card.__notice === notice && card.dataset.count === String(notices.length)) return;
    if (card) card.remove();
    card = document.createElement('div');
    card.className = 'preview-window-notice';
    card.__notice = notice;
    card.dataset.noticeId = notice.id;
    card.dataset.count = String(notices.length);
    var label = document.createElement('span');
    label.className = 'preview-window-label';
    var labelText = notice.type === 'git'
      ? (notice.commit === 'WORKTREE' ? '工作区变更' : '提交 ' + String(notice.commit || '').slice(0, 8))
      : notice.path.split('/').pop();
    label.textContent = labelText + (notices.length > 1 ? ' · +' + (notices.length - 1) : '');
    label.title = notice.message || notice.path;
    var view = document.createElement('button');
    view.type = 'button'; view.className = 'preview-window-view'; view.textContent = '查看';
    view.setAttribute('aria-label', '查看' + (notice.type === 'git' ? '提交 ' + notice.commit : '文档 ' + notice.path.split('/').pop()));
    function openFromCard(event) {
      event.stopPropagation();
      view.disabled = true;
      _openPreview(notice).finally(function () { view.disabled = false; });
    }
    card.addEventListener('click', openFromCard);
    view.addEventListener('click', openFromCard);
    var dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.className = 'preview-window-dismiss';
    dismiss.textContent = '×';
    dismiss.title = '关闭提醒';
    dismiss.setAttribute('aria-label', '关闭提醒');
    dismiss.addEventListener('click', function (event) {
      event.stopPropagation();
      _dismissPreviewBatch(notice);
    });
    card.append(label, view, dismiss);
    row.appendChild(card);
  }

  // Motion belongs to an arrival, not to the lifetime of an unread notice.
  // A sidebar rebuild must not start an old notice's animation again.
  function _syncAttention() {
    clearTimeout(_attentionTimer);
    _attentionTimer = null;
    var now = Date.now();
    Object.keys(_attentionUntil).forEach(function (id) { if (_attentionUntil[id] <= now) delete _attentionUntil[id]; });
    var context = window.FilePreview && FilePreview.blockDock && FilePreview.blockDock.context();
    var bySession = Object.create(null);
    document.querySelectorAll('.notify-unread').forEach(function (row) { row.classList.remove('notify-unread'); });
    var rowNotices = new Map();
    var pulseRows = new Set();
    var windowRows = Array.from(document.querySelectorAll('.tree-window-row'));
    var sessionRows = Array.from(document.querySelectorAll('.tree-session-row'));
    _notifications.forEach(function (n) {
      if (n.read) return;
      if (isPreview(n) && n.reminderSeen) return;
      if (isPreview(n) && window.Api && n.serverId !== Api.activeServerId()) return;
      if (isPreview(n) && n.target) {
        var target = n.target;
        var workspace = window.AppShell && AppShell.workspace ? AppShell.workspace(n.serverId) : null;
        if (workspace && workspace.instanceId && workspace.instanceId !== target.instanceId) return;
        var current = context === [n.serverId, target.instanceId, target.windowId].join('\u0000') && document.visibilityState !== 'hidden';
        if (current) {
          delete _attentionUntil[n.id];
          return;
        }
        var rows = windowRows.filter(function (row) { return row.dataset.serverId === n.serverId && row.dataset.window === target.windowId; });
        var sessionId = target.sessionId;
        (workspace && workspace.sessions || []).forEach(function (session) {
          if ((session.windows || []).some(function (win) { return win.id === target.windowId; })) sessionId = session.id;
        });
        if (!rows.length) rows = sessionRows.filter(function (row) { return row.dataset.serverId === n.serverId && row.dataset.session === sessionId; });
        rows.forEach(function (row) {
          if (!rowNotices.has(row)) rowNotices.set(row, []);
          rowNotices.get(row).push(n);
          if (_attentionUntil[n.id]) pulseRows.add(row);
        });
        return;
      }
    });
    document.querySelectorAll('.preview-window-notice').forEach(function (card) {
      if (!rowNotices.has(card.parentElement)) card.remove();
    });
    rowNotices.forEach(function (notices, row) { _previewReminder(row, notices); });
    document.querySelectorAll('.notify-breathe').forEach(function (row) { if (!pulseRows.has(row)) row.classList.remove('notify-breathe'); });
    pulseRows.forEach(function (row) { row.classList.add('notify-breathe'); });
    document.querySelectorAll('.has-preview-notice').forEach(function (row) { if (!rowNotices.has(row)) row.classList.remove('has-preview-notice'); });
    rowNotices.forEach(function (_, row) { row.classList.add('has-preview-notice'); });
    var deadlines = Object.keys(_attentionUntil).map(function (id) { return _attentionUntil[id]; });
    if (deadlines.length) _attentionTimer = setTimeout(_syncAttention, Math.max(1, Math.min.apply(null, deadlines) - now));
  }

  document.addEventListener('visibilitychange', _syncAttention);
  window.addEventListener('agent-status-changed', function () {
    if (!window.AgentStatus || typeof AgentStatus.getPane !== 'function') return;
    var activeServer = (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
    var changed = false;
    _notifications.forEach(function (n) {
      if (isPreview(n) || n.read || !n.paneId) return;
      var live = AgentStatus.getPane(n.serverId || activeServer, n.paneId);
      if (live && live.status === 'working') {
        n.read = true;
        n.readAt = Date.now();
        delete _attentionUntil[n.id];
        changed = true;
      }
    });
    if (changed || _notifications.some(function (n) { return !n.read; }) || (AgentStatus.getAttentionPanes && AgentStatus.getAttentionPanes(activeServer).length > 0)) {
      _updateBadge();
      if (_isOpen) _rerenderPanel();
    }
  });

  function syncServerPreviews(serverId, serverNotices) {
    if (!serverId || !Array.isArray(serverNotices)) return;
    var normalized = [];
    var seen = Object.create(null);
    serverNotices.forEach(function (raw) {
      if (!raw || !isPreview(raw) || typeof raw.path !== 'string') return;
      var entry = Object.assign({}, raw, { serverId: serverId });
      if (entry.target && typeof entry.target === 'object') {
        entry.target = Object.assign({}, entry.target, { serverId: serverId });
      }
      var key = previewKey(entry);
      if (seen[key]) return;
      seen[key] = true;
      normalized.push(entry);
    });
    _documents = normalized
      .concat(_documents.filter(function (n) { return (n.serverId || 'local') !== serverId; }))
      .sort(function (a, b) { return b.timestamp - a.timestamp; })
      .slice(0, 50);
    _notifications = _notifications.filter(function (n) { return !isPreview(n); }).concat(_documents)
      .sort(function (a, b) { return b.timestamp - a.timestamp; });
    _saveDocuments();
    _updateBadge();
    _syncAttention();
    if (_isOpen) _rerenderPanel();
  }

  function reloadLocalPreviews() {
    try {
      var savedDocuments = JSON.parse(window.localStorage.getItem(DOCUMENT_KEY) || '[]');
      var seen = Object.create(null);
      if (Array.isArray(savedDocuments)) {
        _documents = savedDocuments.filter(function (n) {
          if (!n || !isPreview(n) || typeof n.id !== 'string' || typeof n.path !== 'string') return false;
          var key = previewKey(n);
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        }).slice(0, 50);
      }
    } catch (_) {}
    _notifications = _notifications.filter(function (n) { return !isPreview(n); }).concat(_documents)
      .sort(function (a, b) { return b.timestamp - a.timestamp; });
    _updateBadge();
    _syncAttention();
    if (_isOpen) _rerenderPanel();
  }

  function forgetServerPreviews(serverId) {
    if (!serverId) return;
    _documents = _documents.filter(function (n) { return (n.serverId || 'local') !== serverId; });
    _notifications = _notifications.filter(function (n) { return !isPreview(n); }).concat(_documents)
      .sort(function (a, b) { return b.timestamp - a.timestamp; });
    _saveDocuments();
    _updateBadge();
    _syncAttention();
    if (_isOpen) _rerenderPanel();
  }

  return {
    addDocument: addDocument,
    addPreview: addDocument,
    previewSnapshot: previewSnapshot,
    previewViewed: previewViewed,
    markRead: markRead,
    markReadByPane: markReadByPane,
    _markReadByWindow: markReadByWindow,
    clearAll: clearAll,
    unreadCount: unreadCount,
    needsYou: needsYou,
    prefillReply: _prefillReply,
    render: render,
    close: _closePanel,
    updateBadge: _updateBadge,
    handleServerPush: handleServerPush,
    syncServerPreviews: syncServerPreviews,
    reloadLocalPreviews: reloadLocalPreviews,
    forgetServerPreviews: forgetServerPreviews,
    refresh: _fetchAll,
    syncAttention: _syncAttention,
  };
})();
