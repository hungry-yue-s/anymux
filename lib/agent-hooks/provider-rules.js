// Provider-specific hook event normalization & subagent noise filtering.
// Ported from stablyai/orca (MIT).

import {
  deriveInteractivePrompt,
  extractQuestionTitle,
  extractToolResponseText,
  isInteractiveToolName,
  summarizeApprovalInput,
} from './interactive-tool.js';

const CURSOR_EVENT_MAP = Object.freeze({
  beforesubmiteditprompt: 'UserPromptSubmit',
  beforesubmittedprompt: 'UserPromptSubmit',
  beforepromptsubmit: 'UserPromptSubmit',
  beforeshellexecution: 'PreToolUse',
  aftershellexecution: 'PostToolUse',
  beforemcpexecution: 'PreToolUse',
  aftermcpexecution: 'PostToolUse',
  beforereadfile: 'PreToolUse',
  afterfileedit: 'PostToolUse',
  afteragentthought: 'agent_running',
  afteragentresponse: 'agent_stop',
  stop: 'Stop',
  sessionstart: 'SessionStart',
  sessionend: 'SessionEnd',
  subagentstart: 'SubagentStart',
  subagentstop: 'SubagentStop',
});

export function shouldIgnoreHookPayload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  // Subagent Stop/PostTool from sidechain transcripts must not retire parent agent status;
  // explicit SubagentStart/SubagentStop track child counts separately.
  if (raw.isSidechain === true || raw.is_sidechain === true) return true;
  if (String(raw.agent_role || raw.agentRole || '').toLowerCase() === 'sidechain') return true;
  return false;
}

export function normalizeProviderHookInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return rawInput;
  const raw = { ...rawInput };
  const agentHint = String(raw.agent || raw.source || raw.cli || '').toLowerCase();
  const rawEvent = String(raw.event || raw.hook_event_name || raw.hookEventName || raw.type || '').trim();
  const lowerEvent = rawEvent.toLowerCase();

  // Map provider-specific event aliases (e.g. Cursor) when event isn't already canonical.
  if (agentHint.includes('cursor') || raw.cursor_version || raw.conversation_id && raw.workspace_roots) {
    const mapped = CURSOR_EVENT_MAP[lowerEvent];
    if (mapped) {
      raw.event = mapped;
    }
    if (!raw.agent && !raw.source) raw.agent = 'cursor';
    if (!raw.cwd && Array.isArray(raw.workspace_roots) && typeof raw.workspace_roots[0] === 'string') {
      raw.cwd = raw.workspace_roots[0];
    }
  }

  // Claude / Codex / Antigravity / DSH structured tool fields
  const toolName = raw.tool_name || raw.toolName || raw.toolCall?.name || raw.name || '';
  const toolInput = raw.tool_input ?? raw.toolInput ?? raw.toolCall?.input ?? raw.input;
  const eventForTool = raw.event || raw.hook_event_name || raw.hookEventName || '';

  // Promote interactive approval/question pre-tool calls so UI surfaces "Needs You" promptly.
  const isPreTool = /^(pretooluse|pre_tool_use|beforetool)$/i.test(String(eventForTool));
  if (isPreTool && isInteractiveToolName(toolName)) {
    raw.event = 'waiting_attention';
    const qTitle = extractQuestionTitle(toolInput);
    if (qTitle && !raw.reason) raw.reason = qTitle;
  }

  const interactivePrompt = deriveInteractivePrompt(toolName, toolInput, eventForTool);
  if (interactivePrompt && !raw.interactivePrompt) {
    raw.interactivePrompt = interactivePrompt;
  }

  if (!raw.reason && (lowerEvent === 'permissionrequest' || lowerEvent === 'permission_wait') && toolName) {
    const summary = summarizeApprovalInput(toolInput);
    raw.reason = summary ? `${toolName}: ${summary}` : String(toolName);
  }

  if (!raw.lastMessage && !raw.last_assistant_message) {
    const respText = extractToolResponseText(raw.tool_response ?? raw.toolResponse);
    if (respText && raw.is_error) {
      raw.error = raw.error || respText;
    }
  }

  return raw;
}
