// Synthesize concise cross-agent handoff prompt from a stored transcript.
// Ported from stablyai/orca (MIT).

const FILE_PATH_RE = /(?:^|[\s`"'(])((?:\/[A-Za-z0-9._-]+){2,}|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})/g;

export function extractCitedPaths(turns, limit = 12) {
  const seen = new Set();
  for (const turn of turns || []) {
    const text = String(turn?.text || '');
    let m;
    FILE_PATH_RE.lastIndex = 0;
    while ((m = FILE_PATH_RE.exec(text)) !== null) {
      const candidate = m[1].trim();
      if (candidate && candidate.length <= 160) {
        seen.add(candidate);
        if (seen.size >= limit) return [...seen];
      }
    }
  }
  return [...seen];
}

export function buildHandoffPrompt({ session, turns = [], targetAgent = '', maxTailTurns = 6 } = {}) {
  if (!session) return '';
  const firstUser = turns.find((t) => t.role === 'user')?.text || session.title || '';
  const tail = turns.slice(-Math.max(1, maxTailTurns));
  const files = extractCitedPaths(turns, 10);

  const lines = [
    `# Cross-Agent Handoff (${session.provider} -> ${targetAgent || 'next-agent'})`,
    '',
    `- **Origin Session**: \`${session.provider}:${session.id}\``,
    session.cwd ? `- **Working Directory**: \`${session.cwd}\`` : null,
    session.gitBranch ? `- **Branch**: \`${session.gitBranch}\`` : null,
    session.resumeCommand ? `- **Original Resume**: \`${session.resumeCommand}\`` : null,
    '',
    '## Original Goal',
    firstUser.trim().slice(0, 500) || '(not captured)',
    '',
  ].filter((l) => l !== null);

  if (files.length) {
    lines.push('## Referenced Paths', ...files.map((f) => `- \`${f}\``), '');
  }

  if (tail.length) {
    lines.push('## Recent Transcript Context');
    for (const t of tail) {
      const tag = t.role === 'user' ? 'User' : 'Assistant';
      const snippet = String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 320);
      lines.push(`- **${tag}**: ${snippet}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
