// Load optional AUTOMATION_SOUL.md / SOUL.md context for automated tasks.
// Ported from stablyai/orca (MIT).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_SOUL_BYTES = 4096;
const CANDIDATES = ['.anymux/AUTOMATION_SOUL.md', 'AUTOMATION_SOUL.md', 'SOUL.md'];

export async function loadAutomationSoul(cwd) {
  if (!cwd) return { path: null, content: '' };
  for (const rel of CANDIDATES) {
    try {
      const full = join(cwd, rel);
      const raw = await readFile(full, 'utf8');
      const trimmed = raw.trim();
      if (trimmed) {
        return {
          path: full,
          content: trimmed.slice(0, MAX_SOUL_BYTES),
        };
      }
    } catch { /* try next candidate */ }
  }
  return { path: null, content: '' };
}
