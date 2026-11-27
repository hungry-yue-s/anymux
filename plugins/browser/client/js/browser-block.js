/* global Blocks, BlockHost, Api, PanelSlots */

// The browser block (hosted by BlockHost, plugins/ui): a page of this
// machine's localhost or any URL beside the terminal, its command
// (Alt+Shift+B, the palette), and `anymux open <url>` from a pane.

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.Blocks || !window.BlockHost || !window.PanelSlots) return;

  var ui = Blocks.ui;
  var el = ui.el, button = ui.button, iconButton = ui.iconButton, icon = Blocks.icon;
  var toast = ui.toast, errorText = ui.errorText;

  // ===========================================================================
  // Browser block
  // ===========================================================================

  function detectedPorts() {
    var data = window.__anymuxStatus;
    var seen = {};
    var out = [];
    ((data && data.sessions) || []).forEach(function (session) {
      (session.windowDetails || []).forEach(function (win) {
        (win.panes || []).forEach(function (pane) {
          (pane.ports || []).forEach(function (port) {
            if (seen[port]) return;
            seen[port] = true;
            out.push({ port: port, command: pane.command || '', window: win.name || '', session: session.name || '' });
          });
        });
      });
    });
    return out.sort(function (a, b) { return a.port - b.port; });
  }

  function browserBlock(api) {
    var root = el('div', 'browser-block');
    var bar = el('form', 'blk-toolbar browser-bar');
    var back = iconButton('chevronLeft', '后退', function () { go(index - 1); });
    var forward = iconButton('chevronRight', '前进', function () { go(index + 1); });
    var reload = iconButton('refresh', '重新加载', function () { if (frame.src) frame.src = frame.src; });
    var field = el('div', 'browser-url');
    field.innerHTML = icon('browser');
    var input = el('input', 'browser-input');
    input.type = 'text';
    input.placeholder = '输入网址或端口，例如 3000';
    input.setAttribute('aria-label', '网址');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('data-autofocus', '');
    field.appendChild(input);
    var external = iconButton('external', '在新标签页打开', function () { if (frame.src) window.open(frame.src, '_blank', 'noopener'); });
    var grabBtn = iconButton('code', '抓取元素上下文到终端 (Zero-Enter)', function () { grabElementToTerminal(); });
    bar.append(back, forward, reload, field, grabBtn, external);
    var stage = el('div', 'browser-stage');
    var frame = el('iframe', 'browser-frame');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = '网页';
    var start = el('div', 'browser-start');
    stage.append(start, frame);
    root.append(bar, stage);

    var history = [];
    var index = -1;

    function normalize(value) {
      value = value.trim();
      if (!value) return '';
      if (/^\d{2,5}$/.test(value)) return 'http://localhost:' + value;
      if (/^https?:\/\//i.test(value)) return value;
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(value)) return 'http://' + value;
      return 'https://' + value;
    }
    function render() {
      back.disabled = index <= 0;
      forward.disabled = index >= history.length - 1;
      reload.disabled = external.disabled = index < 0;
      var current = history[index];
      start.hidden = !!current;
      frame.hidden = !current;
      if (current) {
        input.value = current;
        var host = current.replace(/^https?:\/\//, '').split('/')[0];
        api.setTitle(host);
        api.setSubtitle('');
      } else {
        api.setTitle('浏览器');
        renderStart();
      }
    }
    function go(next) {
      if (next < 0 || next >= history.length) return;
      index = next;
      frame.src = history[index];
      render();
    }
    function navigate(value) {
      var target = normalize(value);
      if (!target) return;
      history = history.slice(0, index + 1);
      history.push(target);
      index = history.length - 1;
      frame.src = target;
      api.setParams({ url: target });
      render();
    }
    function renderStart() {
      start.replaceChildren();
      var head = ui.emptyState('browser', '在终端旁边预览网页', '输入网址或端口号。适合看本地开发服务、文档和仪表盘。');
      start.appendChild(head);
      var ports = detectedPorts();
      if (ports.length) {
        var box = el('div', 'browser-ports');
        box.appendChild(el('div', 'blk-menu-section', '检测到的本地服务'));
        ports.forEach(function (p) {
          var chip = button('localhost:' + p.port, function () { navigate(String(p.port)); }, { icon: 'plug', className: 'browser-port' });
          chip.appendChild(el('span', 'blk-muted', p.command + (p.window ? ' · ' + p.window : '')));
          box.appendChild(chip);
        });
        start.appendChild(box);
      }
      start.appendChild(el('p', 'browser-hint', '提示：设置了 X-Frame-Options 的网站不能内嵌，用右上角“在新标签页打开”。地址在你这台电脑的浏览器里解析。'));
    }
    bar.addEventListener('submit', function (e) { e.preventDefault(); navigate(input.value); });
    input.addEventListener('focus', function () { input.select(); });

    function grabElementToTerminal() {
      var ctx = ui.currentContext ? ui.currentContext() : {};
      var paneId = ctx.paneId || '';
      var serverId = ctx.serverId || (window.Api && Api.activeServerId && Api.activeServerId()) || 'local';
      var client = ui.client(serverId);
      var payload = { url: history[index] || input.value || '', selector: '', tag: '', role: '', text: '' };
      try {
        var doc = frame.contentDocument;
        if (doc) {
          var sel = doc.getSelection && doc.getSelection().toString();
          var active = doc.activeElement;
          if (active && active !== doc.body) {
            payload.tag = active.tagName;
            payload.role = active.getAttribute('role') || '';
            payload.selector = active.id ? ('#' + active.id) : active.tagName.toLowerCase();
            payload.text = sel || active.innerText || active.textContent || '';
          } else if (sel) {
            payload.text = sel;
          }
        }
      } catch { /* cross-origin iframe: fall back to manual prompt */ }
      if (!payload.selector && !payload.text && typeof window.prompt === 'function') {
        var manual = window.prompt('跨域页面无法直接读取 DOM；输入 CSS 选择器或要点描述：', '');
        if (manual === null) return;
        payload.selector = manual.trim();
      }
      client.post('/api/browser/grab-format', payload).then(function (res) {
        var note = res?.note || '';
        if (!note) return;
        if (paneId) {
          return client.post('/api/agent-docs/prefill', { paneId: paneId, text: note }).then(function () {
            toast('已将元素上下文填入终端（未发送回车）');
          });
        }
        window._copyToClipboard?.(note);
        toast('未检测到目标终端，已复制到剪贴板');
      }).catch(function (err) {
        toast('抓取失败：' + errorText(err));
      });
    }

    if (api.params.url) navigate(api.params.url); else render();
    return {
      el: root,
      toolbar: bar,
      update: function (params) { if (params && params.url) navigate(params.url); },
      onShow: function () { if (index < 0) renderStart(); },
    };
  }

  BlockHost.register('browser', {
    title: '浏览器',
    icon: 'browser',
    key: function () { return 'browser'; },
    create: browserBlock,
  });

  PanelSlots.commands.register({ id: 'browser', order: 60, group: 'block', title: '浏览器', icon: 'browser', keys: 'Alt+Shift+B', code: 'KeyB', run: function () { BlockHost.open('browser', {}); }, keywords: 'browser web url localhost 网页 预览' });
  Blocks.openBrowser = function (url) { return BlockHost.open('browser', url ? { url: url } : {}); };
  PanelSlots.openers.register({ id: 'open-url', run: function (event) { BlockHost.open('browser', { url: event.url }); } });
})();
