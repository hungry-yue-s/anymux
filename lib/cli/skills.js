/**
 * Version-matched skill guide registry, plugin-capability gating, and conflict-safe installer.
 */

import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { repoPath } from '../paths.js';
import { CliError } from './errors.js';

export const BUNDLED_SKILLS = Object.freeze({
  'anymux-cli': {
    dir: 'skills/anymux-cli',
    stubFile: 'SKILL.md',
    guideFile: 'guide.md',
    referencesDir: 'references',
  },
  'anymux': {
    dir: 'skills/anymux',
    stubFile: 'SKILL.md',
  },
  'agent-docs': {
    dir: 'skills/agent-docs',
    stubFile: 'SKILL.md',
  },
  'anymux-presentation': {
    dir: 'skills/anymux-presentation',
    stubFile: 'SKILL.md',
  },
  'tmux-agent': {
    dir: 'catalog/tmux-agent/skills/tmux-agent',
    stubFile: 'SKILL.md',
    legacyDirs: ['plugins/tmux-agent/skills/tmux-agent'],
  },
});

export const CLI_SKILL_TARGETS = Object.freeze({
  universal: { envVar: 'AGENTS_HOME', baseDir: '.agents', subDir: 'skills' },
  codex: { envVar: 'CODEX_HOME', baseDir: '.codex', subDir: 'skills' },
  claude: { envVar: 'CLAUDE_CONFIG_DIR', baseDir: '.claude', subDir: 'skills' },
  qoder: { envVar: 'QODER_CONFIG_DIR', baseDir: '.qoder', subDir: 'skills' },
  dsh: { envVar: 'DSH_HOME', baseDir: '.dsh', subDir: 'skills' },
  gemini: { envVar: 'GEMINI_CLI_HOME', baseDir: '.gemini', subDir: 'skills' },
});

const CAPABILITY_BLOCK_RE = /<!--\s*plugin-capability:\s*([a-z0-9-]+)\s*-->\r?\n+([\s\S]*?)\r?\n+<!--\s*\/plugin-capability\s*-->(\r?\n*)/g;

/**
 * Splits optional YAML frontmatter from a Markdown document.
 */
export function parseFrontmatter(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  let parsed = {};
  try {
    const loaded = YAML.parse(match[1]);
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) parsed = loaded;
  } catch {
    parsed = {};
  }
  return { frontmatter: parsed, body: match[2] };
}

export function hasCapabilityBlocks(markdown) {
  return /<!--\s*plugin-capability:\s*[a-z0-9-]+\s*-->/.test(String(markdown || ''));
}

/**
 * Filters `<!-- plugin-capability: <id> -->` blocks.
 * When `enabledSet` is null (host offline/unverified), strips markers while keeping body text.
 */
export function filterCapabilityBlocks(markdown, enabledSet) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  if (!hasCapabilityBlocks(text)) return text;
  const filtered = text.replace(CAPABILITY_BLOCK_RE, (_full, cap, body, tail) => {
    if (enabledSet === null || enabledSet === undefined) {
      return `${body}${tail}`;
    }
    return enabledSet.has(cap) ? `${body}${tail}` : '';
  });
  return filtered.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export async function resolveEnabledCapabilities({ client = null } = {}) {
  if (!client || typeof client.requestJson !== 'function') {
    return { enabled: null, verified: false, plugins: null };
  }
  try {
    const info = await client.requestJson('GET', '/api/node/info', null, { timeoutMs: 2000 });
    if (Array.isArray(info?.plugins)) {
      return { enabled: new Set(info.plugins), verified: true, plugins: info.plugins };
    }
  } catch {
    // Offline or older node: fail gracefully to unverified mode for docs reading.
  }
  return { enabled: null, verified: false, plugins: null };
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadReferences(skill, projectDir) {
  if (!skill.referencesDir) return [];
  const dir = join(projectDir, skill.dir, skill.referencesDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const refs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    const markdown = await readFile(join(dir, entry.name), 'utf8');
    refs.push({ name, markdown });
  }
  refs.sort((a, b) => a.name.localeCompare(b.name));
  return refs;
}

export async function listBundledSkills({ projectDir = repoPath() } = {}) {
  const topics = [];
  for (const [name, skill] of Object.entries(BUNDLED_SKILLS)) {
    const raw = await readOptional(join(projectDir, skill.dir, skill.stubFile));
    if (raw === null) continue;
    const { frontmatter } = parseFrontmatter(raw);
    const refs = await loadReferences(skill, projectDir);
    topics.push({
      name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
      hasGuide: Boolean(skill.guideFile),
      references: refs.map((r) => r.name),
    });
  }
  return topics;
}

function normalizeReferenceName(requested) {
  return String(requested || '')
    .trim()
    .replace(/^references\//, '')
    .replace(/\.md$/i, '');
}

export async function getBundledSkill({
  name,
  reference = null,
  listReferences = false,
  full = false,
  projectDir = repoPath(),
  enabledCapabilities = null,
  verified = false,
} = {}) {
  if (listReferences && full) {
    throw new CliError('invalid_argument', 'Use either --references or --full, not both.', { exitCode: 2 });
  }
  if (listReferences && reference !== null) {
    throw new CliError('invalid_argument', 'Use either --references or --reference, not both.', { exitCode: 2 });
  }
  if (full && reference !== null) {
    throw new CliError('invalid_argument', 'Use either --full or --reference, not both.', { exitCode: 2 });
  }
  if (!name || !Object.hasOwn(BUNDLED_SKILLS, name)) {
    throw new CliError('skill_not_found', `Unknown skill "${name || ''}".`, {
      data: { name: name || null },
      nextSteps: ['Run `anymux skills list --json` to see available skills.'],
      exitCode: 2,
    });
  }

  const skill = BUNDLED_SKILLS[name];
  const guidePath = join(projectDir, skill.dir, skill.guideFile || skill.stubFile);
  const rawGuide = await readOptional(guidePath);
  if (rawGuide === null) {
    throw new CliError('skill_not_found', `Skill guide file missing for "${name}".`, { exitCode: 1 });
  }

  const rawRefs = await loadReferences(skill, projectDir);
  const gatedRefs = rawRefs
    .map((ref) => ({ name: ref.name, markdown: filterCapabilityBlocks(ref.markdown, enabledCapabilities) }))
    .filter((ref) => ref.markdown.trim().length > 0);
  const warnings = !verified && (hasCapabilityBlocks(rawGuide) || rawRefs.some((r) => hasCapabilityBlocks(r.markdown)))
    ? ['host_capabilities_unverified']
    : [];

  if (listReferences) {
    if (!skill.referencesDir) {
      throw new CliError('invalid_argument', `Skill "${name}" has no bundled references.`, { exitCode: 2 });
    }
    return {
      mode: 'references',
      data: { name, references: gatedRefs.map((r) => r.name) },
      warnings,
    };
  }

  if (reference !== null) {
    if (!skill.referencesDir) {
      throw new CliError('invalid_argument', `Skill "${name}" has no bundled references.`, { exitCode: 2 });
    }
    const selector = normalizeReferenceName(reference);
    if (!selector) {
      throw new CliError('invalid_argument', 'Missing required --reference value.', { exitCode: 2 });
    }
    const rawMatch = rawRefs.find((r) => r.name === selector);
    if (!rawMatch) {
      const available = gatedRefs.map((r) => r.name).join(', ');
      throw new CliError(
        'reference_not_found',
        `Unknown reference "${reference}" for ${name}.${available ? ` Available: ${available}` : ''}`,
        {
          data: { name, reference, available: gatedRefs.map((r) => r.name) },
          nextSteps: [`Run \`anymux skills get ${name} --references\` to list available references.`],
          exitCode: 2,
        },
      );
    }
    const filtered = gatedRefs.find((r) => r.name === selector);
    if (!filtered) {
      throw new CliError(
        'reference_unavailable',
        `Reference "${reference}" for ${name} is unavailable because its plugin is not enabled on the target host.`,
        {
          data: { name, reference: selector },
          nextSteps: ['Enable the corresponding plugin in Settings -> 管理中心, or inspect with `--server`.'],
          exitCode: 1,
        },
      );
    }
    return {
      mode: 'reference',
      data: { name, reference: filtered.name, markdown: filtered.markdown },
      warnings,
    };
  }

  const mainMarkdown = filterCapabilityBlocks(rawGuide, enabledCapabilities);
  let markdown = mainMarkdown;
  if (full && gatedRefs.length > 0) {
    const docs = gatedRefs
      .map((ref) => `\n<!-- bundled-reference: references/${ref.name}.md -->\n\n${ref.markdown.trimEnd()}\n`)
      .join('');
    markdown = `${mainMarkdown.trimEnd()}\n\n---\n\n# Bundled references\n${docs}`;
  }

  return {
    mode: 'guide',
    data: { name, full: Boolean(full), markdown },
    warnings,
  };
}

function targetHomeDir(target, userHome, env) {
  const spec = CLI_SKILL_TARGETS[target];
  const moved = env?.[spec.envVar];
  if (typeof moved === 'string' && moved.trim()) return moved.trim();
  return join(userHome, spec.baseDir);
}

function resolveInstallTargets(agentsArg, userHome, env) {
  if (agentsArg == null || String(agentsArg).trim() === '') {
    const detected = Object.keys(CLI_SKILL_TARGETS).filter((t) => existsSync(targetHomeDir(t, userHome, env)));
    return detected.length ? detected : ['universal'];
  }
  const raw = String(agentsArg).trim();
  if (raw === 'all') return Object.keys(CLI_SKILL_TARGETS);
  const items = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length) {
    throw new CliError('invalid_argument', 'Missing required --agent value.', { exitCode: 2 });
  }
  const unique = [];
  for (const item of items) {
    if (!Object.hasOwn(CLI_SKILL_TARGETS, item)) {
      throw new CliError('invalid_argument', `Unknown skill target "${item}".`, {
        data: { target: item, allowed: [...Object.keys(CLI_SKILL_TARGETS), 'all'] },
        nextSteps: [`Valid --agent values: ${Object.keys(CLI_SKILL_TARGETS).join(', ')}, all`],
        exitCode: 2,
      });
    }
    if (!unique.includes(item)) unique.push(item);
  }
  return unique;
}

async function inspectLinkState(destPath, expectedSource, legacySources = []) {
  let info;
  try {
    info = await lstat(destPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'not_installed';
    throw error;
  }
  if (!info.isSymbolicLink()) return 'conflict';
  const current = await readlink(destPath);
  if (resolve(current) === resolve(expectedSource)) return 'managed';
  if (legacySources.some((old) => resolve(current) === resolve(old))) return 'moved';
  return 'conflict';
}

export async function installBundledSkills({
  names = null,
  agents = null,
  update = false,
  projectDir = repoPath(),
  userHome = homedir(),
  env = process.env,
} = {}) {
  const selectedNames = Array.isArray(names) && names.length ? names : Object.keys(BUNDLED_SKILLS);
  for (const name of selectedNames) {
    if (!Object.hasOwn(BUNDLED_SKILLS, name)) {
      throw new CliError('skill_not_found', `Unknown skill "${name}".`, {
        data: { name },
        nextSteps: ['Run `anymux skills list --json` to see available skills.'],
        exitCode: 2,
      });
    }
  }

  const targets = resolveInstallTargets(agents, userHome, env);
  const results = [];
  const warnings = [];

  for (const name of selectedNames) {
    const skill = BUNDLED_SKILLS[name];
    const source = join(projectDir, skill.dir);
    const legacySources = (skill.legacyDirs || []).map((rel) => join(projectDir, rel));

    for (const target of targets) {
      const spec = CLI_SKILL_TARGETS[target];
      const home = targetHomeDir(target, userHome, env);
      const dest = join(home, spec.subDir, name);
      const state = await inspectLinkState(dest, source, legacySources);

      if (state === 'conflict') {
        results.push({ name, target, path: dest, status: 'conflict' });
        warnings.push(`conflict:${target}:${name}:${dest}`);
        continue;
      }
      if (state === 'managed') {
        results.push({ name, target, path: dest, status: 'unchanged' });
        continue;
      }
      if (state === 'moved') {
        await unlink(dest);
        await symlink(source, dest, 'dir');
        results.push({ name, target, path: dest, status: 'updated' });
        continue;
      }
      await mkdir(join(dest, '..'), { recursive: true });
      await symlink(source, dest, 'dir');
      results.push({ name, target, path: dest, status: update ? 'updated' : 'installed' });
    }
  }

  return {
    action: update ? 'update' : 'install',
    targets,
    results,
    warnings,
  };
}
