// Where an agent's draft goes: `<project>/.anymux/docs/<name>.md`, kept out of
// git through the repository's own info/exclude (never the project's
// .gitignore). A directory that is no project, or a project the preview may
// not read, gets `<app data>/docs/<project name>/` instead. Nothing is written
// outside the roots the file preview serves.
//
// Paths are the panel's: MSYS form on Windows (/c/Users/me), translated only
// for the fs calls, as in lib/api/files.js.

import { promises as fs } from 'node:fs';
import { posix, resolve as nativeResolve } from 'node:path';
import { IS_WINDOWS, toNativePath, toPosixPath } from '../msys.js';
import { appDir } from '../legacy-names.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { DRAFT_DIR } from './profiles.js';

export const EXCLUDE_PATTERN = '/.anymux/';
const MAX_DEPTH = 64;

export const pathSpace = IS_WINDOWS
  ? Object.freeze({
    toFs: (path) => toNativePath(path),
    toApi: (path) => (/^[a-zA-Z]:[\\/]/.test(path) ? toPosixPath(path) : path.replace(/\\/g, '/')),
    resolve: posix.resolve,
    // NTFS is case-insensitive.
    key: (path) => path.toLowerCase(),
  })
  : Object.freeze({ toFs: (path) => path, toApi: (path) => path, resolve: nativeResolve, key: (path) => path });

export function withinRoots(path, roots, space = pathSpace) {
  const key = space.key(path);
  return roots.some((root) => {
    const rootKey = space.key(space.resolve(space.toApi(root)));
    return rootKey === '/' ? key.startsWith('/') : key === rootKey || key.startsWith(rootKey + '/');
  });
}

function child(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

/** The nearest directory holding `.git` (a directory, or a worktree's file), or null. */
export async function findProjectRoot(dir, space = pathSpace) {
  let current = space.resolve(space.toApi(dir));
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = child(current, '.git');
    try {
      const info = await fs.stat(space.toFs(dotGit));
      return { root: current, dotGit, isFile: info.isFile() };
    } catch { /* keep looking */ }
    const parent = posix.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** The info/exclude git reads for this checkout; a worktree shares its main repository's. */
export async function excludeFile(project, space = pathSpace) {
  if (!project.isFile) return project.dotGit + '/info/exclude';
  const text = await fs.readFile(space.toFs(project.dotGit), 'utf8');
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return null;
  const absolute = (path, base) => {
    const converted = space.toApi(path);
    return converted.startsWith('/') ? space.resolve(converted) : space.resolve(base, converted);
  };
  const gitDir = absolute(match[1], project.root);
  let common = gitDir;
  try {
    const pointer = (await fs.readFile(space.toFs(gitDir + '/commondir'), 'utf8')).trim();
    if (pointer) common = absolute(pointer, gitDir);
  } catch { /* not a linked worktree */ }
  return common + '/info/exclude';
}

/** Adds the drafts directory to an exclude file once; true when it is excluded afterwards. */
export async function ensureExcluded(file, space = pathSpace) {
  let text = '';
  try { text = await fs.readFile(space.toFs(file), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const known = new Set([EXCLUDE_PATTERN, '.anymux/', '/.anymux', '.anymux']);
  if (text.split(/\r?\n/).some((line) => known.has(line.trim()))) return true;
  await fs.mkdir(space.toFs(posix.dirname(file)), { recursive: true });
  await fs.appendFile(space.toFs(file), (text && !text.endsWith('\n') ? '\n' : '')
    + '# Anymux: agent document drafts\n' + EXCLUDE_PATTERN + '\n');
  return true;
}

/** A file name from what the agent called the document: letters (any script), digits, `.`, `_`, `-`. */
export function docSlug(name) {
  const slug = String(name ?? '').normalize('NFC').trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/g, '');
  return slug || null;
}

/** `name` may carry its extension (`plan.md`); otherwise `ext` decides. */
export function splitDocName(name, ext = 'md') {
  const match = /^(.*?)\.(md|markdown|html?)$/i.exec(String(name ?? '').trim());
  const slug = docSlug(match ? match[1] : name);
  const extension = (match ? match[2] : ext || 'md').toLowerCase();
  if (!slug) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Document name is empty');
  if (!['md', 'markdown', 'html', 'htm'].includes(extension)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'Documents are Markdown or HTML');
  return { slug, ext: extension };
}

async function exists(path, space) {
  try { await fs.stat(space.toFs(path)); return true; } catch { return false; }
}

/**
 * The path for a draft named `name`, started from `cwd` (the agent's working
 * directory, native or MSYS). Creates the directory so the agent can write.
 */
export async function draftLocation({ cwd, name, ext, roots, space = pathSpace, dataDir = appDir('data') }) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new AppError(ErrorCode.VALIDATION_ERROR, 'cwd is required');
  if (!Array.isArray(roots) || roots.length === 0) throw new AppError(ErrorCode.VALIDATION_ERROR, 'No previewable roots');
  const dir = space.resolve(space.toApi(cwd.trim()));
  if (!dir.startsWith('/')) throw new AppError(ErrorCode.VALIDATION_ERROR, 'cwd must be absolute');
  const { slug, ext: extension } = splitDocName(name, ext);
  const project = await findProjectRoot(dir, space).catch(() => null);

  let docsDir;
  let inProject = false;
  let excluded = false;
  if (project && withinRoots(project.root, roots, space)) {
    docsDir = child(project.root, DRAFT_DIR);
    inProject = true;
    try {
      const exclude = await excludeFile(project, space);
      excluded = exclude ? await ensureExcluded(exclude, space) : false;
    } catch { excluded = false; }
  } else {
    const projectName = docSlug(posix.basename(project ? project.root : dir)) || 'misc';
    docsDir = space.resolve(space.toApi(dataDir)) + '/docs/' + projectName;
    if (!withinRoots(docsDir, roots, space)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'No previewable place for drafts: the project and the app data directory are outside the preview roots');
    }
  }
  await fs.mkdir(space.toFs(docsDir), { recursive: true });
  const path = docsDir + '/' + slug + '.' + extension;
  return {
    path,
    nativePath: space.toFs(path),
    dir: docsDir,
    project: project ? project.root : null,
    inProject,
    excluded,
    exists: await exists(path, space),
  };
}
