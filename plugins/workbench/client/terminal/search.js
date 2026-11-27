// In-pane terminal search bar powered by @xterm/addon-search + Orca safeFind.
// Ported from stablyai/orca (MIT).

export const SEARCH_DECORATIONS = {
  matchBorder: 'rgba(122, 162, 247, 0.45)',
  matchBackground: 'rgba(122, 162, 247, 0.25)',
  matchOverviewRuler: 'rgba(122, 162, 247, 0.6)',
  activeMatchBackground: 'rgba(224, 175, 104, 0.55)',
  activeMatchBorder: 'rgba(224, 175, 104, 0.95)',
  activeMatchColorOverviewRuler: 'rgba(224, 175, 104, 0.95)',
};

function isDecorationPositiveIntegerError(error) {
  return error instanceof Error && /only accepts positive integers/i.test(error.message);
}

/**
 * Swallow xterm's narrow/unreflowed decoration width error (`only accepts positive integers`)
 * while letting navigation proceed and rethrowing unrelated exceptions.
 */
export function safeFind(searchFn, query, options) {
  try {
    return Boolean(searchFn(query, options));
  } catch (error) {
    if (isDecorationPositiveIntegerError(error)) return false;
    throw error;
  }
}

/**
 * Create a self-contained floating search bar attached to a `.seam-pane` container.
 */
export function createPaneSearchController({ entry, globalObj = globalThis, onFocusTerminal }) {
  const doc = globalObj.document;
  if (!doc || !entry?.el) {
    return { open: () => {}, close: () => {}, toggle: () => {}, dispose: () => {} };
  }

  let searchAddon = null;
  let resultSub = null;
  let bar = null;
  let input = null;
  let countEl = null;
  let caseBtn = null;
  let regexBtn = null;
  let caseSensitive = false;
  let regex = false;
  let opened = false;

  const ensureAddon = () => {
    if (searchAddon) return searchAddon;
    const SearchCtor = globalObj.SearchAddon?.SearchAddon;
    if (!SearchCtor || !entry.term || typeof entry.term.loadAddon !== 'function') return null;
    try {
      searchAddon = new SearchCtor();
      entry.term.loadAddon(searchAddon);
      if (typeof searchAddon.onDidChangeResults === 'function') {
        resultSub = searchAddon.onDidChangeResults((ev) => updateCount(ev));
      }
      return searchAddon;
    } catch {
      searchAddon = null;
      return null;
    }
  };

  const updateCount = (ev) => {
    if (!countEl) return;
    if (!input?.value) {
      countEl.textContent = '';
      return;
    }
    if (!ev || !ev.resultCount) {
      countEl.textContent = '0/0';
      return;
    }
    const idx = Number.isInteger(ev.resultIndex) && ev.resultIndex >= 0 ? ev.resultIndex + 1 : 0;
    countEl.textContent = `${idx}/${ev.resultCount}`;
  };

  const runSearch = (direction = 'next', incremental = false) => {
    const addon = ensureAddon();
    const query = input?.value || '';
    if (!addon || !query) {
      addon?.clearDecorations?.();
      updateCount(null);
      return false;
    }
    const opts = {
      caseSensitive,
      regex,
      incremental,
      decorations: SEARCH_DECORATIONS,
    };
    const fn = direction === 'prev'
      ? (q, o) => addon.findPrevious(q, o)
      : (q, o) => addon.findNext(q, o);
    return safeFind(fn, query, opts);
  };

  const buildBar = () => {
    if (bar) return bar;
    bar = doc.createElement('div');
    bar.className = 'wb-pane-search';
    bar.hidden = true;

    input = doc.createElement('input');
    input.type = 'text';
    input.className = 'wb-pane-search-input';
    input.placeholder = '查找终端内容…';
    input.setAttribute('aria-label', '查找终端内容');

    countEl = doc.createElement('span');
    countEl.className = 'wb-pane-search-count';

    const makeToggle = (text, title, getter, setter) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'wb-pane-search-btn';
      btn.textContent = text;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = !getter();
        setter(next);
        btn.classList.toggle('is-active', next);
        runSearch('next', true);
      });
      return btn;
    };

    caseBtn = makeToggle('Aa', '区分大小写', () => caseSensitive, (v) => { caseSensitive = v; });
    regexBtn = makeToggle('.*', '正则表达式', () => regex, (v) => { regex = v; });

    const prevBtn = doc.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'wb-pane-search-btn';
    prevBtn.textContent = '↑';
    prevBtn.title = '上一个 (Shift+Enter)';
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); runSearch('prev', false); });

    const nextBtn = doc.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'wb-pane-search-btn';
    nextBtn.textContent = '↓';
    nextBtn.title = '下一个 (Enter)';
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); runSearch('next', false); });

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wb-pane-search-btn is-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭 (Esc)';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });

    input.addEventListener('input', () => runSearch('next', true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runSearch(e.shiftKey ? 'prev' : 'next', false);
      }
    });
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());

    bar.append(input, countEl, caseBtn, regexBtn, prevBtn, nextBtn, closeBtn);
    entry.el.appendChild(bar);
    return bar;
  };

  const open = () => {
    if (!entry.term) return;
    ensureAddon();
    buildBar();
    bar.hidden = false;
    opened = true;
    const selected = entry.term.getSelection?.();
    if (selected && !selected.includes('\n') && selected.length <= 120 && !input.value) {
      input.value = selected;
    }
    input.focus?.();
    input.select?.();
    if (input.value) runSearch('next', true);
  };

  const close = () => {
    opened = false;
    if (bar) bar.hidden = true;
    searchAddon?.clearDecorations?.();
    if (countEl) countEl.textContent = '';
    onFocusTerminal?.();
  };

  const toggle = () => {
    if (opened && !bar?.hidden) open();
    else open();
  };

  const dispose = () => {
    resultSub?.dispose?.();
    resultSub = null;
    searchAddon?.dispose?.();
    searchAddon = null;
    bar?.remove?.();
    bar = null;
  };

  return { open, close, toggle, dispose, runSearch, isOpen: () => opened && !bar?.hidden };
}
