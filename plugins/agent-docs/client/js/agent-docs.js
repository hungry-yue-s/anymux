/* global FilePreview, Blocks */

// The source bar for paths opened from a pane. Agent documents (lib/agent-docs)
// also show their kind, a Reply button and, on a draft whose front matter
// suggests a place in the project, Confirm / Elsewhere / Keep as draft.
//
// Every button types a line into the agent's pane and stops: nothing presses
// Enter. The agent may be busy or showing a permission prompt, and a submitted
// line could answer that instead; the person reads it in the terminal and
// sends it.

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.FilePreview || typeof FilePreview.registerDecorator !== 'function') return;

  var KIND_HINTS = {
    draft: '草稿，不进 git',
    spec: 'superpowers 设计',
    plan: 'superpowers 计划',
    progress: 'superpowers 执行进度',
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, title, run) {
    var node = el('button', 'ad-btn', label);
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', run);
    return node;
  }

  function toast(message, error) {
    if (window.Blocks && Blocks.ui && Blocks.ui.toast) Blocks.ui.toast(message, { error: !!error });
  }

  function client(serverId) {
    return window.Blocks && Blocks.ui && Blocks.ui.client ? Blocks.ui.client(serverId) : null;
  }

  function name(path) {
    return String(path || '').split('/').filter(Boolean).pop() || path;
  }

  function sourceLabel(context) {
    var shell = window.AppShell;
    var serverId = context.source && context.source.serverId;
    var server = shell && shell.server && shell.server(serverId);
    var workspace = shell && shell.workspace && shell.workspace(serverId);
    var parts = server && server.name ? [server.name] : [];
    var locations = [];
    (workspace && workspace.sessions || []).forEach(function (session) {
      (session.windows || []).forEach(function (win) {
        if ((win.panes || []).some(function (pane) { return pane.id === context.paneId; })) locations.push({ session: session, win: win });
      });
    });
    // A linked tmux window can be in several sessions: do not guess which one.
    if (locations.length === 1 && locations[0].session.name) parts.push(locations[0].session.name);
    if (locations.length && locations[0].win.name) parts.push(locations[0].win.name);
    parts.push('窗格 ' + context.paneId);
    return '来自' + (parts.length > 1 ? ' ' : '') + parts.join(' / ');
  }

  /** Types `text` into the pane; the terminal gets the keyboard back when it shows that pane. */
  function reply(serverId, paneId, text) {
    var api = client(serverId);
    if (!api) return;
    api.send('POST', '/api/agent-docs/reply', { paneId: paneId, text: text }).then(function () {
      toast('已填入窗格 ' + paneId + '，在终端里补充后按回车发送');
      var ctx = Blocks.ui.selectedContext ? Blocks.ui.selectedContext() : null;
      var term = typeof terminalState !== 'undefined' ? terminalState.term : null; // eslint-disable-line no-undef
      if (ctx && ctx.paneId === paneId && term && typeof term.focus === 'function') term.focus();
    }, function (err) {
      toast('没能填入窗格：' + (err && err.message ? err.message : err), true);
    });
  }

  function render(bar, info, context) {
    var doc = info && info.doc;
    var paneId = context.paneId;
    bar.replaceChildren();
    if (!doc && !paneId) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (doc) bar.setAttribute('data-kind', doc.kind);
    else bar.removeAttribute('data-kind');
    var serverId = context.source && context.source.serverId;
    var file = name(context.file.absPath);

    var row = el('div', 'ad-row');
    if (doc) {
      var chip = el('span', 'ad-chip', doc.label);
      chip.title = KIND_HINTS[doc.kind] || doc.owner;
      row.appendChild(chip);
    }
    if (paneId) row.appendChild(el('span', 'ad-source', sourceLabel(context)));
    row.appendChild(el('span', 'ad-spacer'));
    if (doc && paneId) {
      row.appendChild(button('回复…', '在 Agent 的输入框里填入"关于 ' + file + '："，不发送', function () {
        reply(serverId, paneId, '关于 ' + file + '：');
      }));
    }
    bar.appendChild(row);
    if (!doc) return;

    var proposal = doc.proposal;
    if (!proposal || proposal.status !== 'proposed' || !proposal.target) return;
    var box = el('div', 'ad-proposal');
    var text = el('div', 'ad-proposal-text');
    text.appendChild(document.createTextNode('建议放进项目：'));
    text.appendChild(el('code', '', proposal.target));
    if (proposal.reason) text.appendChild(document.createTextNode(' · ' + proposal.reason));
    box.appendChild(text);
    if (proposal.alternatives.length || proposal.also) {
      var more = [];
      if (proposal.alternatives.length) more.push('也可以：' + proposal.alternatives.join('、'));
      if (proposal.also) more.push('同时：' + proposal.also);
      box.appendChild(el('div', 'ad-proposal-more', more.join('；')));
    }
    if (paneId) {
      var actions = el('div', 'ad-actions');
      actions.appendChild(button('确认', '填入确认的答复，不发送', function () {
        reply(serverId, paneId, '确认：把 ' + file + ' 放到 ' + proposal.target);
      }));
      actions.appendChild(button('改位置…', '填入开头，由你写位置', function () {
        reply(serverId, paneId, '把 ' + file + ' 放到 ');
      }));
      actions.appendChild(button('保持草稿', '填入保持草稿的答复，不发送', function () {
        reply(serverId, paneId, '先保持草稿：' + file);
      }));
      box.appendChild(actions);
    }
    bar.appendChild(box);
  }

  FilePreview.registerDecorator(function (context) {
    var modal = context.modal;
    var body = context.body;
    var file = context.file;
    var bar = modal.querySelector(':scope > .ad-bar');
    if (!file || !file.absPath) {
      if (bar) bar.remove();
      return;
    }
    var serverId = context.source && context.source.serverId;
    var api = client(serverId);
    if (!bar) {
      bar = el('div', 'ad-bar');
      bar.hidden = true;
      modal.insertBefore(bar, body);
    }
    var requested = file.absPath + '\u0000' + (file.mtimeMs || 0);
    bar.setAttribute('data-request', requested);
    render(bar, null, context);
    if (file.isDirectory || !api) return;
    api.get('/api/agent-docs/info', { path: file.absPath, paneId: context.paneId }).then(function (info) {
      if (!bar.isConnected && !modal.contains(bar)) return;
      if (bar.getAttribute('data-request') !== requested) return;
      render(bar, info, context);
    }, function () {
      // Source identity does not depend on agent metadata or Node version.
      if (bar.getAttribute('data-request') === requested) render(bar, null, context);
    });
  });
})();
