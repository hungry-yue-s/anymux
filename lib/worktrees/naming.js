// Deterministic yet readable branch/worktree slug generator.
// Ported from stablyai/orca (MIT).

import { randomBytes } from 'node:crypto';

const ADJECTIVES = ['amber', 'brisk', 'calm', 'cedar', 'crisp', 'frost', 'glint', 'lunar', 'maple', 'noble', 'quiet', 'silver', 'solar', 'swift', 'vivid', 'zephyr'];
const NOUNS = ['badger', 'beacon', 'canyon', 'comet', 'falcon', 'fjord', 'glacier', 'harbor', 'lantern', 'meadow', 'osprey', 'pebble', 'summit', 'timber', 'valley', 'willow'];

export function generateWorktreeSlug(seed = '') {
  const suffix = randomBytes(2).toString('hex');
  if (seed && typeof seed === 'string' && seed.trim()) {
    const clean = seed.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (clean) return `${clean}-${suffix}`;
  }
  const b = randomBytes(2);
  const adj = ADJECTIVES[b[0] % ADJECTIVES.length];
  const noun = NOUNS[b[1] % NOUNS.length];
  return `${adj}-${noun}-${suffix}`;
}
