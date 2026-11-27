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

  it('overrides stale $TMUX_PANE when OS ancestor PID chain hits a live pane_pid', async () => {
    const tree = {
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{
        id: '$0',
        name: 'DataAnt',
        windows: [{ id: '@0', index: 1, name: 'Windows', panes: [{ id: '%0', index: 1, command: 'agy', cwd: '/work/win' }] }],
      }, {
        id: '$3',
        name: '工作环境管理',
        windows: [{ id: '@10', index: 6, name: 'agy', panes: [{ id: '%33', index: 3, command: 'codex', cwd: '/Users/m' }] }],
      }],
    };
    const deps = {
      workspace: { getWorkspace: async () => tree },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async (sid) => (sid === '$0'
          ? [{ paneId: '%0', command: 'agy', path: '/work/win', pid: 18434 }]
          : [{ paneId: '%33', command: 'codex', path: '/Users/m', pid: 31400 }])),
      },
      getAncestorPids: vi.fn(async (pid) => (pid === 99999 ? [99999, 31798, 31400, 18130] : null)),
      readCodexThread: vi.fn(async () => null),
    };

    const resolved = await resolvePreviewSource(deps, {
      paneId: '%0',
      paneSource: 'env',
      tmuxServerPid: '1873',
      callerPid: 99999,
      cwd: '/separate/worktree',
    });
    expect(resolved).toEqual({ paneId: '%33', windowId: '@10', instanceId: '18130:1700000000' });
  });

  it('rejects untrusted $TMUX_PANE when server PID is stale or caller is detached from tmux pane tree', async () => {
    const tree = {
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{
        id: '$0',
        name: 'DataAnt',
        windows: [{ id: '@0', index: 1, name: 'Windows', panes: [{ id: '%0', index: 1, command: 'agy', cwd: '/work/win' }] }],
      }],
    };
    const deps = {
      workspace: { getWorkspace: async () => tree },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async () => [{ paneId: '%0', command: 'agy', path: '/work/win', pid: 18434 }]),
      },
      getAncestorPids: vi.fn(async () => [500, 32890, 5487]),
      readCodexThread: vi.fn(async () => null),
    };

    await expect(resolvePreviewSource(deps, {
      paneId: '%0',
      paneSource: 'env',
      tmuxServerPid: '1873',
      callerPid: 500,
      cwd: '/unrelated/dir',
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/preview_source_untrusted:.*server pid 1873 != live 18130.*detached from tmux pane tree.*--pane %N/),
    });
  });

  it('recovers Codex daemon pane uniquely via thread cwd and pane_title, or single cwd codex pane without title', async () => {
    const makeTree = (title) => ({
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{
        id: '$0',
        name: 'DataAnt',
        windows: [{ id: '@0', index: 1, name: 'Windows', panes: [{ id: '%0', index: 1, command: 'agy', cwd: '/Users/m' }] }],
      }, {
        id: '$3',
        name: '工作环境管理',
        windows: [{
          id: '@10',
          index: 6,
          name: 'agy',
          panes: [
            { id: '%18', index: 1, command: 'agy', cwd: '/Users/m' },
            { id: '%33', index: 3, command: 'codex', cwd: '/Users/m', ...(title ? { title } : {}) },
          ],
        }],
      }],
    });
    const makeDeps = (title) => ({
      workspace: { getWorkspace: async () => makeTree(title) },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async (sid) => (sid === '$0'
          ? [{ paneId: '%0', command: 'agy', path: '/Users/m', pid: 18434 }]
          : [
            { paneId: '%18', command: 'agy', path: '/Users/m', pid: 19098 },
            { paneId: '%33', command: 'codex', path: '/Users/m', pid: 31400, ...(title ? { title } : {}) },
          ])),
      },
      getAncestorPids: vi.fn(async () => [500, 32890, 5487]),
      readCodexThread: vi.fn(async () => ({ id: '01a21b99', cwd: '/Users/m', name: '调研 Gemini 与 GPT Agent 分工', title: 'prompt' })),
    });

    await expect(resolvePreviewSource(makeDeps('调研 Gemini 与 GPT Agent 分工 | massachusetts'), {
      paneId: '%0',
      paneSource: 'env',
      tmuxServerPid: '1873',
      callerPid: 500,
      cwd: '/Users/m',
      codexThreadId: '01a21b99',
    })).resolves.toEqual({ paneId: '%33', windowId: '@10', instanceId: '18130:1700000000' });

    await expect(resolvePreviewSource(makeDeps(''), {
      paneId: '%0',
      paneSource: 'env',
      tmuxServerPid: '1873',
      callerPid: 500,
      cwd: '/Users/m',
      codexThreadId: '01a21b99',
    })).resolves.toEqual({ paneId: '%33', windowId: '@10', instanceId: '18130:1700000000' });
  });

  it('intercepts ambiguous Codex daemon candidates with actionable --pane guidance', async () => {
    const tree = {
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{
        id: '$0',
        name: 'DataAnt',
        windows: [{ id: '@0', index: 1, name: 'Windows', panes: [{ id: '%0', index: 1, command: 'agy', cwd: '/Users/m' }] }],
      }, {
        id: '$3',
        name: '工作环境管理',
        windows: [{
          id: '@10',
          index: 6,
          name: 'agy',
          panes: [
            { id: '%33', index: 3, command: 'codex', cwd: '/Users/m', title: 'task A' },
            { id: '%41', index: 4, command: 'codex', cwd: '/Users/m', title: 'task B' },
          ],
        }],
      }],
    };
    const deps = {
      workspace: { getWorkspace: async () => tree },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async (sid) => (sid === '$0'
          ? [{ paneId: '%0', command: 'agy', path: '/Users/m', pid: 18434 }]
          : [
            { paneId: '%33', command: 'codex', path: '/Users/m', pid: 31400, title: 'task A' },
            { paneId: '%41', command: 'codex', path: '/Users/m', pid: 31500, title: 'task B' },
          ])),
      },
      getAncestorPids: vi.fn(async () => [500, 32890, 5487]),
      readCodexThread: vi.fn(async () => ({ id: '01a21b99', cwd: '/Users/m', name: '', title: '' })),
    };

    let caught = null;
    try {
      await resolvePreviewSource(deps, {
        paneId: '%0',
        paneSource: 'env',
        tmuxServerPid: '1873',
        callerPid: 500,
        cwd: '/Users/m',
        codexThreadId: '01a21b99',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 409 });
    expect(caught.message.split('\n')[0]).toMatch(/^preview_source_ambiguous:.*--pane %N/);
    expect(caught.message).toContain('ACTION REQUIRED:');
    expect(caught.message).toContain('%33 | session="工作环境管理" | window="agy" (@10) | idx=3 | cmd=codex');
    expect(caught.message).toContain('%41 | session="工作环境管理" | window="agy" (@10) | idx=4 | cmd=codex');
    expect(caught.message).not.toContain('%0 | session="DataAnt"');
  });

  it('trusts explicit --pane even with stale env/daemon, and rejects invalid explicit --pane with candidates', async () => {
    const tree = {
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{
        id: '$3',
        name: '工作环境管理',
        windows: [{ id: '@10', index: 6, name: 'agy', panes: [{ id: '%33', index: 3, command: 'codex', cwd: '/Users/m', title: 't' }] }],
      }],
    };
    const deps = {
      workspace: { getWorkspace: async () => tree },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async () => [{ paneId: '%33', command: 'codex', path: '/Users/m', pid: 31400, title: 't' }]),
      },
      getAncestorPids: vi.fn(async () => [500, 32890, 5487]),
      readCodexThread: vi.fn(async () => null),
    };

    await expect(resolvePreviewSource(deps, {
      paneId: '%33',
      paneSource: 'arg',
      tmuxServerPid: '1873',
      callerPid: 500,
      cwd: '/Users/m',
      codexThreadId: '01a21b99',
    })).resolves.toEqual({ paneId: '%33', windowId: '@10', instanceId: '18130:1700000000' });

    await expect(resolvePreviewSource(deps, {
      paneId: '%999',
      paneSource: 'arg',
      cwd: '/Users/m',
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/preview_source_invalid_pane:.*%999.*--pane %N[\s\S]*%33 \| session="工作环境管理"/),
    });
  });

  it('does not falsely mark caller detached when pane pid is missing or ancestor lookup returns null', async () => {
    const tree = {
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{ id: '$1', name: 'main', windows: [{ id: '@1', index: 1, name: 'w', panes: [{ id: '%1', index: 1, command: 'fish', cwd: '/w' }] }] }],
    };
    const makeDeps = (pid, ancestors) => ({
      workspace: { getWorkspace: async () => tree },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async () => [{ paneId: '%1', command: 'fish', path: '/w', pid }]),
      },
      getAncestorPids: vi.fn(async () => ancestors),
      readCodexThread: vi.fn(async () => null),
    });

    await expect(resolvePreviewSource(makeDeps(0, [500, 32890]), {
      paneId: '%1', paneSource: 'env', tmuxServerPid: '18130', callerPid: 500, cwd: '/w',
    })).resolves.toEqual({ paneId: '%1', windowId: '@1', instanceId: '18130:1700000000' });

    await expect(resolvePreviewSource(makeDeps(100, null), {
      paneId: '%1', paneSource: 'env', tmuxServerPid: '18130', callerPid: 500, cwd: '/w',
    })).resolves.toEqual({ paneId: '%1', windowId: '@1', instanceId: '18130:1700000000' });
  });

  it('does not access undeclared properties on a Cordis-like ctx proxy', async () => {
    const tree = {
      instanceId: '18130:1700000000',
      complete: true,
      sessions: [{ id: '$1', name: 'main', windows: [{ id: '@1', index: 1, name: 'w', panes: [{ id: '%1', index: 1, command: 'fish', cwd: '/w' }] }] }],
    };
    const rawCtx = {
      workspace: { getWorkspace: async () => tree },
      tmux: {
        getServerInstance: vi.fn(async () => '18130:1700000000'),
        listPaneCommands: vi.fn(async () => [{ paneId: '%1', command: 'fish', path: '/w', pid: 0 }]),
      },
    };
    const cordisProxy = new Proxy(rawCtx, {
      get(target, prop) {
        if (prop === 'workspace' || prop === 'tmux') return target[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });

    await expect(resolvePreviewSource(cordisProxy, {
      paneId: '%999',
      paneSource: 'arg',
      cwd: '/w',
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('preview_source_invalid_pane') });
  });
});
