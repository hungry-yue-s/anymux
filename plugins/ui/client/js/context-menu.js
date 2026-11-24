(function (global) {
  'use strict';

  var MENU_ID = 'seam-context-menu';
  var activeMenu = null;
  var returnFocusEl = null;
  var activeOnClose = null;
  var cleanupListeners = null;

  function ensureMenuElement() {
    var doc = global.document;
    var el = doc.getElementById(MENU_ID);
    if (el) return el;
    el = doc.createElement('div');
    el.id = MENU_ID;
    el.className = 'seam-context-menu';
    el.setAttribute('role', 'menu');
    el.hidden = true;
    doc.body.appendChild(el);
    return el;
  }

  function close(options) {
    var doc = global.document;
    var restoreFocus = !options || options.restoreFocus !== false;
    var menu = activeMenu || doc.getElementById(MENU_ID);
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }
    if (menu) {
      menu.hidden = true;
      menu.replaceChildren();
    }
    var target = returnFocusEl;
    var onClose = activeOnClose;
    activeMenu = null;
    returnFocusEl = null;
    activeOnClose = null;
    if (typeof onClose === 'function') {
      try { onClose(); } catch (_) {}
    }
    if (restoreFocus && target && target.isConnected && typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  function enabledItems(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
  }

  function positionMenu(menu, opts) {
    var gutter = 8;
    var vw = global.innerWidth || 1280;
    var vh = global.innerHeight || 800;
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.visibility = 'hidden';
    menu.hidden = false;

    var rect = menu.getBoundingClientRect();
    var w = rect.width || 210;
    var h = rect.height || 180;
    var left = Number.isFinite(opts.x) ? opts.x : 16;
    var top = Number.isFinite(opts.y) ? opts.y : 16;

    if (opts.anchor && typeof opts.anchor.getBoundingClientRect === 'function') {
      var anchor = opts.anchor.getBoundingClientRect();
      if (!Number.isFinite(opts.x)) left = anchor.right - w;
      if (!Number.isFinite(opts.y)) {
        top = anchor.bottom + 4;
        if (top + h > vh - gutter) top = anchor.top - h - 4;
      }
    }

    if (left + w > vw - gutter) left = vw - w - gutter;
    if (top + h > vh - gutter) top = vh - h - gutter;
    left = Math.max(gutter, left);
    top = Math.max(gutter, top);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
  }

  function open(options) {
    var opts = options || {};
    var items = Array.isArray(opts.items) ? opts.items.filter(Boolean) : [];
    if (!items.length) return null;

    var doc = global.document;
    var prevFocus = opts.returnFocus !== undefined ? opts.returnFocus : doc.activeElement;
    close({ restoreFocus: false });

    var menu = ensureMenuElement();
    menu.className = 'seam-context-menu' + (opts.className ? ' ' + opts.className : '');
    menu.setAttribute('aria-label', opts.label || '上下文菜单');

    // Trim leading, trailing, or consecutive separators cleanly.
    var normalized = [];
    items.forEach(function (entry) {
      if (entry.separator) {
        if (normalized.length > 0 && !normalized[normalized.length - 1].separator) {
          normalized.push({ separator: true });
        }
      } else {
        normalized.push(entry);
      }
    });
    while (normalized.length && normalized[normalized.length - 1].separator) normalized.pop();
    if (!normalized.length) return null;

    normalized.forEach(function (entry) {
      if (entry.separator) {
        var sep = doc.createElement('div');
        sep.className = 'seam-ctx-sep';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        return;
      }
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.className = 'seam-ctx-item' + (entry.danger ? ' is-danger' : '');
      if (entry.id) btn.dataset.ctxAction = entry.id;
      if (entry.disabled) btn.disabled = true;

      if (entry.icon) {
        var iconSpan = doc.createElement('span');
        iconSpan.className = 'seam-ctx-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        if (entry.icon.indexOf('<') >= 0) iconSpan.innerHTML = entry.icon;
        else iconSpan.textContent = entry.icon;
        btn.appendChild(iconSpan);
      }

      var labelSpan = doc.createElement('span');
      labelSpan.className = 'seam-ctx-label';
      labelSpan.textContent = entry.label || '';
      btn.appendChild(labelSpan);

      if (entry.shortcut) {
        var shortcut = doc.createElement('span');
        shortcut.className = 'seam-ctx-shortcut';
        shortcut.textContent = entry.shortcut;
        btn.appendChild(shortcut);
      }

      btn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (btn.disabled) return;
        close({ restoreFocus: false });
        if (typeof entry.action === 'function') {
          Promise.resolve(entry.action(entry)).catch(function () {});
        }
      });
      menu.appendChild(btn);
    });

    activeMenu = menu;
    returnFocusEl = prevFocus;
    activeOnClose = opts.onClose || null;
    positionMenu(menu, opts);

    var onPointerDown = function (event) {
      if (!menu.contains(event.target)) close({ restoreFocus: false });
    };
    var onKeyDown = function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
      var list = enabledItems(menu);
      if (!list.length) return;
      if (event.key === 'Enter') {
        var active = doc.activeElement;
        if (menu.contains(active) && !active.disabled) {
          event.preventDefault();
          active.click();
        }
        return;
      }
      event.preventDefault();
      var at = list.indexOf(doc.activeElement);
      var next = 0;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = list.length - 1;
      else if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
      else next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
      list[next].focus();
    };
    var onResizeOrBlur = function () { close({ restoreFocus: false }); };

    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    global.addEventListener('resize', onResizeOrBlur);
    global.addEventListener('blur', onResizeOrBlur);
    cleanupListeners = function () {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      global.removeEventListener('resize', onResizeOrBlur);
      global.removeEventListener('blur', onResizeOrBlur);
    };

    var first = enabledItems(menu)[0];
    if (first) first.focus({ preventScroll: true });
    return menu;
  }

  /**
   * Binds 500ms touch long-press on matching descendants of `root`, cancelling on >10px drift.
   */
  function installLongPress(root, selector, handler, delayMs) {
    if (!root || typeof handler !== 'function') return function () {};
    var holdMs = delayMs || 500;
    var timer = null;
    var origin = null;
    var matchEl = null;

    function cancel() {
      if (timer) global.clearTimeout(timer);
      timer = null;
      origin = null;
      matchEl = null;
    }

    function onTouchStart(event) {
      if (!event.touches || event.touches.length !== 1) { cancel(); return; }
      var match = selector ? (event.target.closest && event.target.closest(selector)) : root;
      if (!match || !root.contains(match)) return;
      var touch = event.touches[0];
      origin = { x: touch.clientX, y: touch.clientY };
      matchEl = match;
      cancelTimerOnly();
      timer = global.setTimeout(function () {
        var el = matchEl;
        var pos = origin;
        cancel();
        if (!el || !el.isConnected) return;
        handler(el, {
          clientX: pos ? pos.x : 16,
          clientY: pos ? pos.y : 16,
          longPress: true,
        }, event);
      }, holdMs);
    }

    function cancelTimerOnly() {
      if (timer) global.clearTimeout(timer);
      timer = null;
    }

    function onTouchMove(event) {
      if (!origin || !event.touches || event.touches.length !== 1) { cancel(); return; }
      var touch = event.touches[0];
      if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 10) cancel();
    }

    root.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    root.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    root.addEventListener('touchend', cancel, { passive: true, capture: true });
    root.addEventListener('touchcancel', cancel, { passive: true, capture: true });

    return function () {
      cancel();
      root.removeEventListener('touchstart', onTouchStart, { capture: true });
      root.removeEventListener('touchmove', onTouchMove, { capture: true });
      root.removeEventListener('touchend', cancel, { capture: true });
      root.removeEventListener('touchcancel', cancel, { capture: true });
    };
  }

  global.ContextMenu = {
    open: open,
    close: close,
    isOpen: function () { return Boolean(activeMenu && !activeMenu.hidden); },
    installLongPress: installLongPress,
  };
})(typeof window !== 'undefined' ? window : globalThis);
