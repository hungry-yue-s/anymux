// Interactive tool detection & approval/question payload normalization.
// Ported from stablyai/orca (MIT).

const INTERACTIVE_TOOLS = new Set([
  'askuserquestion',
  'ask_user_question',
  'request_user_input',
  'exitplanmode',
  'exit_plan_mode',
  'enterplanmode',
  'enter_plan_mode',
  'plan_mode',
]);

export function canonicalToolName(toolName) {
  return String(toolName || '').trim();
}

export function isInteractiveToolName(toolName) {
  const normalized = canonicalToolName(toolName).toLowerCase();
  if (!normalized) return false;
  if (INTERACTIVE_TOOLS.has(normalized)) return true;
  return normalized.includes('askuserquestion') || normalized.includes('request_user_input');
}

export function isAskUserQuestionTool(toolName) {
  const normalized = canonicalToolName(toolName).toLowerCase();
  return normalized === 'askuserquestion' || normalized === 'ask_user_question' || normalized === 'request_user_input';
}

export function summarizeApprovalInput(toolInput) {
  if (toolInput && typeof toolInput === 'object') {
    const direct = toolInput.command ?? toolInput.file_path ?? toolInput.path ?? toolInput.url ?? toolInput.pattern;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct.length > 200 ? `${direct.slice(0, 200)}…` : direct;
    }
  }
  if (typeof toolInput === 'string' && toolInput.length > 0) {
    return toolInput.length > 200 ? `${toolInput.slice(0, 200)}…` : toolInput;
  }
  try {
    const json = JSON.stringify(toolInput) ?? '';
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '';
  }
}

export function deriveInteractivePrompt(toolName, toolInput, eventName = '') {
  const normalizedEvent = String(eventName || '').toLowerCase();
  const isPostTool = normalizedEvent === 'posttooluse'
    || normalizedEvent === 'post_tool_use'
    || normalizedEvent === 'posttoolusefailure'
    || normalizedEvent === 'post_tool_use_failure'
    || normalizedEvent === 'aftertool';
  if (isInteractiveToolName(toolName) && !isPostTool && toolInput !== undefined && toolInput !== null) {
    if (isAskUserQuestionTool(toolName)) {
      try {
        return typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      } catch {
        return undefined;
      }
    }
    return JSON.stringify({
      interactive: { tool: canonicalToolName(toolName), summary: summarizeApprovalInput(toolInput) },
    });
  }
  if ((normalizedEvent === 'permissionrequest' || normalizedEvent === 'permission_wait') && toolName) {
    return JSON.stringify({
      approval: { tool: canonicalToolName(toolName), summary: summarizeApprovalInput(toolInput) },
    });
  }
  return undefined;
}

export function extractToolResponseText(toolResponse) {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return undefined;
  for (const key of ['text_result_for_llm', 'textResultForLlm', 'text', 'message']) {
    const val = toolResponse[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  if (Array.isArray(toolResponse.content)) {
    for (const part of toolResponse.content) {
      if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return undefined;
}

export function extractQuestionTitle(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (Array.isArray(toolInput.questions) && toolInput.questions[0]) {
    const q = toolInput.questions[0];
    if (typeof q.question === 'string' && q.question.trim()) return q.question.trim();
    if (typeof q.header === 'string' && q.header.trim()) return q.header.trim();
  }
  if (typeof toolInput.question === 'string' && toolInput.question.trim()) return toolInput.question.trim();
  if (typeof toolInput.prompt === 'string' && toolInput.prompt.trim()) return toolInput.prompt.trim();
  return '';
}
