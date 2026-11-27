import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG_IDS,
  canonicalAgentType,
  exactAgentResumeCommand,
  restoreCommand,
} from '../../lib/session-protection/catalog.js';

describe('25+ Agent CLI resume catalog (Orca MIT port)', () => {
  it('supports at least 25 distinct canonical coding agents', () => {
    expect(AGENT_CATALOG_IDS.length).toBeGreaterThanOrEqual(25);
  });

  it('maps aliases and produces exact session resume and fallback commands without injection', () => {
    const cases = [
      ['claude', 'sess-1', 'claude --resume sess-1', 'claude --continue'],
      ['codex', 'thr-1', 'codex resume thr-1', 'codex resume --last'],
      ['antigravity-cli', 'conv-1', 'agy --conversation conv-1', 'agy --continue'],
      ['opencode', 'oc-1', 'opencode --session oc-1', 'opencode --continue'],
      ['cursor-agent', 'cur-1', 'cursor-agent --resume cur-1', 'cursor-agent --continue'],
      ['qodercli', 'qd-1', 'qodercli --resume qd-1', 'qodercli --continue'],
      ['qwen', 'qw-1', 'qwen --resume qw-1', 'qwen --continue'],
      ['kimi', 'km-1', 'kimi --session km-1', 'kimi --continue'],
      ['kiro-cli', 'kr-1', 'kiro-cli chat --resume', 'kiro-cli chat --resume'],
      ['aider', 'ad-1', 'aider --restore-chat-history', 'aider --restore-chat-history'],
      ['goose', 'gs-1', 'goose session --resume --name gs-1', 'goose session --resume'],
      ['amp', 'T-123', 'amp threads continue T-123', 'amp threads continue --last'],
      ['cline', 'cl-1', 'cline -r cl-1', 'cline -c'],
      ['cn', 'cn-1', 'cn --resume cn-1', 'cn --continue'],
      ['droid', 'dr-1', 'droid -r dr-1', 'droid -c'],
      ['hermes', 'hm-1', 'hermes --resume hm-1', 'hermes --continue'],
      ['devin', 'dv-1', 'devin --resume dv-1', 'devin --continue'],
      ['codebuddy', 'cb-1', 'codebuddy --resume cb-1', 'codebuddy --continue'],
      ['jcode', 'jc-1', 'jcode --resume jc-1', 'jcode --continue'],
      ['crush', 'cr-1', 'crush --session cr-1', 'crush --continue'],
      ['auggie', 'ag-1', 'auggie --resume ag-1', 'auggie --continue'],
      ['rovodev', 'rv-1', 'acli rovodev run --restore', 'acli rovodev run --restore'],
      ['zcode', 'zc-1', 'zcode --resume zc-1', 'zcode --continue'],
    ];

    for (const [alias, sid, expectedExact, expectedFallback] of cases) {
      const canonical = canonicalAgentType(alias);
      expect(canonical).toBeTruthy();
      expect(exactAgentResumeCommand({ type: alias, sessionId: sid })).toBe(expectedExact);
      expect(exactAgentResumeCommand({ type: alias, sessionId: '' })).toBe(expectedFallback);
      expect(exactAgentResumeCommand({ type: alias, sessionId: 'bad; rm -rf /' }, { allowFallback: false })).toBeNull();
    }

    expect(restoreCommand({ command: 'opencode', fullCommand: 'opencode' }, ['ai'], 'zsh')).toBe('opencode --continue');
    expect(restoreCommand({ command: 'aider', fullCommand: 'aider' }, ['other'], 'zsh')).toBeNull();
  });
});
