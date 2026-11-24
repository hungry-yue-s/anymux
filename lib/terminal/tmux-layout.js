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
