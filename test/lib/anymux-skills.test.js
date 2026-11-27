import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterCapabilityBlocks,
  getBundledSkill,
  installBundledSkills,
  listBundledSkills,
  parseFrontmatter,
} from '../../lib/cli/skills.js';
import { ManagedResources } from '../../lib/managed-resources.js';
import { REPO_ROOT, repoPath } from '../../lib/paths.js';

const cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function makeTempDir(prefix = 'anymux-skills-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('bundled skills registry and capability gating', () => {
  it('parses frontmatter and lists all bundled skills including anymux-cli references', async () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: hello\n---\n\n# Body\n');
    expect(parsed.frontmatter).toEqual({ name: 'demo', description: 'hello' });
    expect(parsed.body.trim()).toBe('# Body');

    const topics = await listBundledSkills();
    expect(topics.map((t) => t.name)).toEqual([
      'anymux-cli',
      'anymux',
      'agent-docs',
      'anymux-presentation',
      'tmux-agent',
    ]);

    const cliTopic = topics.find((t) => t.name === 'anymux-cli');
    expect(cliTopic.hasGuide).toBe(true);
    expect(cliTopic.references).toEqual([
      'automations',
      'browser',
      'remote-servers',
      'rich-panes',
      'sessions',
      'worktrees',
    ]);
  });

  it('filters plugin-capability blocks when host capabilities are verified', async () => {
    const sample = [
      'Header',
      '',
      '<!-- plugin-capability: browser -->',
      'Browser docs',
      '<!-- /plugin-capability -->',
      '',
      '<!-- plugin-capability: worktrees -->',
      'Worktree docs',
      '<!-- /plugin-capability -->',
    ].join('\n');

    expect(filterCapabilityBlocks(sample, new Set(['worktrees']))).toBe('Header\n\nWorktree docs\n');
    expect(filterCapabilityBlocks(sample, null)).toBe('Header\n\nBrowser docs\n\nWorktree docs\n');

    const allEnabled = new Set(['worktrees', 'workbench', 'browser', 'automations', 'session-vault', 'servers']);
    const refsAll = await getBundledSkill({
      name: 'anymux-cli',
      listReferences: true,
      enabledCapabilities: allEnabled,
      verified: true,
    });
    expect(refsAll.warnings).toEqual([]);
    expect(refsAll.data.references).toHaveLength(6);

    const limited = new Set(['worktrees']);
    const refsLimited = await getBundledSkill({
      name: 'anymux-cli',
      listReferences: true,
      enabledCapabilities: limited,
      verified: true,
    });
    expect(refsLimited.data.references).toEqual(['worktrees']);

    await expect(getBundledSkill({
      name: 'anymux-cli',
      reference: 'references/browser.md',
      enabledCapabilities: limited,
      verified: true,
    })).rejects.toMatchObject({ code: 'reference_unavailable' });

    const wtRef = await getBundledSkill({
      name: 'anymux-cli',
      reference: 'references/worktrees.md',
      enabledCapabilities: limited,
      verified: true,
    });
    expect(wtRef.data.reference).toBe('worktrees');
    expect(wtRef.data.markdown).toContain('anymux worktree list'.replace('anymux', 'ANYMUX'));

    const fullLimited = await getBundledSkill({
      name: 'anymux-cli',
      full: true,
      enabledCapabilities: limited,
      verified: true,
    });
    expect(fullLimited.data.markdown).toContain('<!-- bundled-reference: references/worktrees.md -->');
    expect(fullLimited.data.markdown).not.toContain('references/browser.md');
  });

  it('keeps gated content and emits host_capabilities_unverified when panel is offline', async () => {
    const res = await getBundledSkill({
      name: 'anymux-cli',
      enabledCapabilities: null,
      verified: false,
    });
    expect(res.warnings).toEqual(['host_capabilities_unverified']);
    expect(res.data.markdown).toContain('references/worktrees.md');
    expect(res.data.markdown).not.toContain('<!-- plugin-capability:');
  });

  it('validates mutually exclusive options, unknown skills, and unknown references', async () => {
    await expect(getBundledSkill({ name: 'anymux-cli', full: true, reference: 'worktrees' }))
      .rejects.toMatchObject({ code: 'invalid_argument', exitCode: 2 });
    await expect(getBundledSkill({ name: 'anymux-cli', listReferences: true, full: true }))
      .rejects.toMatchObject({ code: 'invalid_argument', exitCode: 2 });
    await expect(getBundledSkill({ name: 'no-such-skill' }))
      .rejects.toMatchObject({ code: 'skill_not_found', exitCode: 2 });
    await expect(getBundledSkill({ name: 'anymux-cli', reference: 'missing' }))
      .rejects.toMatchObject({ code: 'reference_not_found', exitCode: 2 });
  });
});

describe('conflict-safe skill installation and ManagedResources registration', () => {
  it('installs to specific and all targets, preserves personal conflicts, and updates legacy symlinks', async () => {
    const home = await makeTempDir('anymux-skill-home-');

    const first = await installBundledSkills({
      names: ['anymux-cli'],
      agents: 'universal,codex,claude,gemini',
      userHome: home,
    });
    expect(first.targets).toEqual(['universal', 'codex', 'claude', 'gemini']);
    expect(first.results.every((r) => r.status === 'installed')).toBe(true);
    expect(await readlink(join(home, '.agents', 'skills', 'anymux-cli'))).toBe(repoPath('skills', 'anymux-cli'));
    expect(await readlink(join(home, '.gemini', 'skills', 'anymux-cli'))).toBe(repoPath('skills', 'anymux-cli'));

    // Conflict protection: personal directory is never overwritten.
    const personal = join(home, '.codex', 'skills', 'anymux');
    await mkdir(personal, { recursive: true });
    await writeFile(join(personal, 'SKILL.md'), 'personal skill');

    // Legacy symlink pointing at old plugins/tmux-agent path is repaired on update.
    const tmuxAgentDest = join(home, '.claude', 'skills', 'tmux-agent');
    await mkdir(join(tmuxAgentDest, '..'), { recursive: true });
    await symlink(repoPath('plugins', 'tmux-agent', 'skills', 'tmux-agent'), tmuxAgentDest, 'dir');

    const second = await installBundledSkills({
      agents: 'all',
      update: true,
      userHome: home,
    });
    const conflictEntry = second.results.find((r) => r.name === 'anymux' && r.target === 'codex');
    expect(conflictEntry.status).toBe('conflict');
    expect(second.warnings.some((w) => w.includes('conflict:codex:anymux'))).toBe(true);
    expect(await readFile(join(personal, 'SKILL.md'), 'utf8')).toBe('personal skill');

    const updatedEntry = second.results.find((r) => r.name === 'tmux-agent' && r.target === 'claude');
    expect(updatedEntry.status).toBe('updated');
    expect(await readlink(tmuxAgentDest)).toBe(repoPath('catalog', 'tmux-agent', 'skills', 'tmux-agent'));

    const unchangedEntry = second.results.find((r) => r.name === 'anymux-cli' && r.target === 'universal');
    expect(unchangedEntry.status).toBe('unchanged');
  });

  it('registers anymux-cli in ManagedResources without altering existing 4-target contract', async () => {
    const home = await makeTempDir('anymux-mr-');
    const resources = new ManagedResources({
      userHome: home,
      configDir: join(home, 'config'),
      projectDir: REPO_ROOT,
    });
    await resources.load();
    await resources.changeSkill('anymux-cli', 'codex', true);
    const status = await resources.status();
    const cliSkills = status.skills.filter((s) => s.name === 'anymux-cli');
    expect(cliSkills).toHaveLength(4);
    expect(cliSkills.find((s) => s.target === 'codex').status).toBe('managed');
    expect((await lstat(resources.skillPath('anymux-cli', 'codex'))).isSymbolicLink()).toBe(true);
  });
});
