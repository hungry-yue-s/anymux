/* global Store, Router, AppShell, PanelSlots */

var CommandPalette = (function () {
  var _overlay, _input, _results, _status, _opener, _clear, _modeChip;
  var _all = [], _items = [], _selectedIndex = 0, _mode = 'all', _fileRequest = 0;
  var SEARCH_ICON = '<svg class="ms-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
  var MODES = {
    '>': { mode: 'commands', label: '命令', placeholder: '运行命令…' },
    '@': { mode: 'hosts', label: '主机', placeholder: '切换到主机…' },
    '/': { mode: 'files', label: '文件', placeholder: '按文件名查找…' },
  };
  var MAX_RESULTS = 80;
  var MRU_KEY = 'anymux_palette_mru_v1';
  var _mru = Object.create(null);
  var _lastSearchState = { mode: '', query: '', poolRef: null, matches: null };

  try {
    var savedMru = JSON.parse(window.localStorage.getItem(MRU_KEY) || '{}');
    if (savedMru && typeof savedMru === 'object') _mru = savedMru;
  } catch (_) {}

  function normalized(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFKC')
      .toLocaleLowerCase();
  }

  function recordMru(key) {
    if (!key) return;
    _mru[key] = Date.now();
    try {
      var entries = Object.entries(_mru).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 100);
      _mru = Object.fromEntries(entries);
      window.localStorage.setItem(MRU_KEY, JSON.stringify(_mru));
    } catch (_) {}
  }

  function mruBoostFor(key) {
    var ts = _mru && key ? Number(_mru[key] || 0) : 0;
    if (!ts) return 0;
    var ageHours = Math.max(0, (Date.now() - ts) / 3600000);
    return Math.max(0, 30 - Math.min(30, ageHours * 1.5));
  }

  /** `C:\\Users\\me\\.local\\bin\\claude.exe` → `claude`. */
  function commandLabel(command) {
    var text = String(command || '').replace(/\\\\/g, '\\');
    return text.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  }

  // --- matching ----------------------------------------------------------------

  function separatorFolded(value) {
    return normalized(value).replace(/[_\-]+/g, ' ');
  }

  function isWordBoundary(rawText, idx) {
    if (idx <= 0) return true;
    var prev = rawText.charAt(idx - 1);
    var cur = rawText.charAt(idx);
    if (/[\s/\\·._\-:]/.test(prev)) return true;
    // camelCase boundary: lowercase followed by uppercase in original text
    return prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z';
  }

  /**
   * Scores one query word against `rawText`; null when it does not match.
   * Supports substring, separator equivalence (`foo_bar` == `foo-bar` == `foo bar`),
   * and camelCase/boundary-aware fuzzy subsequence (`fb` -> `fooBar`).
   */
  function matchWord(word, rawText) {
    var source = String(rawText || '');
    var text = normalized(source);
    var qWord = normalized(word);
    if (!qWord) return null;

    var at = text.indexOf(qWord);
    if (at === -1 && /[\s_\-]/.test(qWord)) {
      var folded = separatorFolded(source);
      var foldedWord = separatorFolded(qWord);
      at = folded.indexOf(foldedWord);
      if (at !== -1) text = folded;
    }
    if (at !== -1) {
      var boundary = isWordBoundary(source, at);
      var positions = [];
      for (var i = 0; i < qWord.length; i++) positions.push(at + i);
      return { score: 100 + (at === 0 ? 40 : 0) + (boundary ? 20 : 0) - Math.min(at, 40) * 0.5, positions: positions };
    }
    if (!/^[\x21-\x7e]+$/.test(qWord) || qWord.length < 2) return null;
    var pos = [];
    var from = 0;
    var gaps = 0;
    for (var k = 0; k < qWord.length; k++) {
      var ch = qWord.charAt(k);
      if (ch === '-' || ch === '_') ch = '';
      var found = ch ? text.indexOf(ch, from) : from;
      if (found === -1 && (qWord.charAt(k) === '-' || qWord.charAt(k) === '_')) continue;
      if (found === -1) return null;
      if (k > 0) gaps += found - pos[pos.length - 1] - 1;
      pos.push(found);
      from = found + 1;
    }
    if (!pos.length || gaps > qWord.length * 6) return null;
    var starts = pos.filter(function (p) { return isWordBoundary(source, p); }).length;
    return { score: 40 + starts * 10 - gaps * 1.5, positions: pos };
  }

  /** Every word must match the item's search text; highlights come from both title and meta. */
  function scoreItem(item, words) {
    if (!words.length) return { score: 0, highlight: [], metaHighlight: [] };
    var total = 0;
    var rawTitle = item.searchTitle || item.display || '';
    var rawMeta = item.meta || '';
    var highlight = {};
    var metaHighlight = {};
    for (var i = 0; i < words.length; i++) {
      var inTitle = matchWord(words[i], rawTitle);
      var inMeta = !inTitle ? matchWord(words[i], rawMeta) : null;
      var anywhere = inTitle || inMeta || matchWord(words[i], item.search);
      if (!anywhere) return null;
      total += anywhere.score + (inTitle ? 28 : inMeta ? 12 : 0);
      if (inTitle) inTitle.positions.forEach(function (p) { highlight[p] = true; });
      if (inMeta) inMeta.positions.forEach(function (p) { metaHighlight[p] = true; });
    }
    total += mruBoostFor(item.key);
    return {
      score: total,
      highlight: Object.keys(highlight).map(Number),
      metaHighlight: Object.keys(metaHighlight).map(Number),
    };
  }

  function topKEntries(list, k, cmp) {
    if (list.length <= k) return list.slice().sort(cmp);
    // Min-heap of size k keeps best items in O(N log K) without sorting full large lists.
    var heap = [];
    var swap = function (i, j) { var t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
    for (var idx = 0; idx < list.length; idx++) {
      var entry = list[idx];
      if (heap.length < k) {
        heap.push(entry);
        var c = heap.length - 1;
        while (c > 0) {
          var p = (c - 1) >> 1;
          if (cmp(heap[c], heap[p]) > 0) { swap(c, p); c = p; }
          else break;
        }
      } else if (cmp(entry, heap[0]) < 0) {
        heap[0] = entry;
        var cur = 0;
        for (;;) {
          var l = cur * 2 + 1, r = cur * 2 + 2, worst = cur;
          if (l < heap.length && cmp(heap[l], heap[worst]) > 0) worst = l;
          if (r < heap.length && cmp(heap[r], heap[worst]) > 0) worst = r;
          if (worst === cur) break;
          swap(cur, worst);
          cur = worst;
        }
      }
    }
    return heap.sort(cmp);
  }

  // --- sources -----------------------------------------------------------------

  function destinations() {
    var snapshot = typeof Store !== 'undefined' && Store.getState ? Store.getState() : null;
    var entities = snapshot && snapshot.entities;
    var modern = !!(entities && entities.workspaceByServerId && entities.serversById);
    var current = snapshot && snapshot.route && snapshot.route.params && snapshot.route.params.serverId || 'local';
    var recents = typeof AppShell !== 'undefined' && AppShell.recentTargets ? AppShell.recentTargets() : [];
    if (!Array.isArray(recents)) recents = [];
    var items = [], seen = {};
    function add(item) {
      var key = typeof Router !== 'undefined' ? Router.serialize(item.route) : JSON.stringify(item.route);
      if (seen[key]) return;
      seen[key] = true;
      item.key = key;
      item.search = normalized(item.display + ' ' + item.meta + ' ' + (item.keywords || ''));
      item.recent = recents.findIndex(function (entry) {
        return entry && entry.serverId === item.serverId && entry.windowId === item.windowId;
      });
      items.push(item);
    }
    if (modern) {
      Object.keys(entities.serversById).forEach(function (id) {
        var server = entities.serversById[id], label = server.name || id;
        add({ display: label + ' · 终端', meta: '服务器', icon: 'server', serverId: id, section: 'windows',
          keywords: id + ' 工作区 terminal', route: { name: 'terminal', params: { serverId: id } } });
        var workspace = entities.workspaceByServerId[id];
        (workspace && workspace.sessions || []).forEach(function (session) {
          (session.windows || []).forEach(function (win) {
            var panes = win.panes || [], pane = panes.find(function (item) { return item.active; }) || panes[0];
            var command = pane && pane.command ? commandLabel(pane.command) : '';
            add({ display: label + ' / ' + session.name + ' / ' + (win.name || '窗口 ' + win.index),
              title: win.name || '窗口 ' + win.index, context: label + ' / ' + session.name, section: 'windows',
              meta: panes.length + ' 窗格' + (command ? ' · ' + command : ''), icon: 'terminal',
              serverId: id, windowId: win.id, keywords: '终端 窗口 ' + win.index + ' ' + command,
              route: { name: 'terminal', params: { serverId: id, sessionId: session.id || session.name,
                windowId: win.id, paneId: pane ? pane.id : undefined } } });
          });
        });
      });
    }
    // Before the workspaces have arrived there are no windows to offer, only pages.
    if (typeof Router !== 'undefined') {
      if (!modern) add({ display: '终端', meta: '当前服务器', icon: 'terminal', serverId: current, section: 'pages',
        route: { name: 'terminal', params: { serverId: current } } });
      add({ display: '运行状态', meta: '当前服务器 · 性能', keywords: 'status performance 监控', icon: 'gauge', section: 'pages',
        serverId: current, route: { name: 'server', params: { serverId: current, section: 'performance' } } });
      add({ display: '设置', meta: '外观与偏好', keywords: 'settings 主题', icon: 'settings', section: 'pages', route: { name: 'settings', params: {} } });
    }
    items.forEach(function (item) { if (item.recent >= 0) item.section = 'recent'; });
    return items.sort(function (a, b) {
      var serverOrder = Number(b.serverId === current) - Number(a.serverId === current);
      if (serverOrder) return serverOrder;
      var recentOrder = (a.recent < 0 ? 100 : a.recent) - (b.recent < 0 ? 100 : b.recent);
      return recentOrder || a.display.localeCompare(b.display, 'zh-CN');
    });
  }

  /** Every plugin's commands (PanelSlots.commands, slots.js), in their order. */
  function commandItems() {
    if (typeof PanelSlots === 'undefined') return [];
    return PanelSlots.commands.list().map(function (c) {
      return {
        id: c.id, display: c.title, meta: '', keys: c.keys, keywords: c.keywords, icon: c.icon, run: c.run, kind: '命令',
        key: 'command:' + c.id,
        section: 'commands',
        search: normalized(c.title + ' ' + (c.keywords || '')),
        recent: -1,
      };
    });
  }

  function hostItems() {
    if (typeof Blocks === 'undefined' || !Blocks.hosts) return [];
    return Blocks.hosts().map(function (host) {
      host.key = 'host:' + host.display;
      host.section = 'hosts';
      host.search = normalized(host.display + ' ' + host.meta + ' ' + (host.keywords || ''));
      host.recent = -1;
      return host;
    });
  }

  var SECTION_TITLES = { recent: '最近', windows: '窗口', commands: '命令', pages: '页面', hosts: '主机', files: '文件' };
  var SECTION_ORDER = ['recent', 'windows', 'commands', 'pages'];

  // --- view ------------------------------------------------------------------

  function open(opener, query) {
    if (_overlay) { _input.focus(); return; }
    _opener = opener && typeof opener.focus === 'function' ? opener : document.activeElement;
    _all = destinations().concat(commandItems());
    var mobile = window.MobileUI ? window.MobileUI.isMobile() : window.innerWidth < 768;
    _overlay = document.createElement('div');
    _overlay.className = 'cmd-palette-overlay' + (mobile ? ' cmd-palette-is-mobile' : '');
    _overlay.innerHTML = '<div class="cmd-palette-modal' + (mobile ? ' cmd-palette-mobile' : '') + '" role="dialog" aria-modal="true" aria-label="快速切换">'
      + '<div class="cmd-palette-heading"><strong>搜索工作区</strong><span>找到窗口，继续刚才的工作。</span></div>'
      + '<div class="cmd-palette-input-wrap"><div class="cmd-palette-search-field"><span class="cmd-palette-icon">' + SEARCH_ICON + '</span>'
      + '<span class="cmd-palette-mode" hidden></span>'
      + '<input class="cmd-palette-input" type="search" placeholder="窗口、命令、主机或文件" aria-label="搜索服务器、会话或窗口" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cmd-palette-listbox" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="go">'
      + '<button class="cmd-palette-clear" type="button" aria-label="清空搜索" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>'
      + '<button class="cmd-palette-close" type="button" aria-label="关闭快速切换">' + (mobile ? '取消' : 'Esc') + '</button></div>'
      + '<div class="cmd-palette-status" role="status" aria-live="polite"></div>'
      + '<div class="cmd-palette-results" id="cmd-palette-listbox" role="listbox" aria-label="目的地"></div>'
      + '<div class="cmd-palette-footer">' + (mobile ? '搜索当前已载入的工作区，点选即可前往。输入 &gt; 运行命令，@ 切换主机，/ 查找文件。' : footerHints()) + '</div></div>';
    document.body.appendChild(_overlay);
    _input = _overlay.querySelector('input');
    _results = _overlay.querySelector('.cmd-palette-results');
    _status = _overlay.querySelector('.cmd-palette-status');
    _clear = _overlay.querySelector('.cmd-palette-clear');
    _modeChip = _overlay.querySelector('.cmd-palette-mode');
    _input.addEventListener('input', function () {
      // A leading > @ / switches mode; the prefix becomes the chip, not text.
      var prefix = _mode === 'all' && MODES[_input.value.charAt(0)];
      if (prefix) {
        setMode(prefix.mode);
        _input.value = _input.value.slice(1);
      }
      search(_input.value);
    });
    _clear.onclick = function () { _input.value = ''; setMode('all'); search(''); _input.focus(); };
    _overlay.querySelector('.cmd-palette-close').onclick = function () { close(); };
    _overlay.addEventListener('click', function (event) { if (event.target === _overlay) close(); });
    _overlay.addEventListener('keydown', function (event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        var controls = Array.from(_overlay.querySelectorAll('input,button:not([hidden])'));
        var index = controls.indexOf(document.activeElement);
        controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
      } else if (event.target === _input && event.key === 'Backspace' && _mode !== 'all' && !_input.value) {
        // Backspace on an empty input leaves the mode.
        event.preventDefault();
        setMode('all');
        search('');
      } else if (event.target === _input && ['ArrowDown', 'ArrowUp', 'Enter', 'PageDown', 'PageUp'].indexOf(event.key) !== -1) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Enter') { if (_items[_selectedIndex]) select(_items[_selectedIndex]); }
        else {
          var step = event.key === 'PageDown' ? 8 : event.key === 'PageUp' ? -8 : event.key === 'ArrowDown' ? 1 : -1;
          _selectedIndex = Math.max(0, Math.min(_items.length - 1, _selectedIndex + step));
          highlight();
        }
      }
    });
    document.addEventListener('focusin', trapFocus);
    query = query || '';
    var prefix = MODES[query.charAt(0)];
    setMode(prefix ? prefix.mode : 'all');
    _input.value = prefix ? query.slice(1) : query;
    search(_input.value);
    _input.focus();
  }

  function setMode(mode) {
    _mode = mode;
    var spec = null;
    Object.keys(MODES).forEach(function (key) { if (MODES[key].mode === mode) spec = MODES[key]; });
    _modeChip.hidden = !spec;
    _modeChip.textContent = spec ? spec.label : '';
    _input.placeholder = spec ? spec.placeholder : '窗口、命令、主机或文件';
  }

  function footerHints() {
    var hint = function (keys, text) {
      return '<span class="cmd-palette-hint">' + keys.map(function (k) { return '<kbd>' + k + '</kbd>'; }).join('') + text + '</span>';
    };
    return hint(['↑', '↓'], '选择') + hint(['↵'], '打开') + hint(['&gt;'], '命令') + hint(['@'], '主机') + hint(['/'], '文件') + hint(['esc'], '关闭');
  }

  function trapFocus(event) {
    if (_overlay && !_overlay.contains(event.target)) _input.focus();
  }

  function close(restoreFocus) {
    if (!_overlay) return;
    var opener = _opener;
    document.removeEventListener('focusin', trapFocus);
    _overlay.remove();
    _overlay = _input = _results = _status = _opener = _clear = _modeChip = null;
    _all = _items = [];
    _selectedIndex = 0;
    _mode = 'all';
    _fileRequest++;
    if (restoreFocus !== false && opener && opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
  }

  function search(text) {
    _clear.hidden = !text && _mode === 'all';
    var normText = normalized(text).trim();
    var words = normText.split(/\s+/).filter(Boolean);
    if (_mode === 'files') { searchFiles(words); return; }
    var basePool = _mode === 'commands' ? _all.filter(function (i) { return i.run && i.section === 'commands'; })
      : _mode === 'hosts' ? hostItems()
        : _all;
    // Incremental prefix narrowing: reuse matched items when extending a prior query.
    var canNarrow = _lastSearchState.mode === _mode
      && _lastSearchState.query
      && normText.indexOf(_lastSearchState.query) === 0
      && Array.isArray(_lastSearchState.matches);
    var pool = canNarrow ? _lastSearchState.matches : basePool;
    var scored = [];
    var matchedItems = [];
    pool.forEach(function (item, order) {
      var result = scoreItem(item, words);
      if (result) {
        matchedItems.push(item);
        scored.push({
          item: item,
          score: result.score,
          highlight: result.highlight,
          metaHighlight: result.metaHighlight,
          order: order,
        });
      }
    });
    _lastSearchState = { mode: _mode, query: normText, matches: words.length ? matchedItems : null };
    var topScored;
    if (words.length) {
      topScored = topKEntries(scored, MAX_RESULTS, function (a, b) { return b.score - a.score || a.order - b.order; });
    } else if (_mode === 'all') {
      topScored = topKEntries(scored, MAX_RESULTS, function (a, b) {
        return SECTION_ORDER.indexOf(a.item.section) - SECTION_ORDER.indexOf(b.item.section) || a.order - b.order;
      });
    } else {
      topScored = scored.slice(0, MAX_RESULTS);
    }
    var grouped = !words.length && _mode === 'all';
    render(topScored, {
      grouped: grouped,
      empty: _mode === 'hosts' ? '没有匹配的主机' : _mode === 'commands' ? '没有匹配的命令' : '没有匹配的服务器、会话或窗口',
      hint: _mode === 'hosts' ? '在“状态”页可以添加新的主机。' : _mode === 'commands' ? '试试 git、主题、浏览器或快捷键。'
        : '试试窗口名、会话名或运行的命令。输入 > 运行命令，@ 切换主机，/ 查找文件。',
      label: words.length ? '搜索结果' : _mode === 'commands' ? '命令' : _mode === 'hosts' ? '主机' : '最近访问与工作区',
    });
  }

  function searchFiles(words) {
    if (typeof Blocks === 'undefined' || !Blocks.fileIndex) {
      render([], { empty: '这个页面不支持查找文件', hint: '回到终端工作台再试。', label: '' });
      return;
    }
    var request = ++_fileRequest;
    _status.textContent = '正在建立文件索引…';
    Blocks.fileIndex().then(function (index) {
      if (request !== _fileRequest || !_overlay) return;
      var scored = [];
      index.files.forEach(function (rel, order) {
        var lower = normalized(rel);
        var base = lower.slice(lower.lastIndexOf('/') + 1);
        if (!words.length) {
          if (scored.length < MAX_RESULTS) scored.push({ rel: rel, score: 0, order: order, highlight: [] });
          return;
        }
        var total = 0;
        var highlight = [];
        var baseOffset = lower.length - base.length;
        for (var i = 0; i < words.length; i++) {
          var inBase = matchWord(words[i], base);
          var anywhere = inBase || matchWord(words[i], lower);
          if (!anywhere) return;
          total += anywhere.score + (inBase ? 60 : 0);
          (inBase ? inBase.positions.map(function (p) { return p + baseOffset; }) : anywhere.positions).forEach(function (p) { highlight.push(p); });
        }
        scored.push({ rel: rel, score: total - rel.length * 0.05, order: order, highlight: highlight });
      });
      scored.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
      var items = scored.slice(0, MAX_RESULTS).map(function (entry) {
        var at = entry.rel.lastIndexOf('/');
        var baseStart = at + 1;
        return {
          item: {
            display: entry.rel.slice(baseStart), meta: at === -1 ? '' : entry.rel.slice(0, at), icon: 'file', kind: '文件',
            key: 'file:' + entry.rel, section: 'files',
            run: function () { index.open(entry.rel); },
          },
          highlight: entry.highlight.filter(function (p) { return p >= baseStart; }).map(function (p) { return p - baseStart; }),
        };
      });
      var where = index.root.split('/').filter(Boolean).pop() || index.root;
      var scope = where + ' · ' + index.files.length + (index.truncated ? '+' : '') + ' 个文件' + (index.source === 'git' ? '（遵循 .gitignore）' : '');
      render(items, {
        empty: scope,
        label: (words.length ? '匹配的文件 · ' : '') + scope,
        hint: '没有匹配的文件。' + (index.truncated ? '目录太大，只索引了一部分；在项目目录里的窗格中查找会更准。' : '换个关键词试试，文件名的首字母也能匹配。'),
      });
    }).catch(function (err) {
      if (request !== _fileRequest || !_overlay) return;
      render([], { empty: '无法读取文件列表', hint: err && err.message ? err.message : String(err), label: '' });
    });
  }

  function iconFor(item) {
    if (item.run && typeof Blocks !== 'undefined' && Blocks.icon && Blocks.icon(item.icon)) return Blocks.icon(item.icon);
    if (typeof AppShell !== 'undefined' && AppShell.icon) return AppShell.icon(item.icon) || SEARCH_ICON;
    return SEARCH_ICON;
  }

  function highlighted(text, positions) {
    var node = document.createElement('span');
    node.className = 'cmd-palette-item-name';
    if (!positions || !positions.length) { node.textContent = text; return node; }
    var marks = {};
    positions.forEach(function (p) { marks[p] = true; });
    var run = '', inMark = false;
    function flush() {
      if (!run) return;
      if (inMark) { var m = document.createElement('mark'); m.textContent = run; node.appendChild(m); }
      else node.appendChild(document.createTextNode(run));
      run = '';
    }
    for (var i = 0; i < text.length; i++) {
      var marked = !!marks[i];
      if (marked !== inMark) { flush(); inMark = marked; }
      run += text.charAt(i);
    }
    flush();
    return node;
  }

  function keysNode(combo) {
    if (typeof Blocks !== 'undefined' && Blocks.ui && Blocks.ui.kbd) return Blocks.ui.kbd(combo);
    var span = document.createElement('span');
    span.textContent = combo;
    return span;
  }

  function render(entries, options) {
    _items = entries.map(function (e) { return e.item; });
    _selectedIndex = 0;
    _results.replaceChildren();
    var mobile = _overlay.classList.contains('cmd-palette-is-mobile');
    _status.textContent = _items.length ? options.label + ' · ' + _items.length + ' 项' : options.empty;
    if (!_items.length) {
      var empty = document.createElement('div');
      empty.className = 'cmd-palette-empty';
      empty.textContent = options.hint || options.empty;
      empty.setAttribute('role', 'presentation');
      _results.appendChild(empty);
    }
    var lastSection = null;
    entries.forEach(function (entry, index) {
      var item = entry.item;
      if (options.grouped && item.section !== lastSection) {
        lastSection = item.section;
        var head = document.createElement('div');
        head.className = 'cmd-palette-section';
        head.setAttribute('role', 'presentation');
        head.textContent = SECTION_TITLES[item.section] || '';
        _results.appendChild(head);
      }
      var row = document.createElement('div');
      row.className = 'cmd-palette-item' + (item.run ? ' is-command' : '');
      row.id = 'cmd-palette-option-' + index;
      row.setAttribute('role', 'option'); row.dataset.route = item.key;
      var icon = document.createElement('span'); icon.className = 'cmd-palette-item-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = iconFor(item);
      if (item.state) icon.dataset.state = item.state;
      var body = document.createElement('span'); body.className = 'cmd-palette-item-body';
      var title = mobileTitle(item);
      var name = highlighted(title, title === (item.searchTitle || item.display) ? entry.highlight : null);
      var metaText = item.context && mobile ? item.context + ' · ' + item.meta : item.meta;
      var meta = highlighted(metaText, !mobile || !item.context ? entry.metaHighlight : null);
      meta.className = 'cmd-palette-item-meta';
      body.append(name, meta);
      var kind = document.createElement('span'); kind.className = 'cmd-palette-item-kind';
      if (item.keys && !mobile) kind.appendChild(keysNode(item.keys));
      else kind.textContent = item.kind || (item.windowId ? '窗口' : item.icon === 'server' ? '服务器' : '功能');
      row.append(icon, body, kind);
      row.onclick = function () { select(item); };
      row.onmousemove = function () {
        if (_selectedIndex !== index) { _selectedIndex = index; highlight(false); }
      };
      _results.appendChild(row);
    });
    highlight();
  }

  function mobileTitle(item) {
    return _overlay.classList.contains('cmd-palette-is-mobile') && item.title ? item.title : item.display;
  }

  function highlight(scroll) {
    _results.querySelectorAll('[role="option"]').forEach(function (row, index) {
      var selected = index === _selectedIndex;
      row.classList.toggle('cmd-palette-item-active', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) {
        _input.setAttribute('aria-activedescendant', row.id);
        if (scroll !== false && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      }
    });
    if (!_items.length) _input.removeAttribute('aria-activedescendant');
  }

  function select(item) {
    recordMru(item.key);
    close(false);
    if (item.run) { item.run(); return; }
    // A route selection dismisses a transient file modal, including when the
    // selected destination is the current route and Router.go is a no-op.
    // A docked inspector is separate workspace state and must be retained.
    if (window.FilePreview && window.FilePreview.closeModal) window.FilePreview.closeModal();
    if (item.route && typeof Router !== 'undefined') Router.go(item.route);
  }

  return {
    open: open, close: close, isOpen: function () { return !!_overlay; },
    _test: { matchWord: matchWord, commandLabel: commandLabel, scoreItem: scoreItem, topKEntries: topKEntries, normalized: normalized },
  };
})();
