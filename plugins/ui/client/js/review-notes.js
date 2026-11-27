/* global Api, Auth, AppShell, Blocks */

// Inline Diff & Markdown review note store and bracketed-paste (zero-Enter) terminal injector.
// Ported from stablyai/orca (MIT).

var ReviewNotes = (function () {
  'use strict';

  var _stores = new Map(); // scopeKey -> Map<id, note>
  var _seq = 0;

  function _bucket(scopeKey) {
    var key = String(scopeKey || 'default');
    var map = _stores.get(key);
    if (!map) {
      map = new Map();
      _stores.set(key, map);
    }
    return map;
  }

  function addNote(input) {
    if (!input || !input.comment || !String(input.comment).trim()) return null;
    var bucket = _bucket(input.scopeKey);
    var id = input.id || ('rn-' + (++_seq));
    var start = Math.max(1, Number(input.startLine || 1));
    var end = Math.max(start, Number(input.endLine || start));
    var record = {
      id: id,
      scopeKey: String(input.scopeKey || 'default'),
      path: String(input.path || ''),
      startLine: start,
      endLine: end,
      side: input.side || 'new',
      excerpt: String(input.excerpt || '').slice(0, 600),
      comment: String(input.comment).trim(),
      createdAt: Date.now(),
    };
    bucket.set(id, record);
    return record;
  }

  function updateNote(scopeKey, id, comment) {
    var bucket = _stores.get(String(scopeKey || 'default'));
    if (!bucket || !bucket.has(id)) return null;
    var trimmed = String(comment || '').trim();
    if (!trimmed) {
      bucket.delete(id);
      return null;
    }
    var cur = bucket.get(id);
    cur.comment = trimmed;
    return cur;
  }

  function removeNote(scopeKey, id) {
    var bucket = _stores.get(String(scopeKey || 'default'));
    return bucket ? bucket.delete(id) : false;
  }

  function listNotes(scopeKey) {
    var bucket = _stores.get(String(scopeKey || 'default'));
    return bucket ? Array.from(bucket.values()) : [];
  }

  function clearNotes(scopeKey) {
    var bucket = _stores.get(String(scopeKey || 'default'));
    if (bucket) bucket.clear();
  }

  function formatReviewMarkdown(notes) {
    var list = Array.isArray(notes) ? notes.filter(Boolean) : [];
    if (!list.length) return '';
    return list.map(function (n) {
      var loc = n.path
        ? (n.startLine === n.endLine ? n.path + ':L' + n.startLine : n.path + ':L' + n.startLine + '-L' + n.endLine)
        : ('L' + n.startLine + (n.endLine > n.startLine ? '-L' + n.endLine : ''));
      var lines = ['Review note on `' + loc + '`:'];
      if (n.excerpt) {
        var quoted = String(n.excerpt).split('\n').slice(0, 8).map(function (l) { return '> ' + l; }).join('\n');
        lines.push(quoted);
      }
      lines.push(n.comment);
      return lines.join('\n');
    }).join('\n\n') + '\n';
  }

  function resolveTarget(options) {
    options = options || {};
    var ctx = null;
    if (typeof Blocks !== 'undefined' && Blocks.ui) {
      ctx = (typeof Blocks.ui.selectedContext === 'function' && Blocks.ui.selectedContext())
        || (typeof Blocks.ui.focusedContext === 'function' && Blocks.ui.focusedContext())
        || null;
    }
    var serverId = options.serverId
      || (ctx && ctx.serverId)
      || (typeof Api !== 'undefined' && Api.activeServerId && Api.activeServerId())
      || 'local';
    var paneId = options.paneId || (ctx && ctx.paneId) || '';
    var workspace = (typeof AppShell !== 'undefined' && AppShell.workspace) ? AppShell.workspace(serverId) : null;
    var serverInstance = options.serverInstance || (ctx && ctx.instanceId) || (workspace && workspace.instanceId) || '';
    return { serverId: serverId, paneId: paneId, serverInstance: serverInstance };
  }

  function injectToTerminal(notes, options) {
    var text = typeof notes === 'string' ? notes : formatReviewMarkdown(notes);
    if (!text || !text.trim()) return Promise.reject(new Error('没有可注入的批注内容'));
    var target = resolveTarget(options);
    if (!target.paneId) return Promise.reject(new Error('未定位到目标终端窗格'));
    var url = (typeof Api !== 'undefined' && Api.nodeUrl)
      ? Api.nodeUrl(target.serverId, '/api/agent-docs/prefill')
      : '/api/agent-docs/prefill';
    var headers = Object.assign(
      { 'Content-Type': 'application/json' },
      (typeof Auth !== 'undefined' && Auth.headers) ? Auth.headers() : {}
    );
    var body = { paneId: target.paneId, text: text };
    if (target.serverInstance) body.serverInstance = target.serverInstance;

    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return null; }).then(function (payload) {
          throw new Error((payload && (payload.error?.message || payload.error || payload.message)) || ('注入失败 (' + res.status + ')'));
        });
      }
      if (typeof Blocks !== 'undefined' && Blocks.ui && Blocks.ui.toast) {
        Blocks.ui.toast('批注已填入终端 ' + target.paneId + '（不会自动回车）');
      }
      return true;
    });
  }

  return {
    addNote: addNote,
    updateNote: updateNote,
    removeNote: removeNote,
    listNotes: listNotes,
    clearNotes: clearNotes,
    formatReviewMarkdown: formatReviewMarkdown,
    resolveTarget: resolveTarget,
    injectToTerminal: injectToTerminal,
  };
})();

if (typeof window !== 'undefined') window.ReviewNotes = ReviewNotes;
