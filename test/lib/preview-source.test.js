import { describe, it, expect, vi } from 'vitest';
import { resolvePreviewSource } from '../../lib/preview-source.js';

const INSTANCE = '1873:1700000000';
function setup({ secondWindow = false, complete = true } = {}) {
  const tree = { instanceId: INSTANCE, complete, sessions: [{ id: '$1', windows: [
    { id: '@1', panes: [{ id: '%1' }, { id: '%2' }] },
    { id: '@2', panes: [{ id: '%3' }] },
  ] }] };
  const deps = {
    workspace: { getWorkspace: async () => tree },
    tmux: {
      getServerInstance: vi.fn(async () => INSTANCE),
      listPaneCommands: vi.fn(async () => [
        { paneId: '%1', path: '/work/project' }, { paneId: '%2', path: '/work/project' },
        { paneId: '%3', path: secondWindow ? '/work/project' : '/other' },
      ]),
    },
  };
  return { deps, tree, resolve: source => resolvePreviewSource(deps, source) };
}

describe('preview source routing', () => {
  it('trusts a live pane even when the command is working in a separate worktree', async () => {
    const { resolve, deps } = setup();
    await expect(resolve({ paneId: '%2', cwd: '/separate/worktree' })).resolves.toEqual({ paneId: '%2', windowId: '@1', instanceId: INSTANCE });
    expect(deps.tmux.listPaneCommands).not.toHaveBeenCalled();
  });

  it.each(['%0', null])('recovers a stale or absent pane (%s) only to the unique cwd window', async paneId => {
    const { resolve } = setup();
    await expect(resolve({ paneId, cwd: '/work/project/./' })).resolves.toEqual({ paneId: null, windowId: '@1', instanceId: INSTANCE });
  });

  it('rejects a cwd shared by two windows instead of silently selecting one', async () => {
    const { resolve } = setup({ secondWindow: true });
    await expect(resolve({ paneId: '%0', cwd: '/work/project' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/ambiguous.*--pane/) });
  });

  it.each([undefined, '/unmatched', 'relative', '/work/\nproject'])('rejects an unusable cwd %s', async cwd => {
    await expect(setup().resolve({ paneId: '%0', cwd })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('--pane') });
  });

  it('does not guess from an incomplete workspace', async () => {
    await expect(setup({ complete: false }).resolve({ paneId: '%0', cwd: '/work/project' })).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a tmux restart during cwd resolution', async () => {
    const { resolve, deps } = setup();
    deps.tmux.getServerInstance.mockResolvedValue('999:999');
    await expect(resolve({ paneId: '%0', cwd: '/work/project' })).rejects.toMatchObject({ status: 409 });
  });
});
