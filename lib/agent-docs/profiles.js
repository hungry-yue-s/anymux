// Documents agents write for the person at the panel to read, and how the side
// panel treats each kind. Skills that keep their own document directories
// (superpowers) keep them: the panel shows what lands there and never moves it.
//
// Paths are the panel's (MSYS form on Windows) and matched anywhere below a
// project, so a draft or a plan is recognised wherever the project lives.

export const DRAFT_DIR = '.anymux/docs';

/**
 * `open`: 'activate' puts the new document in front; 'background' only adds its
 * tab (a progress log changes all the time and must not take the dock over).
 * `proposals`: drafts may carry a suggested project location in front matter.
 */
export const DOC_PROFILES = Object.freeze([
  { id: 'anymux-draft', owner: 'anymux', kind: 'draft', label: '草稿', open: 'activate', proposals: true,
    match: /(?:^|\/)\.anymux\/docs\/[^/]+\.(?:md|markdown|html?)$/i },
  { id: 'superpowers-spec', owner: 'superpowers', kind: 'spec', label: '设计', open: 'activate',
    match: /(?:^|\/)docs\/superpowers\/specs\/[^/]+\.md$/i },
  { id: 'superpowers-plan', owner: 'superpowers', kind: 'plan', label: '计划', open: 'activate',
    match: /(?:^|\/)docs\/superpowers\/plans\/[^/]+\.md$/i },
  { id: 'superpowers-progress', owner: 'superpowers', kind: 'progress', label: '进度', open: 'background',
    match: /(?:^|\/)\.superpowers\/sdd\/[^/]+\/progress\.md$/i },
].map(Object.freeze));

/**
 * Where documents appear below a project root. `depth` 1 lists the directory's
 * files; 2 looks one level down for `file` (a workflow's own folder).
 */
export const WATCH_DIRS = Object.freeze([
  { dir: DRAFT_DIR, depth: 1 },
  { dir: 'docs/superpowers/specs', depth: 1 },
  { dir: 'docs/superpowers/plans', depth: 1 },
  { dir: '.superpowers/sdd', depth: 2, file: 'progress.md' },
]);

/** The profile a path belongs to, or null for any other file. */
export function classifyDoc(path) {
  if (typeof path !== 'string' || !path) return null;
  const normalized = path.replace(/\\/g, '/');
  return DOC_PROFILES.find((profile) => profile.match.test(normalized)) || null;
}

/** What the page needs to know about a profile. */
export function describeProfile(profile) {
  if (!profile) return null;
  return { id: profile.id, owner: profile.owner, kind: profile.kind, label: profile.label, open: profile.open,
    proposals: !!profile.proposals };
}
