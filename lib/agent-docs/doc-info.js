// What the side panel shows above an agent document: which kind it is and, for
// a draft, where the agent suggests putting it in the project. The suggestion
// lives in the draft's front matter, under `anymux:`:
//
//   ---
//   anymux:
//     status: proposed
//     target: docs/agent-docs-design.md
//     reason: 同类设计文档都在 docs/*-design.md
//     alternatives: [docs/design/agent-docs.md]
//     also: CLAUDE.md 加一行链接
//   ---
//
// Only Anymux drafts are read for it; skill-owned documents carry no panel
// metadata.

import { promises as fs } from 'node:fs';
import { parse } from 'yaml';
import { classifyDoc, describeProfile } from './profiles.js';

const HEAD_BYTES = 16 * 1024;
const STATUSES = new Set(['draft', 'proposed', 'placed', 'kept']);

function text(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return result ? result.slice(0, max) : null;
}

/** The `anymux:` block of a Markdown front matter, cleaned up; null when there is none. */
export function parseProposal(content) {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content || '');
  if (!match) return null;
  let data;
  try { data = parse(match[1]); } catch { return null; }
  const block = data && typeof data === 'object' ? data.anymux : null;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const status = text(block.status, 20);
  const alternatives = (Array.isArray(block.alternatives) ? block.alternatives : [])
    .map((item) => text(item, 300)).filter(Boolean).slice(0, 5);
  return {
    status: status && STATUSES.has(status) ? status : 'draft',
    target: text(block.target, 300),
    reason: text(block.reason, 500),
    alternatives,
    also: text(block.also, 300),
  };
}

/** `nativePath` is read for the front matter; `path` decides the kind. */
export async function readDocInfo(path, nativePath) {
  const profile = classifyDoc(path);
  if (!profile) return null;
  const info = describeProfile(profile);
  if (!profile.proposals || !/\.(md|markdown)$/i.test(path)) return { ...info, proposal: null };
  let head = '';
  let handle;
  try {
    handle = await fs.open(nativePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    head = '';
  } finally {
    await handle?.close().catch(() => {});
  }
  return { ...info, proposal: parseProposal(head) };
}
