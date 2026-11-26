(function (global) {
  'use strict';

  var STATUS_PRIORITY = {
    permission: 7,
    failed: 6,
    working: 5,
    monitoring: 4,
    unconfirmed: 3,
    interrupted: 2,
    done: 1,
    idle: 0,
  };

  var SHELL_COMMANDS = new Set([
    'zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'nushell', 'pwsh', 'powershell', 'cmd', 'login',
  ]);

  var AGENT_ALIASES = {
    claude: 'claude',
    'claude-code': 'claude',
    claudecode: 'claude',
    'claude-agent-teams': 'claude-agent-teams',
    openclaude: 'openclaude',
    codex: 'codex',
    'codex-cli': 'codex',
    'openai-codex': 'codex',
    grok: 'grok',
    copilot: 'copilot',
    'gh-copilot': 'copilot',
    'github-copilot': 'copilot',
    opencode: 'opencode',
    'open-code': 'opencode',
    opencode2: 'opencode2',
    mimo: 'mimo-code',
    'mimo-code': 'mimo-code',
    ante: 'ante',
    trae: 'trae',
    traecli: 'trae',
    'trae-cli': 'trae',
    muse: 'muse',
    dsh: 'dsh',
    'dsh-tui': 'dsh',
    dst: 'dsh',
    dsb: 'dsh',
    deepseek: 'dsh',
    'deepseek-harness': 'dsh',
    qoder: 'qoder',
    qodercli: 'qoder',
    'qoder-cn': 'qoder-cn',
    qoderclicn: 'qoder-cn',
    qodercn: 'qoder-cn',
    zcode: 'zcode',
    'zcode-cli': 'zcode',
    pi: 'pi',
    omp: 'omp',
    'oh-my-pi': 'omp',
    'prime-agent': 'prime-agent',
    gemini: 'gemini',
    'gemini-cli': 'gemini',
    antigravity: 'antigravity',
    agy: 'antigravity',
    'antigravity-cli': 'antigravity',
    aider: 'aider',
    goose: 'goose',
    amp: 'amp',
    kilo: 'kilo',
    kilocode: 'kilo',
    kiro: 'kiro',
    'kiro-cli': 'kiro',
    crush: 'crush',
    charm: 'crush',
    aug: 'aug',
    auggie: 'aug',
    autohand: 'autohand',
    'autohand-code': 'autohand',
    cline: 'cline',
    codebuff: 'codebuff',
    freebuff: 'freebuff',
    'command-code': 'command-code',
    continue: 'continue',
    cn: 'continue',
    'continue-cli': 'continue',
    cursor: 'cursor',
    'cursor-agent': 'cursor',
    droid: 'droid',
    factory: 'droid',
    'factory-droid': 'droid',
    kimi: 'kimi',
    'kimi-code': 'kimi',
    'kimi-cli': 'kimi',
    'mistral-vibe': 'mistral-vibe',
    vibe: 'mistral-vibe',
    qwen: 'qwen-code',
    'qwen-code': 'qwen-code',
    rovo: 'rovo',
    rovodev: 'rovo',
    'rovo-dev': 'rovo',
    hermes: 'hermes',
    devin: 'devin',
    openclaw: 'openclaw',
    codebuddy: 'codebuddy',
    cbc: 'codebuddy',
    jcode: 'jcode',
    roo: 'roo',
    roocode: 'roo',
    windsurf: 'windsurf',
  };

  var TOOL_MAP = {
    vim: 'editor', nvim: 'editor', vi: 'editor', nano: 'editor', hx: 'editor', helix: 'editor', emacs: 'editor', micro: 'editor',
    ssh: 'ssh', mosh: 'ssh', scp: 'ssh', sftp: 'ssh',
    python: 'python', python3: 'python', python2: 'python', ipython: 'python', uv: 'python', pytest: 'python', pip: 'python', pip3: 'python', poetry: 'python',
    node: 'node', bun: 'node', deno: 'node', tsx: 'node', 'ts-node': 'node', npm: 'node', pnpm: 'node', yarn: 'node', npx: 'node',
    git: 'git', lazygit: 'git', tig: 'git', gh: 'git', gitui: 'git',
    docker: 'container', kubectl: 'container', k9s: 'container', podman: 'container', helm: 'container', compose: 'container',
    htop: 'monitor', btop: 'monitor', top: 'monitor', btm: 'monitor', glances: 'monitor', nvitop: 'monitor',
    cargo: 'rust', rustc: 'rust', rustup: 'rust',
    go: 'go', dlv: 'go',
    make: 'build', cmake: 'build', just: 'build', ninja: 'build', bazel: 'build',
    curl: 'network', wget: 'network', http: 'network', xh: 'network', nc: 'network', socat: 'network',
    psql: 'db', mysql: 'db', sqlite3: 'db', 'redis-cli': 'db', mongosh: 'db',
  };

  var AGENT_LABELS = {
    claude: 'Claude',
    'claude-agent-teams': 'Claude Agent Teams',
    openclaude: 'OpenClaude',
    codex: 'Codex',
    grok: 'Grok',
    copilot: 'GitHub Copilot',
    opencode: 'OpenCode',
    opencode2: 'OpenCode 2',
    'mimo-code': 'MiMo Code',
    ante: 'Ante',
    trae: 'Trae',
    muse: 'Muse',
    dsh: 'DeepSeek Harness',
    qoder: 'Qoder CLI',
    'qoder-cn': 'Qoder CLI China',
    zcode: 'ZCode',
    pi: 'Pi',
    omp: 'OMP',
    'prime-agent': 'Prime Agent',
    gemini: 'Gemini',
    antigravity: 'Antigravity',
    aider: 'Aider',
    goose: 'Goose',
    amp: 'Amp',
    kilo: 'Kilocode',
    kiro: 'Kiro',
    crush: 'Charm',
    aug: 'Auggie',
    autohand: 'Autohand Code',
    cline: 'Cline',
    codebuff: 'Codebuff',
    freebuff: 'Freebuff',
    'command-code': 'Command Code',
    continue: 'Continue',
    cursor: 'Cursor',
    droid: 'Droid',
    kimi: 'Kimi',
    'mistral-vibe': 'Mistral Vibe',
    'qwen-code': 'Qwen Code',
    rovo: 'Rovo Dev',
    hermes: 'Hermes',
    devin: 'Devin',
    openclaw: 'OpenClaw',
    codebuddy: 'CodeBuddy',
    jcode: 'Jcode',
    roo: 'Roo Code',
    windsurf: 'Windsurf',
    editor: '编辑器',
    ssh: 'SSH 远程',
    python: 'Python',
    node: 'Node.js',
    git: 'Git',
    container: '容器',
    monitor: '监控',
    rust: 'Rust',
    go: 'Go',
    build: '构建',
    network: '网络',
    db: '数据库',
    shell: '终端',
  };

  var SPINNER_RE = /[\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◴◵◶◷⣾⣽⣻⢿⡿⣟⣯⣷✳✶✻✽✦✧✺✹✸✷✵✴]/u;
  var ATTENTION_RE = /[⏸⚠❓✋🔔🔐]/u;
  var DONE_RE = /[✓✔✅]/u;
  var FAILED_RE = /[✗✘❌⨯]/u;
  var INTERRUPTED_RE = /[⏹⊘]/u;
  var LEADING_DECORATION_RE = /^[\s\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◴◵◶◷⣾⣽⣻⢿⡿⣟⣯⣷✳✶✻✽✦✧✺✹✸✷✵✴⏸⚠❓✋🔔🔐✓✔✅✗✘❌⨯⏹⊘·•›>\-|:]+/u;

  var _svgUid = 0;

  var TITLE_AGENT_PATTERNS = [
    { agent: 'claude-agent-teams', re: /\bclaude\s+agent\s+teams\b/i },
    { agent: 'openclaude', re: /\bopenclaude\b/i },
    { agent: 'claude', re: /\bclaude(?:\s+code)?\b/i },
    { agent: 'codex', re: /\bcodex\b/i },
    { agent: 'antigravity', re: /\b(?:antigravity|agy)\b/i },
    { agent: 'dsh', re: /\b(?:dsh(?:-tui)?|deepseek\s+harness)\b/i },
    { agent: 'qoder-cn', re: /\b(?:qoderclicn|qoder-cn)\b/i },
    { agent: 'qoder', re: /\bqoder(?:cli)?\b/i },
    { agent: 'gemini', re: /\bgemini(?:\s+cli)?\b/i },
    { agent: 'opencode2', re: /\bopencode2\b/i },
    { agent: 'opencode', re: /\bopencode\b/i },
    { agent: 'grok', re: /\bgrok\b/i },
    { agent: 'kimi', re: /\bkimi(?:\s+code)?\b/i },
    { agent: 'qwen-code', re: /\bqwen(?:-code|\s+code)?\b/i },
    { agent: 'trae', re: /\btrae(?:cli)?\b/i },
    { agent: 'cursor', re: /\bcursor(?:\s+agent)?\b/i },
    { agent: 'aider', re: /\baider\b/i },
    { agent: 'goose', re: /\bgoose\b/i },
    { agent: 'amp', re: /\bamp\b/i },
    { agent: 'kilo', re: /\bkilo(?:code)?\b/i },
    { agent: 'kiro', re: /\bkiro(?:-cli)?\b/i },
    { agent: 'droid', re: /\bdroid\b/i },
    { agent: 'copilot', re: /\bcopilot\b/i },
    { agent: 'cline', re: /\bcline\b/i },
    { agent: 'devin', re: /\bdevin\b/i },
    { agent: 'hermes', re: /\bhermes\b/i },
    { agent: 'openclaw', re: /\bopenclaw\b/i },
    { agent: 'codebuddy', re: /\bcodebuddy\b/i },
    { agent: 'zcode', re: /\bzcode\b/i },
    { agent: 'autohand', re: /\bautohand\b/i },
    { agent: 'codebuff', re: /\bcodebuff\b/i },
    { agent: 'freebuff', re: /\bfreebuff\b/i },
    { agent: 'crush', re: /\bcrush\b/i },
    { agent: 'aug', re: /\bauggie\b/i },
    { agent: 'rovo', re: /\brovo(?:\s+dev|dev)?\b/i },
    { agent: 'mimo-code', re: /\bmimo(?:-code|\s+code)\b/i },
    { agent: 'prime-agent', re: /\bprime-agent\b/i },
    { agent: 'jcode', re: /\bjcode\b/i },
  ];

  function escAttr(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function commandBasename(cmd) {
    if (!cmd) return '';
    var token = String(cmd).trim().split(/\s+/)[0] || '';
    var base = token.split(/[\\/]+/).filter(Boolean).pop() || '';
    return base.replace(/^-+/, '').replace(/\.exe$/i, '').toLowerCase();
  }

  function normalizeAgentType(name) {
    if (!name || typeof name !== 'string') return '';
    var clean = name.trim().toLowerCase().replace(/[_\s]+/g, '-');
    return AGENT_ALIASES[clean] || '';
  }

  function isAgentKind(kind) {
    return Boolean(kind && AGENT_ALIASES[kind]);
  }

  function resolveKind(command, agentType) {
    var normAgent = normalizeAgentType(agentType);
    if (normAgent) return normAgent;
    var base = commandBasename(command);
    if (!base || SHELL_COMMANDS.has(base)) return 'shell';
    if (AGENT_ALIASES[base]) return AGENT_ALIASES[base];
    return TOOL_MAP[base] || base;
  }

  // Fallback SVG geometry table when AgentIconLibrary is absent or for dev tools
  var SVG_BODIES = {
    // Minimal fallbacks for core AI agents
    claude: '<path d="M12 2.5v4.2M12 17.3v4.2M4.9 4.9l3 3M16.1 16.1l3 3M2.5 12h4.2M17.3 12h4.2M4.9 19.1l3-3M16.1 7.9l3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/>',
    codex: '<circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 4.5v5.2l4.5 2.6M19.5 12l-4.5-2.6-4.5 2.6M12 19.5v-5.2l-4.5-2.6M4.5 12l4.5 2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    qoder: '<polygon points="12,3 19.8,7.5 19.8,16.5 12,21 4.2,16.5 4.2,7.5" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M14.2 14.2 17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    gemini: '<path d="M12 2.5c1 5.1 4.4 8.5 9.5 9.5-5.1 1-8.5 4.4-9.5 9.5-1-5.1-4.4-8.5-9.5-9.5 5.1-1 8.5-4.4 9.5-9.5Z" stroke="currentColor" stroke-width="1.6" fill="currentColor" fill-opacity="0.18" stroke-linejoin="round"/>',
    opencode: '<rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M9 8.5 6.5 12 9 15.5M15 8.5 17.5 12 15 15.5M12.8 8l-1.6 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    cursor: '<path d="M5 4.5 19.5 11.2 12.6 13.4 9.8 19.8Z" stroke="currentColor" stroke-width="1.7" fill="currentColor" fill-opacity="0.2" stroke-linejoin="round"/>',
    aider: '<circle cx="8" cy="12" r="3.2" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="16" cy="12" r="3.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M11.2 12h1.6M8 6.2V8.8M16 15.2v2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    goose: '<path d="M5 17.5c2-4.2 5.2-6 9.5-6.5l3-4.5 2.5 1-2.5 4.5c.8 2.2-.2 5-3.2 5.5H5Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><circle cx="16.4" cy="9.4" r="1" fill="currentColor"/>',
    amp: '<path d="M13.5 2.5 5.5 13h5.8l-.8 8.5 8-10.5h-5.8Z" stroke="currentColor" stroke-width="1.6" fill="currentColor" fill-opacity="0.18" stroke-linejoin="round"/>',
    kiro: '<path d="M6 19V11a6 6 0 0 1 12 0v8l-3-2-3 2-3-2-3 2Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><circle cx="9.8" cy="11.2" r="1.1" fill="currentColor"/><circle cx="14.2" cy="11.2" r="1.1" fill="currentColor"/>',
    droid: '<rect x="5" y="7" width="14" height="11" rx="4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8.5 12h7M9 4.5l1.5 2.5M15 4.5 13.5 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    copilot: '<path d="M4.5 13.5c0-3.5 3.3-6 7.5-6s7.5 2.5 7.5 6v2.2a2 2 0 0 1-2 2h-3l-2.5-1.7-2.5 1.7h-3a2 2 0 0 1-2-2v-2.2Z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8.5 13h2.2M13.3 13h2.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    cline: '<rect x="4.5" y="5" width="15" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8 9.5h8M8 13h5M8 16h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    roo: '<circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8.5 10.5c1-2 6-2 7 0M9 14.5l3 2.2 3-2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    windsurf: '<path d="M4 16c3-6.5 6.5-9.5 11.5-9.5-2.2 2.8-2.8 5.2-1.8 7.5 2.2-.8 4.2-.5 6.3 1.2-4.2 1.2-8.2 1.6-16 .8Z" stroke="currentColor" stroke-width="1.6" fill="currentColor" fill-opacity="0.16" stroke-linejoin="round"/>',
    devin: '<path d="M7 5.5h5.5a6.5 6.5 0 0 1 0 13H7V5.5Z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/><path d="M10.5 9.5 13 12l-2.5 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    // Dev tools & shell
    shell: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 14.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    editor: '<path d="M14.5 4.5 19.5 9.5 9 20H4v-5L14.5 4.5Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M12.5 6.5 17.5 11.5" stroke="currentColor" stroke-width="1.6"/>',
    ssh: '<rect x="3.5" y="5" width="17" height="5.5" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="3.5" y="13.5" width="17" height="5.5" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="7" cy="7.8" r="1" fill="currentColor"/><circle cx="7" cy="16.2" r="1" fill="currentColor"/>',
    python: '<path d="M12 4c-3.3 0-3.5 1.5-3.5 3.2V9h4v1H6.8C4.8 10 4 11.3 4 13.5S4.8 17 6.8 17H8.5v-1.8c0-1.6 1.2-2.7 3-2.7h4c1.5 0 2.5-1 2.5-2.5V7.2C18 5.2 16 4 12 4Z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="10" cy="6.6" r=".8" fill="currentColor"/>',
    node: '<polygon points="12,3.2 19.5,7.6 19.5,16.4 12,20.8 4.5,16.4 4.5,7.6" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>',
    git: '<circle cx="7" cy="6.5" r="2.2" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="7" cy="17.5" r="2.2" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="17" cy="9.5" r="2.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M7 8.7v6.6M9.2 7.5c4.5 0 5.6 1 7.8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    container: '<rect x="4" y="9" width="16" height="9.5" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8.5 9V5.5h7V9M9 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    monitor: '<path d="M3.5 12h3.8l2.2-5 4 10 2.2-5h4.8" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    rust: '<circle cx="12" cy="12" r="6.8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    go: '<path d="M5 9.5h7.5M4 12.5h9.5M6.5 15.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16.5" cy="12.5" r="3.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    build: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4.5 15.5l2 2 5-5a4 4 0 0 0 5-5l-2.2 2.2-1.8-1.8L14.5 5.5Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
    network: '<circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.6" fill="none"/><ellipse cx="12" cy="12" rx="3.5" ry="7.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M4.8 12h14.4" stroke="currentColor" stroke-width="1.4"/>',
    db: '<ellipse cx="12" cy="6.8" rx="6.5" ry="2.6" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5.5 6.8v10.4c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V6.8M5.5 12c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  };

  function appIcon(kind) {
    var raw = String(kind || 'shell').trim().toLowerCase().replace(/[_\s]+/g, '-');
    var clean = AGENT_ALIASES[raw] || raw;
    var agentCls = isAgentKind(clean) ? ' is-agent' : '';
    var lib = global.AgentIconLibrary;
    if (lib && lib.svg && lib.svg[clean]) {
      var spec = lib.svg[clean];
      var svgBody = spec.body;
      if (svgBody.indexOf('{{UID}}') >= 0) {
        svgBody = svgBody.replace(/\{\{UID\}\}/g, String(++_svgUid));
      }
      return '<span class="agent-app-icon is-kind-' + escAttr(clean) + agentCls + '" aria-hidden="true">'
        + '<svg viewBox="' + escAttr(spec.viewBox || '0 0 24 24') + '" fill="none" aria-hidden="true" focusable="false">' + svgBody + '</svg>'
        + '</span>';
    }
    if (lib && lib.img && lib.img[clean]) {
      return '<span class="agent-app-icon is-kind-' + escAttr(clean) + ' is-img' + agentCls + '" aria-hidden="true">'
        + '<img class="agent-app-img" src="' + escAttr(lib.img[clean]) + '" alt="" aria-hidden="true" draggable="false"/>'
        + '</span>';
    }
    var body = SVG_BODIES[clean];
    if (body) {
      return '<span class="agent-app-icon is-kind-' + escAttr(clean) + agentCls + '" aria-hidden="true">'
        + '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">' + body + '</svg>'
        + '</span>';
    }
    var letter = (clean.charAt(0) || '?').toUpperCase();
    return '<span class="agent-app-icon is-letter' + agentCls + '" data-letter="' + escAttr(letter) + '" aria-hidden="true"></span>';
  }

  function statusIcon(status, unread) {
    if (!status || status === 'idle' || status === 'session_ended') return '';
    if (status === 'working') {
      return '<span class="agent-state-ico is-working" aria-hidden="true" title="Agent 正在执行">'
        + '<svg class="agent-spinner" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="22 14"/></svg>'
        + '</span>';
    }
    if (status === 'permission' || status === 'waiting') {
      return '<span class="agent-state-ico is-permission" aria-hidden="true" title="等待确认">'
        + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<circle cx="8" cy="8" r="6" fill="currentColor" fill-opacity="0.22"/>'
        + '<path d="M8 4.4v4M8 10.9h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>'
        + '</span>';
    }
    if (status === 'failed') {
      return '<span class="agent-state-ico is-failed" aria-hidden="true" title="异常失败">'
        + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<circle cx="8" cy="8" r="6" fill="currentColor" fill-opacity="0.22"/>'
        + '<path d="M5.7 5.7 10.3 10.3M10.3 5.7 5.7 10.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
        + '</span>';
    }
    if (status === 'monitoring' || status === 'unconfirmed') {
      return '<span class="agent-state-ico is-monitoring" aria-hidden="true" title="后台监控">'
        + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<circle cx="8" cy="8" r="3.4" fill="currentColor"/></svg>'
        + '</span>';
    }
    if (status === 'interrupted') {
      return '<span class="agent-state-ico is-interrupted" aria-hidden="true" title="已中断">'
        + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/>'
        + '<rect x="5.8" y="5.8" width="4.4" height="4.4" rx="0.8" fill="currentColor"/></svg>'
        + '</span>';
    }
    if (status === 'done') {
      var cls = 'agent-state-ico is-done' + (unread ? ' is-unread' : '');
      return '<span class="' + cls + '" aria-hidden="true" title="已完成">'
        + '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">'
        + '<circle cx="8" cy="8" r="5.5" fill="currentColor" fill-opacity="' + (unread ? '0.24' : '0.12') + '" stroke="currentColor" stroke-width="1.35"/>'
        + '<path d="m5.5 8.1 1.7 1.7 3.4-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '</span>';
    }
    return '';
  }

  function labelOf(kind) {
    return AGENT_LABELS[String(kind || '').toLowerCase()] || String(kind || '终端');
  }

  function formatShortModel(model) {
    if (!model || typeof model !== 'string') return '';
    var clean = model.trim();
    if (!clean) return '';
    var slash = clean.lastIndexOf('/');
    if (slash >= 0 && slash < clean.length - 1) clean = clean.slice(slash + 1);
    clean = clean.replace(/-(?:20\d{6}|latest)$/i, '');
    var cNew = clean.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-(.+))?$/i);
    if (cNew) return cNew[1].toLowerCase() + '-' + (cNew[3] ? cNew[2] + '.' + cNew[3] : cNew[2]);
    var cOld = clean.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/i);
    if (cOld) return cOld[3].toLowerCase() + '-' + (cOld[2] ? cOld[1] + '.' + cOld[2] : cOld[1]);
    var gpt = clean.match(/^(gpt-\d+(?:\.\d+)?)(?:-codex.*)?$/i);
    if (gpt) return gpt[1].toLowerCase();
    var gem = clean.match(/^(gemini-\d+(?:\.\d+)?)/i);
    if (gem) return gem[1].toLowerCase();
    return clean.length > 18 ? clean.slice(0, 18) : clean;
  }

  function formatRelativeTime(ts, now) {
    var t = Number(ts || 0);
    if (!t || !Number.isFinite(t)) return '';
    var ref = Number.isFinite(now) ? now : Date.now();
    var diffSec = Math.max(0, Math.floor((ref - t) / 1000));
    if (diffSec < 45) return 'now';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h';
    return Math.floor(diffSec / 86400) + 'd';
  }

  function detectFromPane(pane) {
    if (!pane) return null;
    var command = pane.command || '';
    var title = String(pane.title || '').trim();
    var kind = resolveKind(command, pane.agentType);
    var agentType = isAgentKind(kind) ? kind : '';
    var status = null;
    if (title) {
      if (!agentType) {
        for (var i = 0; i < TITLE_AGENT_PATTERNS.length; i += 1) {
          if (TITLE_AGENT_PATTERNS[i].re.test(title)) {
            agentType = TITLE_AGENT_PATTERNS[i].agent;
            break;
          }
        }
      }
      if (ATTENTION_RE.test(title)) status = 'permission';
      else if (FAILED_RE.test(title)) status = 'failed';
      else if (SPINNER_RE.test(title)) status = 'working';
      else if (INTERRUPTED_RE.test(title)) status = 'interrupted';
      else if (DONE_RE.test(title)) status = 'done';
    }
    var finalKind = agentType || kind;
    return {
      paneId: pane.id || '',
      agentType: agentType,
      appKind: finalKind,
      status: status || (agentType ? 'idle' : null),
      label: title ? title.replace(LEADING_DECORATION_RE, '').trim() : (pane.label || command || ''),
      shortModel: formatShortModel(pane.model || ''),
      prompt: '',
      subagentCount: 0,
      unread: status === 'done' || status === 'permission' || status === 'failed',
      updatedAt: 0,
      command: command,
    };
  }

  var _byServer = Object.create(null);
  var _tickTimer = null;

  function _notifyUi(emitEvent) {
    if (emitEvent && typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      try { global.dispatchEvent(new global.CustomEvent('agent-status-changed')); } catch (_) {}
    }
    if (global.AppShell && typeof global.AppShell.render === 'function') {
      global.AppShell.render();
    }
  }

  var AgentStatus = {
    _rank: function (status) {
      return STATUS_PRIORITY[status] || 0;
    },

    setSnapshot: function (serverId, snapshot) {
      var sid = serverId || 'local';
      var next = snapshot && typeof snapshot === 'object'
        ? {
            hasAgents: Boolean(snapshot.hasAgents),
            updatedAt: snapshot.updatedAt || Date.now(),
            panes: snapshot.panes || {},
            windows: snapshot.windows || {},
            sessions: snapshot.sessions || {},
          }
        : { hasAgents: false, updatedAt: Date.now(), panes: {}, windows: {}, sessions: {} };
      _byServer[sid] = next;
      _notifyUi(true);
    },

    getSnapshot: function (serverId) {
      return _byServer[serverId || 'local'] || null;
    },

    getPane: function (serverId, paneId) {
      if (!paneId) return null;
      var snap = _byServer[serverId || 'local'];
      return (snap && snap.panes && snap.panes[paneId]) || null;
    },

    getSession: function (serverId, session) {
      if (!session) return null;
      var snap = _byServer[serverId || 'local'];
      var sessions = snap && snap.sessions;
      if (!sessions) return null;
      if (session.id && sessions[session.id]) return sessions[session.id];
      if (session.name && sessions[session.name]) return sessions[session.name];
      if (session.name) {
        var keys = Object.keys(sessions);
        for (var i = 0; i < keys.length; i += 1) {
          var entry = sessions[keys[i]];
          if (entry && entry.sessionName === session.name) return entry;
        }
      }
      return null;
    },

    getWindow: function (serverId, win) {
      if (!win) return null;
      var snap = _byServer[serverId || 'local'];
      var entry = snap && snap.windows && win.id && snap.windows[win.id];
      if (entry) return entry;

      var panes = Array.isArray(win.panes) ? win.panes : [];
      var bestStatus = null;
      var bestRank = -1;
      var primaryAgent = '';
      var primaryKind = '';
      var agentCount = 0;
      var unread = false;

      for (var i = 0; i < panes.length; i += 1) {
        var pane = panes[i];
        var snapPane = snap && snap.panes && pane.id && snap.panes[pane.id];
        var info = snapPane || detectFromPane(pane);
        if (!info) continue;
        if (info.agentType || (info.status && info.status !== 'idle')) agentCount += 1;
        if (info.unread) unread = true;
        var rank = STATUS_PRIORITY[info.status] || 0;
        if (rank > bestRank || (rank === bestRank && !primaryAgent && info.agentType)) {
          bestRank = rank;
          bestStatus = info.status;
          primaryAgent = info.agentType || primaryAgent;
          primaryKind = info.appKind || primaryKind;
        }
      }

      var fallbackPane = panes.find(function (p) { return p.active; }) || panes[0];
      if (!primaryKind && fallbackPane) {
        primaryKind = resolveKind(fallbackPane.command || fallbackPane.name, primaryAgent);
      }
      return {
        windowId: win.id || '',
        status: bestStatus || (primaryAgent ? 'idle' : null),
        appKind: primaryKind || 'shell',
        agentType: primaryAgent,
        agentCount: agentCount,
        unread: unread,
        updatedAt: 0,
      };
    },

    getWindowAgentPanes: function (serverId, win) {
      var snap = _byServer[serverId || 'local'];
      var panes = Array.isArray(win && win.panes) ? win.panes : [];
      var result = [];
      for (var i = 0; i < panes.length; i += 1) {
        var pane = panes[i];
        var snapPane = snap && snap.panes && pane.id && snap.panes[pane.id];
        var info = snapPane || detectFromPane(pane);
        if (!info) continue;
        if (!info.agentType && (!info.status || info.status === 'idle')) continue;
        result.push({ pane: pane, info: info });
      }
      result.sort(function (a, b) {
        var diff = (STATUS_PRIORITY[b.info.status] || 0) - (STATUS_PRIORITY[a.info.status] || 0);
        if (diff !== 0) return diff;
        return Number(a.pane.index || 0) - Number(b.pane.index || 0);
      });
      return result;
    },

    getAttentionPanes: function (serverId) {
      var sid = serverId || 'local';
      var snap = _byServer[sid];
      if (!snap || !snap.panes) return [];
      var workspace = global.AppShell && typeof global.AppShell.workspace === 'function'
        ? global.AppShell.workspace(sid)
        : null;
      var locByPane = Object.create(null);
      if (workspace && Array.isArray(workspace.sessions)) {
        workspace.sessions.forEach(function (sess) {
          (sess.windows || []).forEach(function (win) {
            (win.panes || []).forEach(function (p) {
              locByPane[p.id] = {
                session: sess.name,
                sessionId: sess.id,
                windowId: win.id,
                windowIndex: win.index,
                windowName: win.name,
              };
            });
          });
        });
      }
      var list = [];
      Object.keys(snap.panes).forEach(function (paneId) {
        var entry = snap.panes[paneId];
        if (!entry || (entry.status !== 'permission' && entry.status !== 'failed')) return;
        var loc = locByPane[paneId] || {};
        list.push(Object.assign({}, entry, loc, { serverId: sid, paneId: paneId }));
      });
      return list;
    },

    fetch: function (serverId) {
      var sid = serverId || 'local';
      if (!global.Api || typeof global.Api.get !== 'function' || typeof global.Api.nodeUrl !== 'function') {
        return Promise.resolve(null);
      }
      return global.Api.get(global.Api.nodeUrl(sid, '/api/agent-status')).then(function (data) {
        if (data && typeof data === 'object') {
          AgentStatus.setSnapshot(sid, data);
        }
        return data;
      }).catch(function () {
        return null;
      });
    },

    acknowledge: function (serverId, target) {
      var sid = serverId || 'local';
      var t = target || {};
      var snap = _byServer[sid];
      if (!snap || !snap.panes) return;

      var workspace = global.AppShell && typeof global.AppShell.workspace === 'function'
        ? global.AppShell.workspace(sid)
        : null;
      var targetPaneIds = Object.create(null);
      if (t.paneId) targetPaneIds[t.paneId] = true;
      if (t.windowId && workspace && Array.isArray(workspace.sessions)) {
        workspace.sessions.forEach(function (sess) {
          (sess.windows || []).forEach(function (win) {
            if (win.id === t.windowId) {
              (win.panes || []).forEach(function (p) { targetPaneIds[p.id] = true; });
            }
          });
        });
      }

      var changed = false;
      Object.keys(targetPaneIds).forEach(function (pid) {
        var entry = snap.panes[pid];
        if (entry && entry.status === 'done' && entry.unread) {
          entry.unread = false;
          changed = true;
        }
      });

      if (t.windowId && snap.windows && snap.windows[t.windowId] && snap.windows[t.windowId].status === 'done' && snap.windows[t.windowId].unread) {
        snap.windows[t.windowId].unread = false;
        changed = true;
      }

      if (!changed) return;

      // Recompute session unread flags
      if (workspace && Array.isArray(workspace.sessions) && snap.sessions) {
        workspace.sessions.forEach(function (sess) {
          var sEntry = AgentStatus.getSession(sid, sess);
          if (!sEntry) return;
          sEntry.unread = (sess.windows || []).some(function (win) {
            var wEntry = snap.windows && snap.windows[win.id];
            return Boolean(wEntry && wEntry.unread);
          });
        });
      }

      _notifyUi(false);

      if (global.Api && typeof global.Api.post === 'function' && typeof global.Api.nodeUrl === 'function') {
        global.Api.post(global.Api.nodeUrl(sid, '/api/agent-status/ack'), {
          paneId: t.paneId || '',
          windowId: t.windowId || '',
          sessionId: t.sessionId || '',
        }).catch(function () {});
      }
    },

    refreshRelativeTimes: function () {
      if (!global.document || typeof global.document.querySelectorAll !== 'function') return;
      var now = Date.now();
      var nodes = global.document.querySelectorAll('.tree-agent-row .agent-row-time[data-ts]');
      for (var i = 0; i < nodes.length; i += 1) {
        var el = nodes[i];
        var ts = Number(el.getAttribute('data-ts') || 0);
        if (ts > 0) el.textContent = formatRelativeTime(ts, now);
      }
    },

    startRelativeTimeTick: function () {
      if (_tickTimer) return;
      if (typeof global.setInterval !== 'function') return;
      _tickTimer = global.setInterval(function () {
        AgentStatus.refreshRelativeTimes();
      }, 30000);
    },

    _reset: function () {
      _byServer = Object.create(null);
      if (_tickTimer && typeof global.clearInterval === 'function') {
        global.clearInterval(_tickTimer);
      }
      _tickTimer = null;
    },
  };

  global.AgentIcons = {
    resolveKind: resolveKind,
    isAgentKind: isAgentKind,
    appIcon: appIcon,
    statusIcon: statusIcon,
    labelOf: labelOf,
    formatShortModel: formatShortModel,
    formatRelativeTime: formatRelativeTime,
    detectFromPane: detectFromPane,
  };
  global.AgentStatus = AgentStatus;
})(typeof window !== 'undefined' ? window : globalThis);
