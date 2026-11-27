// FTS5 BM25 search, fts5vocab typo repair, snippet highlights, and fork collapse.
// Ported from stablyai/orca (MIT).

function editDistance(a, b, maxDist = 2) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function buildFtsMatchQuery(tokens) {
  return tokens
    .filter(Boolean)
    .map((t) => `"${String(t).replace(/"/g, '""')}"*`)
    .join(' AND ');
}

function repairQueryTerms(db, tokens) {
  let vocabRows = [];
  try {
    vocabRows = db.prepare('SELECT term, doc FROM session_fts_vocab WHERE length(term) >= 3 ORDER BY doc DESC LIMIT 2000').all();
  } catch {
    return null;
  }
  if (!vocabRows.length) return null;

  let changed = false;
  const repaired = tokens.map((raw) => {
    const token = raw.toLowerCase();
    if (token.length < 4) return token;
    const maxDist = token.length >= 7 ? 2 : 1;
    let bestTerm = null;
    let bestDist = maxDist + 1;
    let bestDocs = -1;
    for (const row of vocabRows) {
      const cand = String(row.term || '').toLowerCase();
      if (cand === token) return token;
      const dist = editDistance(token, cand, maxDist);
      if (dist < bestDist || (dist === bestDist && row.doc > bestDocs)) {
        bestDist = dist;
        bestTerm = cand;
        bestDocs = row.doc;
      }
    }
    if (bestTerm && bestDist <= maxDist) {
      changed = true;
      return bestTerm;
    }
    return token;
  });

  return changed ? repaired : null;
}

export function searchSessionVault(vaultDb, {
  q = '',
  provider = '',
  cwd = '',
  limit = 50,
  includeForks = false,
} = {}) {
  const { db } = vaultDb;
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  const rawTokens = String(q || '').trim().split(/\s+/).filter(Boolean);

  if (!rawTokens.length) {
    const clauses = [];
    const params = [];
    if (provider) { clauses.push('provider = ?'); params.push(provider); }
    if (cwd) { clauses.push('cwd LIKE ?'); params.push(`${cwd}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT *, COALESCE(NULLIF(fork_parent, ''), key) AS family_key
      FROM sessions ${where}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...params, capped * 2);
    const items = collapseForks(rows, includeForks).slice(0, capped);
    return { results: items, correctedQuery: null };
  }

  const runFts = (tokens) => {
    const matchExpr = buildFtsMatchQuery(tokens);
    if (!matchExpr) return [];
    const clauses = ['session_fts MATCH ?'];
    const params = [matchExpr];
    if (provider) { clauses.push('s.provider = ?'); params.push(provider); }
    if (cwd) { clauses.push('s.cwd LIKE ?'); params.push(`${cwd}%`); }
    return db.prepare(`
      SELECT s.*,
        COALESCE(NULLIF(s.fork_parent, ''), s.key) AS family_key,
        bm25(session_fts, 10.0, 3.0, 2.0, 1.0) AS rank_score,
        snippet(session_fts, 4, '<mark>', '</mark>', '…', 20) AS snippet
      FROM session_fts
      JOIN sessions s ON s.key = session_fts.session_key
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank_score ASC, s.updated_at DESC
      LIMIT ?
    `).all(...params, capped * 2);
  };

  let rows = runFts(rawTokens);
  let correctedQuery = null;

  if (!rows.length) {
    const repaired = repairQueryTerms(db, rawTokens);
    if (repaired) {
      rows = runFts(repaired);
      if (rows.length) correctedQuery = repaired.join(' ');
    }
  }

  return {
    results: collapseForks(rows, includeForks).slice(0, capped),
    correctedQuery,
  };
}

function collapseForks(rows, includeForks) {
  if (includeForks) return rows;
  const seenFamilies = new Map();
  const ordered = [];
  for (const row of rows) {
    const fam = row.family_key || row.key;
    const existing = seenFamilies.get(fam);
    if (!existing) {
      const entry = { ...row, forkCount: 0 };
      seenFamilies.set(fam, entry);
      ordered.push(entry);
    } else {
      existing.forkCount += 1;
    }
  }
  return ordered;
}
