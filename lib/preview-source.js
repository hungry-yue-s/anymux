import { pathSpace } from './agent-docs/project.js';

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

/** Validate CLI provenance; a cwd can identify a window, never a particular pane. */
export async function resolvePreviewSource({ workspace, tmux }, { paneId, cwd }) {
  const tree = await workspace.getWorkspace();
  if (!tree.instanceId) fail('preview_source_unavailable: tmux workspace unavailable', 503);
  const windows = (tree.sessions || []).flatMap(session => session.windows || []);
  const known = paneId && windows.find(win => (win.panes || []).some(pane => pane.id === paneId));
  if (known) return { paneId, windowId: known.id, instanceId: tree.instanceId };

  if (tree.complete === false) fail('preview_source_unavailable: incomplete tmux workspace; retry', 503);
  const normalized = typeof cwd === 'string' && cwd.length <= 4096 && !/[\x00-\x1f\x7f]/.test(cwd)
    ? pathSpace.toApi(cwd) : '';
  if (!normalized.startsWith('/')) fail('preview_source_unavailable: pass --pane %N or run from a tmux pane');
  const key = pathSpace.key(pathSpace.resolve(normalized));
  const commands = (await Promise.all(tree.sessions.map(session => tmux.listPaneCommands(session.id)))).flat();
  if (await tmux.getServerInstance() !== tree.instanceId) fail('preview_source_changed: tmux restarted; retry');
  const matches = windows.filter(win => (win.panes || []).some(pane => commands.some(command =>
    command.paneId === pane.id && command.path && pathSpace.key(pathSpace.resolve(pathSpace.toApi(command.path))) === key)));
  const ids = new Set(matches.map(win => win.id));
  if (ids.size > 1) fail('preview_source_ambiguous: cwd matches multiple windows; pass --pane %N');
  if (!ids.size) fail('preview_source_unavailable: no live pane matches cwd; pass --pane %N');
  return { paneId: null, windowId: matches[0].id, instanceId: tree.instanceId };
}
