/**
 * Zero-dependency parser for tmux `#{window_layout}` strings.
 *
 * Format: `<4hex_checksum>,<width>x<height>,<x>,<y>(,<paneNum>|{...}|[...])`
 * Can run identically in Node.js and browser clients.
 */

/** Computes tmux's 16-bit rotating checksum as a 4-char lowercase hex string. */
export function tmuxLayoutChecksum(body) {
  let csum = 0;
  for (let i = 0; i < body.length; i++) {
    csum = ((csum >> 1) + ((csum & 1) << 15) + body.charCodeAt(i)) & 0xffff;
  }
  return csum.toString(16).padStart(4, '0');
}

function readInt(text, pos, delim) {
  let end = pos;
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
  if (end === pos) return null;
  if (delim !== null && text[end] !== delim) return null;
  const value = Number(text.slice(pos, end));
  if (!Number.isSafeInteger(value)) return null;
  return { value, next: delim === null ? end : end + 1 };
}

function parseNode(text, pos) {
  const w = readInt(text, pos, 'x');
  if (!w || w.value <= 0) return null;
  const h = readInt(text, w.next, ',');
  if (!h || h.value <= 0) return null;
  const x = readInt(text, h.next, ',');
  if (!x || x.value < 0) return null;
  const y = readInt(text, x.next, null);
  if (!y || y.value < 0 || y.next >= text.length) return null;

  const marker = text[y.next];
  if (marker === ',') {
    const id = readInt(text, y.next + 1, null);
    if (!id) return null;
    return {
      node: { type: 'pane', paneId: `%${id.value}`, width: w.value, height: h.value, x: x.value, y: y.value },
      next: id.next,
    };
  }

  if (marker !== '{' && marker !== '[') return null;
  const close = marker === '{' ? '}' : ']';
  const dir = marker === '{' ? 'row' : 'col';
  const children = [];
  let cursor = y.next + 1;
  while (cursor < text.length) {
    const child = parseNode(text, cursor);
    if (!child) return null;
    children.push(child.node);
    cursor = child.next;
    if (text[cursor] === ',') { cursor++; continue; }
    if (text[cursor] === close) {
      if (children.length < 1) return null;
      return {
        node: { type: 'split', dir, width: w.value, height: h.value, x: x.value, y: y.value, children },
        next: cursor + 1,
      };
    }
    return null;
  }
  return null;
}

/**
 * Parses a tmux layout string into a typed layout tree.
 * Returns `null` if the string is malformed or fails checksum verification.
 */
export function parseTmuxLayout(layoutString) {
  if (typeof layoutString !== 'string') return null;
  const match = /^([0-9a-fA-F]{4}),(.+)$/.exec(layoutString.trim());
  if (!match) return null;
  const [, checksum, body] = match;
  if (checksum.toLowerCase() !== tmuxLayoutChecksum(body)) return null;
  const parsed = parseNode(body, 0);
  if (!parsed || parsed.next !== body.length) return null;
  return parsed.node;
}

function serializeNode(node) {
  if (!node || !Number.isInteger(node.width) || node.width <= 0 || !Number.isInteger(node.height) || node.height <= 0
    || !Number.isInteger(node.x) || node.x < 0 || !Number.isInteger(node.y) || node.y < 0) {
    return null;
  }
  const header = `${node.width}x${node.height},${node.x},${node.y}`;
  if (node.type === 'pane') {
    const rawId = String(node.paneId || '');
    const numMatch = /^%?(\d+)$/.exec(rawId);
    if (!numMatch) return null;
    return `${header},${numMatch[1]}`;
  }
  if (node.type !== 'split' || (node.dir !== 'row' && node.dir !== 'col') || !Array.isArray(node.children) || !node.children.length) {
    return null;
  }
  const open = node.dir === 'row' ? '{' : '[';
  const close = node.dir === 'row' ? '}' : ']';
  const childParts = [];
  for (const child of node.children) {
    const serialized = serializeNode(child);
    if (!serialized) return null;
    childParts.push(serialized);
  }
  return `${header}${open}${childParts.join(',')}${close}`;
}

/** Serializes a layout tree back into `<4hex_checksum>,<body>`. */
export function serializeTmuxLayout(tree) {
  const body = serializeNode(tree);
  if (!body) return null;
  return `${tmuxLayoutChecksum(body)},${body}`;
}

/** Topology signature ignoring dimensions, e.g. `row(pane(%0),col(pane(%1),pane(%2)))`. */
export function layoutTopologySignature(node) {
  if (!node) return '';
  if (node.type === 'pane') return `pane(${node.paneId || ''})`;
  if (node.type !== 'split' || !Array.isArray(node.children)) return '';
  return `${node.dir}(${node.children.map(layoutTopologySignature).join(',')})`;
}

function extractRatioNode(node) {
  if (!node || node.type === 'pane') return null;
  const children = node.children || [];
  if (!children.length) return null;
  const sizes = children.map((c) => Math.max(1, node.dir === 'row' ? c.width : c.height));
  const total = sizes.reduce((sum, n) => sum + n, 0) || 1;
  return {
    dir: node.dir,
    weights: sizes.map((n) => Math.round((n / total) * 1_000_000) / 1_000_000),
    children: children.map(extractRatioNode),
  };
}

/** Captures normalized floating-point split ratios for lossless proportional scaling. */
export function extractLayoutRatios(tree) {
  if (!tree || tree.type !== 'split') return null;
  const sig = layoutTopologySignature(tree);
  const node = extractRatioNode(tree);
  if (!sig || !node) return null;
  return { sig, node };
}

export function parseLayoutRatios(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed.sig !== 'string' || !parsed.node || typeof parsed.node !== 'object') return null;
    return { sig: parsed.sig, node: parsed.node };
  } catch {
    return null;
  }
}

function computeMinTree(node, paneMinById) {
  if (!node) return { w: 1, h: 1, children: [] };
  if (node.type === 'pane') {
    const custom = paneMinById?.get(node.paneId);
    return {
      w: Math.max(1, Number.isInteger(custom?.w) ? custom.w : 1),
      h: Math.max(1, Number.isInteger(custom?.h) ? custom.h : 1),
      children: [],
    };
  }
  const kids = (node.children || []).map((c) => computeMinTree(c, paneMinById));
  const sep = Math.max(0, kids.length - 1);
  if (node.dir === 'row') {
    return {
      w: kids.reduce((s, c) => s + c.w, 0) + sep,
      h: Math.max(1, ...kids.map((c) => c.h)),
      children: kids,
    };
  }
  return {
    w: Math.max(1, ...kids.map((c) => c.w)),
    h: kids.reduce((s, c) => s + c.h, 0) + sep,
    children: kids,
  };
}

function apportionAxis(available, weights, mins) {
  const n = weights.length;
  const alloc = new Array(n).fill(0);
  const fixed = new Array(n).fill(false);
  let remaining = available;

  while (true) {
    let activeWeight = 0;
    for (let i = 0; i < n; i++) {
      if (!fixed[i]) activeWeight += Math.max(0, Number(weights[i]) || 0);
    }
    const unfixed = fixed.filter((f) => !f).length;
    if (unfixed === 0) break;

    let clampedAny = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const w = activeWeight > 0 ? Math.max(0, Number(weights[i]) || 0) / activeWeight : 1 / unfixed;
      const exact = remaining * w;
      if (exact < mins[i]) {
        alloc[i] = mins[i];
        fixed[i] = true;
        remaining -= mins[i];
        clampedAny = true;
      }
    }
    if (!clampedAny) {
      const remainders = [];
      let used = 0;
      for (let i = 0; i < n; i++) {
        if (fixed[i]) continue;
        const w = activeWeight > 0 ? Math.max(0, Number(weights[i]) || 0) / activeWeight : 1 / unfixed;
        const exact = remaining * w;
        const base = Math.max(mins[i], Math.floor(exact));
        alloc[i] = base;
        used += base;
        remainders.push({ i, rem: exact - base });
      }
      let extra = remaining - used;
      remainders.sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
      let idx = 0;
      while (extra > 0 && remainders.length > 0) {
        alloc[remainders[idx % remainders.length].i] += 1;
        extra -= 1;
        idx += 1;
      }
      break;
    }
  }
  return alloc;
}

function buildScaledNode(node, ratioNode, minTree, width, height, x, y) {
  if (node.type === 'pane') {
    return { type: 'pane', paneId: node.paneId, width, height, x, y };
  }
  const children = node.children || [];
  const k = children.length;
  const sep = Math.max(0, k - 1);
  const ratioValid = ratioNode && ratioNode.dir === node.dir && Array.isArray(ratioNode.weights) && ratioNode.weights.length === k;
  const weights = ratioValid
    ? ratioNode.weights
    : children.map((c) => Math.max(1, node.dir === 'row' ? c.width : c.height));
  const mins = minTree.children.map((m) => (node.dir === 'row' ? m.w : m.h));
  const targetMain = Math.max(1, (node.dir === 'row' ? width : height) - sep);
  const sizes = apportionAxis(targetMain, weights, mins);

  const scaledChildren = [];
  let cursorX = x;
  let cursorY = y;
  for (let i = 0; i < k; i++) {
    const cw = node.dir === 'row' ? sizes[i] : width;
    const ch = node.dir === 'col' ? sizes[i] : height;
    const childRatio = ratioValid && Array.isArray(ratioNode.children) ? ratioNode.children[i] : null;
    scaledChildren.push(buildScaledNode(children[i], childRatio, minTree.children[i], cw, ch, cursorX, cursorY));
    if (node.dir === 'row') cursorX += cw + 1;
    else cursorY += ch + 1;
  }

  return {
    type: 'split',
    dir: node.dir,
    width,
    height,
    x,
    y,
    children: scaledChildren,
  };
}

/**
 * Computes a proportionally scaled tmux layout string for `(targetCols, targetRows)`
 * while honoring per-pane minimums and preserving caller-supplied floating ratios.
 */
export function scaleTmuxLayout(tree, targetCols, targetRows, savedRatios = null, { paneMinById = null } = {}) {
  if (!tree || tree.type !== 'split') return null;
  if (!Number.isInteger(targetCols) || !Number.isInteger(targetRows) || targetCols < 2 || targetRows < 2) return null;
  const minTree = computeMinTree(tree, paneMinById);
  if (targetCols < minTree.w || targetRows < minTree.h) return null;
  const sig = layoutTopologySignature(tree);
  const ratioRoot = (savedRatios && savedRatios.sig === sig && savedRatios.node)
    ? savedRatios.node
    : extractRatioNode(tree);
  const scaled = buildScaledNode(tree, ratioRoot, minTree, targetCols, targetRows, 0, 0);
  return serializeTmuxLayout(scaled);
}
