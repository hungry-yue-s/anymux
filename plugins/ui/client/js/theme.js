/* global */

// === Theme, Wallpaper, Glass & Typography Manager ===

var Theme = (function () {
  var LEGACY_STORAGE_KEY = 'tmux_theme';
  var V2_APPEARANCE_KEY = 'anymux_appearance_v2';
  var V3_APPEARANCE_KEY = 'anymux_appearance_v3';
  var APPEARANCE_KEY = 'anymux_appearance_v4';
  var LEGACY_TRANSPARENCY_KEY = 'tmux_native_transparency';
  var LEGACY_GLASS_KEY = 'tmux_native_glass_intensity';
  var DEFAULT_THEME = 'tokyo-night';
  var MAX_CUSTOM_THEMES = 20;

  // Retired choices migrate once on load; they no longer appear in the picker.
  var THEME_ALIASES = {
    'tokyo-night-storm': 'tokyo-night',
    'catppuccin-mocha': 'prism',
    'catppuccin-mocha-pastel': 'prism',
    'rose-pine-moon': 'prism',
    'dracula': 'prism',
    'one-dark': 'graphite',
    'solarized-dark': 'deep-current',
  };

  var BUILT_IN_WALLPAPERS = [
    {
      id: 'prism-aurora',
      name: '棱镜极光',
      description: '烟紫与柔紫棱镜折射光带',
      url: '/wallpapers/prism-aurora.webp',
      scheme: 'dark',
      themes: ['prism'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 75% 22%, rgba(185,166,238,0.42), transparent 52%), linear-gradient(135deg, #191923, #292736)',
    },
    {
      id: 'graphite-monolith',
      name: '石墨光影',
      description: '建筑感炭黑斜切柔银光面',
      url: '/wallpapers/graphite-monolith.webp',
      scheme: 'dark',
      themes: ['graphite'],
      kind: 'webp',
      previewBg: 'linear-gradient(135deg, #141414 0%, #252525 55%, #3a3936 100%)',
    },
    {
      id: 'deep-current-abyss',
      name: '深海微光',
      description: '深海青底与暖铜水波光束',
      url: '/wallpapers/deep-current-abyss.webp',
      scheme: 'dark',
      themes: ['deep-current'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 28% 20%, rgba(237,189,139,0.28), transparent 48%), linear-gradient(160deg, #101b1e, #173b40)',
    },
    {
      id: 'forest-ink-mist',
      name: '林雾墨山',
      description: '深林松影与苔金晨雾',
      url: '/wallpapers/forest-ink-mist.webp',
      scheme: 'dark',
      themes: ['forest-ink'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 70% 25%, rgba(186,202,132,0.26), transparent 50%), linear-gradient(155deg, #121d17, #1a2920)',
    },
    {
      id: 'tokyo-night-skyline',
      name: '夜幕东京',
      description: '午夜靛蓝与远景虚化蓝紫光斑',
      url: '/wallpapers/tokyo-night-skyline.webp',
      scheme: 'dark',
      themes: ['tokyo-night'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 72% 30%, rgba(122,162,247,0.34), transparent 52%), linear-gradient(150deg, #16161e, #1a1b26)',
    },
    {
      id: 'nord-fjord',
      name: '北欧峡湾',
      description: '极地岩蓝与霜青极光薄幕',
      url: '/wallpapers/nord-fjord.webp',
      scheme: 'dark',
      themes: ['nord'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 65% 24%, rgba(136,192,208,0.32), transparent 52%), linear-gradient(150deg, #272c36, #2e3440)',
    },
    {
      id: 'gruvbox-amber',
      name: '琥珀暮霭',
      description: '暖炭胶片与暮色琥珀光晕',
      url: '/wallpapers/gruvbox-amber.webp',
      scheme: 'dark',
      themes: ['gruvbox-dark'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 30% 28%, rgba(250,189,47,0.28), transparent 52%), linear-gradient(150deg, #1d2021, #282828)',
    },
    {
      id: 'oyster-dune',
      name: '牡蛎沙丘',
      description: '暖灰白侘寂沙丘与陶土暖光',
      url: '/wallpapers/oyster-dune.webp',
      scheme: 'light',
      themes: ['oyster'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 72% 24%, rgba(167,74,52,0.18), transparent 52%), linear-gradient(150deg, #f4f1eb, #e9e3d9)',
    },
    {
      id: 'solarized-horizon',
      name: '日光纸境',
      description: '暖米纸感地平线与天蓝微光',
      url: '/wallpapers/solarized-horizon.webp',
      scheme: 'light',
      themes: ['solarized-light'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 70% 22%, rgba(38,139,210,0.2), transparent 50%), linear-gradient(150deg, #fdf6e3, #eee8d5)',
    },
    {
      id: 'github-mist',
      name: '晴空微雾',
      description: '净白冷蓝极简散射光影',
      url: '/wallpapers/github-mist.webp',
      scheme: 'light',
      themes: ['github-light'],
      kind: 'webp',
      previewBg: 'radial-gradient(circle at 72% 24%, rgba(9,105,218,0.16), transparent 52%), linear-gradient(150deg, #ffffff, #f6f8fa)',
    },
    {
      id: 'obsidian-topo',
      name: '黑曜等高线',
      description: '极简矢量等高线（深色通用）',
      url: '/wallpapers/obsidian-topo.svg',
      scheme: 'dark',
      themes: [],
      kind: 'svg',
      previewBg: 'linear-gradient(145deg, #14161f, #22263a)',
    },
    {
      id: 'zen-silk',
      name: '素练流云',
      description: '极简矢量丝绸曲线（浅色通用）',
      url: '/wallpapers/zen-silk.svg',
      scheme: 'light',
      themes: [],
      kind: 'svg',
      previewBg: 'linear-gradient(145deg, #f5f4f0, #e5e2d9)',
    },
  ];

  var WEB_PRESETS = {
    'clear': {
      id: 'clear',
      name: '清晰',
      description: '无模糊直显壁纸与轻度遮罩',
      blurRadius: 0,
      saturation: 105,
      brightness: 100,
      noiseOpacity: 0,
      sidebarTint: 28,
      terminalTint: 48,
    },
    'mist': {
      id: 'mist',
      name: '柔雾',
      description: '轻度柔化与通透磨砂',
      blurRadius: 14,
      saturation: 118,
      brightness: 100,
      noiseOpacity: 3,
      sidebarTint: 36,
      terminalTint: 72,
    },
    'frosted': {
      id: 'frosted',
      name: '深邃',
      description: '均衡模糊与细腻胶片质感',
      blurRadius: 24,
      saturation: 135,
      brightness: 98,
      noiseOpacity: 5,
      sidebarTint: 24,
      terminalTint: 66,
    },
  };

  var ACCENT_SWATCHES = [
    '#7aa2f7', '#b9a6ee', '#edbd8b', '#baca84',
    '#88c0d0', '#f7768e', '#fabd2f', '#a74a34', '#0969da',
  ];

  var BUILT_IN_THEMES = {
    'prism': {
      name: 'Prism · 棱镜', description: '烟紫底色 · 银灰文字 · 柔紫强调',
      defaultWallpaper: 'prism-aurora',
      ui: {
        '--bg-primary': '#191923', '--bg-deep': '#22212e', '--bg-card': '#292736',
        '--bg-hover': '#363345', '--border': '#655e7b', '--border-subtle': '#403a51',
        '--text-primary': '#e8e5f2', '--text-secondary': '#aca8be', '--text-muted': '#aca8be',
        '--accent-blue': '#a6a5f8', '--accent-green': '#a7c7ad', '--accent-red': '#ef9ba9',
        '--accent-yellow': '#e7c78e', '--accent-purple': '#c4a4e8',
      },
      workspace: { '--workspace-accent': '#b9a6ee' },
      terminal: {
        background: '#191923', foreground: '#e8e5f2', cursor: '#c8b8f4', cursorAccent: '#191923',
        selectionBackground: '#464058', black: '#22212e', red: '#ef9ba9', green: '#a7c7ad',
        yellow: '#e7c78e', blue: '#a6a5f8', magenta: '#c4a4e8', cyan: '#92cbd3', white: '#d4d0e2',
        brightBlack: '#8d879f', brightRed: '#ffb3bd', brightGreen: '#bcdec2', brightYellow: '#f3dba8',
        brightBlue: '#c0baff', brightMagenta: '#dfbafa', brightCyan: '#abe3e9', brightWhite: '#f8f4ff',
      },
    },
    'graphite': {
      name: 'Graphite · 石墨', description: '中性炭黑 · 暖银强调 · 低饱和语法色',
      defaultWallpaper: 'graphite-monolith',
      ui: {
        '--bg-primary': '#141414', '--bg-deep': '#1c1c1c', '--bg-card': '#252525',
        '--bg-hover': '#303030', '--border': '#62625e', '--border-subtle': '#393937',
        '--text-primary': '#e9e9e6', '--text-secondary': '#b0b0aa', '--text-muted': '#b0b0aa',
        '--accent-blue': '#a8bdd5', '--accent-green': '#a9c7a4', '--accent-red': '#e8a0a0',
        '--accent-yellow': '#dbc58d', '--accent-purple': '#c5adcf',
      },
      workspace: { '--workspace-accent': '#c9c7bf' },
      terminal: {
        background: '#141414', foreground: '#e9e9e6', cursor: '#eee9d9', cursorAccent: '#141414',
        selectionBackground: '#42423e', black: '#1c1c1c', red: '#e8a0a0', green: '#a9c7a4',
        yellow: '#dbc58d', blue: '#a8bdd5', magenta: '#c5adcf', cyan: '#9dc9c7', white: '#d2d2cc',
        brightBlack: '#8e8e88', brightRed: '#f4b5b5', brightGreen: '#bedbb8', brightYellow: '#eed9a6',
        brightBlue: '#bed1e8', brightMagenta: '#dcc3e5', brightCyan: '#b6dfdc', brightWhite: '#f5f5ef',
      },
    },
    'deep-current': {
      name: 'Deep Current', description: '深海青底 · 暖铜强调',
      defaultWallpaper: 'deep-current-abyss',
      ui: {
        '--bg-primary': '#101b1e', '--bg-deep': '#173b40', '--bg-card': '#223236',
        '--bg-hover': '#2b4549', '--border': '#526b6a', '--border-subtle': '#344f51',
        '--text-primary': '#e5efeb', '--text-secondary': '#a1b7b5', '--text-muted': '#a1b7b5',
        '--accent-blue': '#7aa2f7', '--accent-green': '#9ece6a', '--accent-red': '#f7768e',
        '--accent-yellow': '#e0af68', '--accent-purple': '#bb9af7',
      },
      workspace: { '--workspace-accent': '#edbd8b' },
      terminal: {
        background: '#101b1e', foreground: '#e5efeb', cursor: '#edbd8b', cursorAccent: '#101b1e',
        selectionBackground: '#42524a', black: '#101b1e', red: '#f7768e', green: '#9ece6a',
        yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
        brightBlack: '#718b89', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
        brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#e5efeb',
      },
    },
    'forest-ink': {
      name: 'Forest Ink · 森林', description: '深林绿底 · 苔黄强调 · 草木色阶',
      defaultWallpaper: 'forest-ink-mist',
      ui: {
        '--bg-primary': '#121d17', '--bg-deep': '#1a2920', '--bg-card': '#24332a',
        '--bg-hover': '#304237', '--border': '#617c65', '--border-subtle': '#354a3b',
        '--text-primary': '#e2ebde', '--text-secondary': '#afc3ac', '--text-muted': '#afc3ac',
        '--accent-blue': '#a1b9ca', '--accent-green': '#baca84', '--accent-red': '#e49c8b',
        '--accent-yellow': '#ddc48e', '--accent-purple': '#c2acd0',
      },
      workspace: { '--workspace-accent': '#baca84' },
      terminal: {
        background: '#121d17', foreground: '#e2ebde', cursor: '#baca84', cursorAccent: '#121d17',
        selectionBackground: '#3b503e', black: '#1a2920', red: '#e49c8b', green: '#baca84',
        yellow: '#ddc48e', blue: '#a1b9ca', magenta: '#c2acd0', cyan: '#91c9b7', white: '#cedbc9',
        brightBlack: '#879b85', brightRed: '#f4b4a3', brightGreen: '#d0dfa0', brightYellow: '#efdaa7',
        brightBlue: '#bbd0df', brightMagenta: '#d9c3e6', brightCyan: '#a8dfcc', brightWhite: '#f0f5e9',
      },
    },
    'tokyo-night': {
      name: 'Tokyo Night', description: '午夜蓝底 · 清亮蓝紫',
      defaultWallpaper: 'tokyo-night-skyline',
      ui: {
        '--bg-primary': '#1a1b26',
        '--bg-deep': '#16161e',
        '--bg-card': '#24283b',
        '--bg-hover': '#292e42',
        '--border': '#3b4261',
        '--border-subtle': '#2f3450',
        '--text-primary': '#c0caf5',
        '--text-secondary': '#a9b1d6',
        '--text-muted': '#565f89',
        '--accent-blue': '#7aa2f7',
        '--accent-green': '#9ece6a',
        '--accent-red': '#f7768e',
        '--accent-yellow': '#e0af68',
        '--accent-purple': '#bb9af7',
      },
      terminal: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
    },
    'nord': {
      name: 'Nord', description: '北欧蓝灰 · 冷调低饱和',
      defaultWallpaper: 'nord-fjord',
      ui: {
        '--bg-primary': '#2e3440',
        '--bg-deep': '#272c36',
        '--bg-card': '#3b4252',
        '--bg-hover': '#434c5e',
        '--border': '#4c566a',
        '--border-subtle': '#3b4252',
        '--text-primary': '#eceff4',
        '--text-secondary': '#d8dee9',
        '--text-muted': '#616e88',
        '--accent-blue': '#81a1c1',
        '--accent-green': '#a3be8c',
        '--accent-red': '#bf616a',
        '--accent-yellow': '#ebcb8b',
        '--accent-purple': '#b48ead',
      },
      terminal: {
        background: '#2e3440',
        foreground: '#d8dee9',
        cursor: '#d8dee9',
        cursorAccent: '#2e3440',
        selectionBackground: '#434c5e',
        black: '#3b4252',
        red: '#bf616a',
        green: '#a3be8c',
        yellow: '#ebcb8b',
        blue: '#81a1c1',
        magenta: '#b48ead',
        cyan: '#88c0d0',
        white: '#e5e9f0',
        brightBlack: '#4c566a',
        brightRed: '#bf616a',
        brightGreen: '#a3be8c',
        brightYellow: '#ebcb8b',
        brightBlue: '#81a1c1',
        brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb',
        brightWhite: '#eceff4',
      },
    },
    'gruvbox-dark': {
      name: 'Gruvbox Dark', description: '暖炭灰底 · 复古琥珀',
      defaultWallpaper: 'gruvbox-amber',
      ui: {
        '--bg-primary': '#282828',
        '--bg-deep': '#1d2021',
        '--bg-card': '#3c3836',
        '--bg-hover': '#504945',
        '--border': '#665c54',
        '--border-subtle': '#3c3836',
        '--text-primary': '#ebdbb2',
        '--text-secondary': '#d5c4a1',
        '--text-muted': '#928374',
        '--accent-blue': '#83a598',
        '--accent-green': '#b8bb26',
        '--accent-red': '#fb4934',
        '--accent-yellow': '#fabd2f',
        '--accent-purple': '#d3869b',
      },
      terminal: {
        background: '#282828',
        foreground: '#ebdbb2',
        cursor: '#ebdbb2',
        cursorAccent: '#282828',
        selectionBackground: '#504945',
        black: '#282828',
        red: '#cc241d',
        green: '#98971a',
        yellow: '#d79921',
        blue: '#458588',
        magenta: '#b16286',
        cyan: '#689d6a',
        white: '#a89984',
        brightBlack: '#928374',
        brightRed: '#fb4934',
        brightGreen: '#b8bb26',
        brightYellow: '#fabd2f',
        brightBlue: '#83a598',
        brightMagenta: '#d3869b',
        brightCyan: '#8ec07c',
        brightWhite: '#ebdbb2',
      },
    },
    'oyster': {
      name: 'Oyster · 牡蛎白', description: '暖灰白底 · 陶土红强调 · 深墨文字',
      defaultWallpaper: 'oyster-dune',
      ui: {
        '--bg-primary': '#f4f1eb', '--bg-deep': '#e9e3d9', '--bg-card': '#fcfaf6',
        '--bg-hover': '#dfd7cb', '--border': '#9a8c7c', '--border-subtle': '#d4cbbc',
        '--text-primary': '#282522', '--text-secondary': '#63594e', '--text-muted': '#63594e',
        '--accent-blue': '#315e88', '--accent-green': '#3d603d', '--accent-red': '#a33735',
        '--accent-yellow': '#725014', '--accent-purple': '#795184',
      },
      workspace: { '--workspace-accent': '#a74a34' },
      terminal: {
        background: '#f4f1eb', foreground: '#282522', cursor: '#a74a34', cursorAccent: '#f4f1eb',
        selectionBackground: '#d6c5ae', black: '#302b26', red: '#a33735', green: '#3d603d',
        yellow: '#725014', blue: '#315e88', magenta: '#795184', cyan: '#27676b', white: '#6d6257',
        brightBlack: '#75695c', brightRed: '#b13b36', brightGreen: '#456d3f', brightYellow: '#806020',
        brightBlue: '#3c6594', brightMagenta: '#85588c', brightCyan: '#34747a', brightWhite: '#5b5148',
      },
    },
    'solarized-light': {
      name: 'Solarized Light', description: '浅米黄底 · 经典日光配色',
      defaultWallpaper: 'solarized-horizon',
      ui: {
        '--bg-primary': '#fdf6e3',
        '--bg-deep': '#eee8d5',
        '--bg-card': '#eee8d5',
        '--bg-hover': '#e6dfcb',
        '--border': '#d3cbb7',
        '--border-subtle': '#eee8d5',
        '--text-primary': '#657b83',
        '--text-secondary': '#586e75',
        '--text-muted': '#93a1a1',
        '--accent-blue': '#268bd2',
        '--accent-green': '#859900',
        '--accent-red': '#dc322f',
        '--accent-yellow': '#b58900',
        '--accent-purple': '#6c71c4',
      },
      terminal: {
        background: '#fdf6e3',
        foreground: '#657b83',
        cursor: '#586e75',
        cursorAccent: '#fdf6e3',
        selectionBackground: '#eee8d5',
        black: '#073642',
        red: '#dc322f',
        green: '#859900',
        yellow: '#b58900',
        blue: '#268bd2',
        magenta: '#d33682',
        cyan: '#2aa198',
        white: '#eee8d5',
        brightBlack: '#586e75',
        brightRed: '#cb4b16',
        brightGreen: '#586e75',
        brightYellow: '#657b83',
        brightBlue: '#839496',
        brightMagenta: '#6c71c4',
        brightCyan: '#93a1a1',
        brightWhite: '#fdf6e3',
      },
    },
    'github-light': {
      name: 'GitHub Light', description: '纯白底 · 清晰蓝色强调',
      defaultWallpaper: 'github-mist',
      ui: {
        '--bg-primary': '#ffffff',
        '--bg-deep': '#f6f8fa',
        '--bg-card': '#f6f8fa',
        '--bg-hover': '#ebeef1',
        '--border': '#d0d7de',
        '--border-subtle': '#e8ebef',
        '--text-primary': '#1f2328',
        '--text-secondary': '#656d76',
        '--text-muted': '#8b949e',
        '--accent-blue': '#0969da',
        '--accent-green': '#1a7f37',
        '--accent-red': '#cf222e',
        '--accent-yellow': '#9a6700',
        '--accent-purple': '#8250df',
      },
      terminal: {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#044289',
        cursorAccent: '#ffffff',
        selectionBackground: '#bbd6fb',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d2d00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#8c959f',
      },
    },
  };

  // --- Color & WCAG helpers ---

  function rgb(colorHex) {
    return [1, 3, 5].map(function (offset) { return parseInt(colorHex.slice(offset, offset + 2), 16); });
  }

  function mix(a, b, amount) {
    return a.map(function (channel, index) { return Math.round(channel * (1 - amount) + b[index] * amount); });
  }

  function hex(channels) {
    return '#' + channels.map(function (channel) {
      var clamped = Math.max(0, Math.min(255, Math.round(channel)));
      return ('0' + clamped.toString(16)).slice(-2);
    }).join('');
  }

  function luminance(channels) {
    var linear = channels.map(function (channel) {
      var value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function contrast(a, b) {
    var first = luminance(a), second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  function readable(color, surfaces, light, ratio) {
    var original = rgb(color), end = light ? [0, 0, 0] : [255, 255, 255];
    for (var step = 0; step <= 100; step++) {
      var candidate = mix(original, end, step / 100);
      if (surfaces.every(function (surface) { return contrast(candidate, surface) >= ratio; })) return hex(candidate);
    }
    return hex(end);
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    var trimmed = value.trim();
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
  }

  function cloneObj(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
    return out;
  }

  function deriveUiFromTerminal(term, light) {
    var bg = rgb(term.background);
    var fg = rgb(term.foreground);
    var extreme = light ? [255, 255, 255] : [0, 0, 0];
    return {
      '--bg-primary': hex(bg),
      '--bg-deep': hex(mix(bg, extreme, light ? 0.22 : 0.28)),
      '--bg-card': hex(mix(bg, fg, 0.06)),
      '--bg-hover': hex(mix(bg, fg, 0.12)),
      '--border': hex(mix(bg, fg, 0.28)),
      '--border-subtle': hex(mix(bg, fg, 0.14)),
      '--text-primary': hex(fg),
      '--text-secondary': hex(mix(fg, bg, 0.24)),
      '--text-muted': hex(mix(fg, bg, 0.34)),
      '--accent-blue': term.blue || (light ? '#0969da' : '#7aa2f7'),
      '--accent-green': term.green || (light ? '#1a7f37' : '#9ece6a'),
      '--accent-red': term.red || (light ? '#cf222e' : '#f7768e'),
      '--accent-yellow': term.yellow || (light ? '#9a6700' : '#e0af68'),
      '--accent-purple': term.magenta || (light ? '#8250df' : '#bb9af7'),
    };
  }

  function deriveTerminalFromUi(ui, light) {
    var bg = ui['--bg-primary'];
    var fg = ui['--text-primary'];
    var sel = hex(mix(rgb(bg), rgb(ui['--accent-blue'] || fg), 0.24));
    return {
      background: bg,
      foreground: fg,
      cursor: ui['--accent-blue'] || fg,
      cursorAccent: bg,
      selectionBackground: sel,
      black: light ? '#24292f' : '#15161e',
      red: ui['--accent-red'] || '#f7768e',
      green: ui['--accent-green'] || '#9ece6a',
      yellow: ui['--accent-yellow'] || '#e0af68',
      blue: ui['--accent-blue'] || '#7aa2f7',
      magenta: ui['--accent-purple'] || '#bb9af7',
      cyan: light ? '#1b7c83' : '#7dcfff',
      white: light ? '#6e7781' : '#c0caf5',
      brightBlack: light ? '#57606a' : '#565f89',
      brightRed: ui['--accent-red'] || '#f7768e',
      brightGreen: ui['--accent-green'] || '#9ece6a',
      brightYellow: ui['--accent-yellow'] || '#e0af68',
      brightBlue: ui['--accent-blue'] || '#7aa2f7',
      brightMagenta: ui['--accent-purple'] || '#bb9af7',
      brightCyan: light ? '#3192aa' : '#7dcfff',
      brightWhite: light ? '#24292f' : '#ffffff',
    };
  }

  function compileTheme(rawTheme, accentOverride) {
    var rawUi = cloneObj(rawTheme.ui || {});
    var rawTerm = cloneObj(rawTheme.terminal || {});
    var primaryBg = normalizeHex(rawUi['--bg-primary']) || normalizeHex(rawTerm.background) || '#1a1b26';
    var light = luminance(rgb(primaryBg)) > 0.5;

    if (!normalizeHex(rawUi['--bg-primary']) || !normalizeHex(rawUi['--text-primary'])) {
      var seedTerm = {
        background: normalizeHex(rawTerm.background) || primaryBg,
        foreground: normalizeHex(rawTerm.foreground) || (light ? '#1f2328' : '#e5e9f0'),
        blue: normalizeHex(rawTerm.blue),
        green: normalizeHex(rawTerm.green),
        red: normalizeHex(rawTerm.red),
        yellow: normalizeHex(rawTerm.yellow),
        magenta: normalizeHex(rawTerm.magenta),
      };
      var derivedUi = deriveUiFromTerminal(seedTerm, light);
      Object.keys(derivedUi).forEach(function (k) {
        if (!normalizeHex(rawUi[k])) rawUi[k] = derivedUi[k];
      });
    }

    var ui = cloneObj(rawUi);
    var derivedTerm = deriveTerminalFromUi(ui, light);
    var terminal = cloneObj(derivedTerm);
    Object.keys(rawTerm).forEach(function (k) {
      var h = normalizeHex(rawTerm[k]);
      if (h) terminal[k] = h;
    });

    var workspace = {
      '--workspace-bg': ui['--bg-primary'],
      '--workspace-sidebar': ui['--bg-deep'] || ui['--bg-primary'],
      '--workspace-panel': ui['--bg-card'] || ui['--bg-primary'],
      '--workspace-hover': ui['--bg-hover'] || ui['--bg-card'] || ui['--bg-primary'],
      '--workspace-text': ui['--text-primary'],
      '--workspace-muted': ui['--text-secondary'] || ui['--text-primary'],
      '--workspace-accent': ui['--accent-blue'] || ui['--text-primary'],
      '--workspace-line': ui['--border-subtle'] || ui['--border'] || ui['--bg-hover'],
      '--workspace-line-strong': ui['--border'] || ui['--text-secondary'],
    };
    if (rawTheme.workspace) Object.assign(workspace, rawTheme.workspace);

    var safeAccent = normalizeHex(accentOverride);
    if (safeAccent) {
      workspace['--workspace-accent'] = safeAccent;
      ui['--accent-blue'] = safeAccent;
    }

    var surfaces = ['--workspace-bg', '--workspace-sidebar', '--workspace-panel', '--workspace-hover']
      .map(function (key) { return rgb(workspace[key]); });
    var backdrops = surfaces.slice();
    surfaces.forEach(function (surface) {
      backdrops.push(mix(surface, [0, 0, 0], 0.08), mix(surface, [255, 255, 255], 0.08));
    });
    ['--workspace-text', '--workspace-muted', '--workspace-accent'].forEach(function (key) {
      workspace[key] = readable(workspace[key], backdrops, light, 4.6);
    });
    workspace['--workspace-line-strong'] = readable(workspace['--workspace-line-strong'], backdrops, light, 3.1);
    ['--accent-blue', '--accent-green', '--accent-red', '--accent-yellow', '--accent-purple'].forEach(function (key) {
      if (ui[key]) ui[key] = readable(ui[key], backdrops, light, 4.6);
    });
    ui['--text-primary'] = workspace['--workspace-text'];
    ui['--text-secondary'] = ui['--text-muted'] = workspace['--workspace-muted'];
    ui['--border'] = workspace['--workspace-line-strong'];
    Object.assign(ui, workspace);

    ['foreground', 'cursor'].forEach(function (key) {
      terminal[key] = readable(terminal[key], [rgb(terminal.background)], light, 4.6);
    });
    terminal.selectionForeground = readable(terminal.foreground, [rgb(terminal.selectionBackground)], light, 4.6);

    return {
      id: rawTheme.id,
      name: rawTheme.name,
      description: rawTheme.description || '',
      defaultWallpaper: rawTheme.defaultWallpaper || (light ? 'zen-silk' : 'obsidian-topo'),
      colorScheme: light ? 'light' : 'dark',
      ui: ui,
      terminal: terminal,
      isCustom: Boolean(rawTheme.isCustom),
      raw: rawTheme,
    };
  }

  // Compile built-in themes cleanly on load.
  var themes = {};
  Object.keys(BUILT_IN_THEMES).forEach(function (id) {
    var src = BUILT_IN_THEMES[id];
    themes[id] = compileTheme({
      id: id,
      name: src.name,
      description: src.description,
      defaultWallpaper: src.defaultWallpaper,
      ui: src.ui,
      workspace: src.workspace,
      terminal: src.terminal,
      isCustom: false,
    }, null);
  });

  // --- Capability probes ---

  function supportsTransparency() {
    return window.__anymuxTransparency === true || window.__tmuxPanelTransparency === true;
  }

  // The macOS app names its handler tmuxPanelAppearance in versions before the rename.
  function appearanceHandler() {
    var handlers = window.webkit && window.webkit.messageHandlers;
    return handlers && (handlers.anymuxAppearance || handlers.tmuxPanelAppearance) || null;
  }

  function supportsGlassIntensity() {
    var handler = appearanceHandler();
    return supportsTransparency() && !!(handler && typeof handler.postMessage === 'function');
  }

  function supportsLiquidGlass() {
    return window.__anymuxLiquidGlass === true;
  }

  function supportsMaterialEngine() {
    return supportsGlassIntensity() && window.__anymuxGlassEngine === 'material';
  }

  function hasRichNativeEngine() {
    return Boolean(window.__anymuxGlassEngine);
  }

  // --- Clamping & defaults ---

  function clampInt(value, min, max, fallback) {
    var num = Number(value);
    return isFinite(num) ? Math.max(min, Math.min(max, Math.round(num))) : fallback;
  }

  function clampFloat(value, min, max, step, fallback) {
    var num = Number(value);
    if (!isFinite(num)) return fallback;
    var clamped = Math.max(min, Math.min(max, num));
    return Number((Math.round(clamped / step) * step).toFixed(2));
  }

  function clampTransparency(value) {
    return clampInt(value, 0, 50, 0);
  }

  function clampGlassIntensity(value) {
    return clampInt(value, 0, 100, 100);
  }

  function defaultSurface(profile) {
    var isMobile = profile === 'mobile';
    return {
      updatedAt: 0,
      mode: 'solid',
      wallpaperSource: 'follow',
      wallpaperId: null,
      wallpaperFit: 'cover',
      wallpaperBrightness: 100,
      webPreset: isMobile ? 'mist' : 'frosted',
      blurRadius: isMobile ? 14 : 22,
      saturation: isMobile ? 118 : 135,
      brightness: 100,
      noiseOpacity: isMobile ? 0 : 4,
      sidebarTint: isMobile ? 38 : 24,
      terminalTint: isMobile ? 78 : 66,
      nativeEngine: 'material',
      transparency: 0,
      glassIntensity: 100,
    };
  }

  function defaultThemeSlot() {
    return {
      updatedAt: 0,
      mode: 'manual',
      themeId: DEFAULT_THEME,
      lightThemeId: 'oyster',
      darkThemeId: DEFAULT_THEME,
      accentOverride: null,
    };
  }

  function defaultState() {
    return {
      version: 4,
      updatedAt: 0,
      customThemesUpdatedAt: 0,
      terminalUpdatedAt: 0,
      customThemes: [],
      themes: {
        native: defaultThemeSlot(),
        web: defaultThemeSlot(),
        mobile: defaultThemeSlot(),
      },
      terminal: {
        fontSize: 14,
        lineHeight: 1.2,
        cursorStyle: 'block',
        cursorBlink: true,
        panePadding: 6,
        inactivePaneDim: 18,
      },
      surfaces: {
        native: defaultSurface('native'),
        web: defaultSurface('web'),
        mobile: defaultSurface('mobile'),
      },
    };
  }

  function getDeviceProfileKey() {
    if (supportsTransparency()) return 'native';
    try {
      if (window.TmuxAndroid || /\b(?:AnymuxAndroid|TmuxPanelAndroid)\//.test((window.navigator && window.navigator.userAgent) || '')) {
        return 'mobile';
      }
      if (window.MobileUI && typeof window.MobileUI.isMobile === 'function' && window.MobileUI.isMobile()) {
        return 'mobile';
      }
      if (typeof window.matchMedia === 'function') {
        if (window.matchMedia('(max-width: 767px)').matches) return 'mobile';
        if (window.matchMedia('(pointer: coarse) and (max-height: 560px) and (max-width: 1023px)').matches) return 'mobile';
      }
    } catch (_e) {}
    return 'web';
  }

  function sanitizeCustomThemeInput(raw, existingIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 48) : '';
    if (!name) return null;

    var rawId = typeof raw.id === 'string'
      ? raw.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      : '';
    if (!rawId) {
      rawId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme';
    }
    if (rawId.indexOf('custom-') !== 0) rawId = 'custom-' + rawId;
    rawId = rawId.slice(0, 64);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(rawId)) return null;

    if (existingIds) {
      var candidate = rawId;
      var suffix = 2;
      while (existingIds[candidate]) {
        candidate = (rawId.slice(0, 58) + '-' + suffix).slice(0, 64);
        suffix++;
      }
      rawId = candidate;
    }

    var description = typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim().slice(0, 120)
      : '自定义导入主题';
    var rawUi = (raw.ui && typeof raw.ui === 'object' && !Array.isArray(raw.ui))
      ? raw.ui
      : ((raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors)) ? raw.colors : null);
    var rawTerm = (raw.terminal && typeof raw.terminal === 'object' && !Array.isArray(raw.terminal))
      ? raw.terminal
      : (raw.background ? raw : null);
    if (!rawUi && !rawTerm) return null;

    var cleanUi = {};
    if (rawUi) {
      Object.keys(rawUi).forEach(function (k) {
        if (k.indexOf('--') !== 0) return;
        var h = normalizeHex(rawUi[k]);
        if (h) cleanUi[k] = h;
      });
    }

    var TERM_KEYS = [
      'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];
    var cleanTerm = {};
    if (rawTerm) {
      TERM_KEYS.forEach(function (k) {
        var h = normalizeHex(rawTerm[k]);
        if (h) cleanTerm[k] = h;
      });
    }

    var hasTermPair = Boolean(cleanTerm.background && cleanTerm.foreground);
    var hasUiPair = Boolean(cleanUi['--bg-primary'] && cleanUi['--text-primary']);
    if (!hasTermPair && !hasUiPair) return null;

    return {
      id: rawId,
      name: name,
      description: description,
      ui: cleanUi,
      terminal: cleanTerm,
    };
  }

  function sanitizeSurface(profile, rawSurface, baseSurface) {
    var base = baseSurface || defaultSurface(profile);
    var input = rawSurface && typeof rawSurface === 'object' ? rawSurface : {};
    var allowedModes = profile === 'native'
      ? { solid: true, wallpaper: true, desktop: true }
      : { solid: true, wallpaper: true };
    var mode = allowedModes[input.mode] ? input.mode : (allowedModes[base.mode] ? base.mode : 'solid');
    var wpSources = { follow: true, builtin: true, custom: true };
    var wpFits = { cover: true, contain: true, fill: true };
    var webPresets = { clear: true, mist: true, frosted: true, custom: true };
    var validEngines = { material: true, 'liquid-regular': true, 'liquid-clear': true, system: true };

    var wallpaperSource = wpSources[input.wallpaperSource] ? input.wallpaperSource : base.wallpaperSource;
    var wallpaperId = typeof input.wallpaperId === 'string' && input.wallpaperId.trim()
      ? input.wallpaperId.trim().slice(0, 128)
      : ('wallpaperId' in input ? null : base.wallpaperId);
    if (mode !== 'wallpaper' || wallpaperSource === 'follow') {
      wallpaperId = null;
    }

    var ts = Number(input.updatedAt);
    return {
      updatedAt: isFinite(ts) && ts >= 0 ? Math.round(ts) : (base.updatedAt || 0),
      mode: mode,
      wallpaperSource: wallpaperSource,
      wallpaperId: wallpaperId,
      wallpaperFit: wpFits[input.wallpaperFit] ? input.wallpaperFit : base.wallpaperFit,
      wallpaperBrightness: clampInt(input.wallpaperBrightness, 40, 130, base.wallpaperBrightness),
      webPreset: webPresets[input.webPreset] ? input.webPreset : base.webPreset,
      blurRadius: clampInt(input.blurRadius, 0, 48, base.blurRadius),
      saturation: clampInt(input.saturation, 60, 200, base.saturation),
      brightness: clampInt(input.brightness, 75, 125, base.brightness),
      noiseOpacity: clampInt(input.noiseOpacity, 0, 18, base.noiseOpacity),
      sidebarTint: clampInt(input.sidebarTint, 0, 85, base.sidebarTint),
      terminalTint: clampInt(input.terminalTint, 20, 95, base.terminalTint),
      nativeEngine: validEngines[input.nativeEngine] ? input.nativeEngine : (input.nativeEngine === 'off' ? 'material' : base.nativeEngine),
      transparency: profile === 'native' ? clampTransparency(input.transparency !== undefined ? input.transparency : base.transparency) : 0,
      glassIntensity: clampGlassIntensity(input.glassIntensity !== undefined ? input.glassIntensity : base.glassIntensity),
    };
  }

  function isLegacyFlatState(raw) {
    if (
      !raw
      || typeof raw !== 'object'
      || (raw.surfaces && typeof raw.surfaces === 'object')
      || (raw.themes && typeof raw.themes === 'object')
      || (raw.theme && typeof raw.theme === 'object')
      || Number(raw.version) >= 3
      || 'customThemesUpdatedAt' in raw
      || 'themeUpdatedAt' in raw
    ) {
      return false;
    }
    return 'themeId' in raw || 'themeMode' in raw || 'wallpaper' in raw || 'glass' in raw || 'typography' in raw || 'customThemes' in raw;
  }

  function isLegacyV3State(raw) {
    return Boolean(
      raw
      && typeof raw === 'object'
      && (!('version' in raw) || Number(raw.version) < 4)
      && !(raw.themes && typeof raw.themes === 'object')
      && raw.theme
      && typeof raw.theme === 'object'
    );
  }

  function migrateV2ToV3(raw) {
    var wp = raw.wallpaper && typeof raw.wallpaper === 'object' ? raw.wallpaper : {};
    var g = raw.glass && typeof raw.glass === 'object' ? raw.glass : {};
    var typo = raw.typography && typeof raw.typography === 'object' ? raw.typography : {};
    var ts = isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) >= 0 ? Math.round(Number(raw.updatedAt)) : 0;

    var nativeMode = 'solid';
    var webMode = 'solid';
    var wpSource = wp.followTheme === false ? 'builtin' : 'follow';
    var wpId = typeof wp.id === 'string' && wp.id.trim() ? wp.id.trim().slice(0, 128) : null;
    if (wp.mode === 'desktop') {
      nativeMode = 'desktop';
      wpId = null;
    } else if (wp.mode === 'builtin') {
      nativeMode = 'wallpaper';
      webMode = 'wallpaper';
      wpSource = (wp.followTheme === false && wpId) ? 'builtin' : 'follow';
    } else if (wp.mode === 'custom' && wpId) {
      nativeMode = 'wallpaper';
      webMode = 'wallpaper';
      wpSource = 'custom';
    } else {
      wpId = null;
    }

    var presetMap = { solid: 'clear', mist: 'mist', frosted: 'frosted', liquid: 'frosted', 'clear-glass': 'frosted' };
    var shared = {
      updatedAt: ts,
      wallpaperSource: wpSource,
      wallpaperId: wpSource === 'follow' ? null : wpId,
      wallpaperFit: wp.fit,
      wallpaperBrightness: wp.brightness,
      webPreset: presetMap[g.preset] || 'custom',
      blurRadius: g.blurRadius,
      saturation: g.saturation,
      brightness: g.brightness,
      noiseOpacity: g.noiseOpacity,
      sidebarTint: g.sidebarTint,
      terminalTint: g.terminalTint,
      nativeEngine: g.nativeEngine,
      transparency: g.transparency,
      glassIntensity: g.glassIntensity,
    };
    if (clampTransparency(g.transparency) > 0 && nativeMode === 'solid' && wp.mode !== 'builtin' && wp.mode !== 'custom') {
      nativeMode = 'desktop';
    }
    return {
      version: 3,
      updatedAt: ts,
      themeUpdatedAt: ts,
      terminalUpdatedAt: ts,
      theme: {
        mode: raw.themeMode,
        themeId: raw.themeId,
        lightThemeId: raw.lightThemeId,
        darkThemeId: raw.darkThemeId,
        accentOverride: raw.accentOverride,
        customThemes: raw.customThemes,
      },
      terminal: {
        fontSize: typo.fontSize,
        lineHeight: typo.lineHeight,
        cursorStyle: typo.cursorStyle,
        cursorBlink: typo.cursorBlink,
        panePadding: typo.panePadding,
        inactivePaneDim: g.inactivePaneDim,
      },
      surfaces: {
        native: Object.assign({}, shared, { mode: nativeMode }),
        web: Object.assign({}, shared, { mode: webMode, transparency: 0 }),
        mobile: Object.assign({}, defaultSurface('mobile'), { updatedAt: ts }),
      },
    };
  }

  function migrateV3ToV4(raw) {
    var rawTheme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
    var topTs = isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) >= 0 ? Math.round(Number(raw.updatedAt)) : 0;
    var themeTs = isFinite(Number(raw.themeUpdatedAt)) && Number(raw.themeUpdatedAt) >= 0 ? Math.round(Number(raw.themeUpdatedAt)) : topTs;
    var termTs = isFinite(Number(raw.terminalUpdatedAt)) && Number(raw.terminalUpdatedAt) >= 0 ? Math.round(Number(raw.terminalUpdatedAt)) : topTs;
    var activeProf = getDeviceProfileKey();
    var profiles = ['native', 'web', 'mobile'];
    var themesOut = {};
    for (var i = 0; i < profiles.length; i++) {
      var prof = profiles[i];
      themesOut[prof] = {
        updatedAt: prof === activeProf ? themeTs : 0,
        mode: rawTheme.mode,
        themeId: rawTheme.themeId,
        lightThemeId: rawTheme.lightThemeId,
        darkThemeId: rawTheme.darkThemeId,
        accentOverride: rawTheme.accentOverride,
      };
    }
    return {
      version: 4,
      updatedAt: Math.max(topTs, themeTs, termTs),
      customThemesUpdatedAt: themeTs,
      terminalUpdatedAt: termTs,
      customThemes: Array.isArray(rawTheme.customThemes) ? rawTheme.customThemes : [],
      themes: themesOut,
      terminal: raw.terminal,
      surfaces: raw.surfaces,
    };
  }

  function sanitizeThemeSlot(rawSlot, baseSlot, customThemes) {
    var base = baseSlot || defaultThemeSlot();
    var input = rawSlot && typeof rawSlot === 'object' ? rawSlot : {};
    var ts = Number(input.updatedAt);
    return {
      updatedAt: isFinite(ts) && ts >= 0 ? Math.round(ts) : (base.updatedAt || 0),
      mode: input.mode === 'system' ? 'system' : (input.mode === 'manual' ? 'manual' : base.mode),
      themeId: resolveThemeIdInState(input.themeId || base.themeId, customThemes),
      lightThemeId: resolveThemeIdInState(input.lightThemeId || base.lightThemeId, customThemes),
      darkThemeId: resolveThemeIdInState(input.darkThemeId || base.darkThemeId, customThemes),
      accentOverride: 'accentOverride' in input
        ? (input.accentOverride === null || input.accentOverride === '' ? null : normalizeHex(input.accentOverride))
        : base.accentOverride,
    };
  }

  function sanitizeState(raw, fallback) {
    var base = fallback && fallback.surfaces && fallback.themes ? fallback : defaultState();
    var input = isLegacyFlatState(raw)
      ? migrateV3ToV4(migrateV2ToV3(raw))
      : (isLegacyV3State(raw) ? migrateV3ToV4(raw) : (raw && typeof raw === 'object' ? raw : {}));
    var out = defaultState();

    var customTs = Number(input.customThemesUpdatedAt);
    out.customThemesUpdatedAt = isFinite(customTs) && customTs >= 0 ? Math.round(customTs) : (base.customThemesUpdatedAt || 0);
    var customList = Array.isArray(input.customThemes) ? input.customThemes : base.customThemes;
    var cleanCustoms = [];
    var seenIds = {};
    if (Array.isArray(customList)) {
      for (var i = 0; i < customList.length; i++) {
        var cleaned = sanitizeCustomThemeInput(customList[i], null);
        if (!cleaned || seenIds[cleaned.id]) continue;
        seenIds[cleaned.id] = true;
        cleanCustoms.push(cleaned);
        if (cleanCustoms.length >= MAX_CUSTOM_THEMES) break;
      }
    }
    out.customThemes = cleanCustoms;

    var inThemes = input.themes && typeof input.themes === 'object' ? input.themes : {};
    var baseThemes = base.themes || out.themes;
    var profiles = ['native', 'web', 'mobile'];
    var maxThemeTs = 0;
    for (var t = 0; t < profiles.length; t++) {
      var tProf = profiles[t];
      out.themes[tProf] = sanitizeThemeSlot(inThemes[tProf], baseThemes[tProf], cleanCustoms);
      if (out.themes[tProf].updatedAt > maxThemeTs) maxThemeTs = out.themes[tProf].updatedAt;
    }

    var inTerm = input.terminal && typeof input.terminal === 'object' ? input.terminal : {};
    var baseTerm = base.terminal || out.terminal;
    var termTs = Number(input.terminalUpdatedAt);
    out.terminalUpdatedAt = isFinite(termTs) && termTs >= 0 ? Math.round(termTs) : (base.terminalUpdatedAt || 0);
    var validCursors = { block: true, bar: true, underline: true };
    out.terminal.fontSize = clampInt(inTerm.fontSize, 10, 22, baseTerm.fontSize);
    out.terminal.lineHeight = clampFloat(inTerm.lineHeight, 1.0, 1.8, 0.05, baseTerm.lineHeight);
    out.terminal.cursorStyle = validCursors[inTerm.cursorStyle] ? inTerm.cursorStyle : baseTerm.cursorStyle;
    out.terminal.cursorBlink = typeof inTerm.cursorBlink === 'boolean' ? inTerm.cursorBlink : baseTerm.cursorBlink;
    out.terminal.panePadding = clampInt(inTerm.panePadding, 0, 16, baseTerm.panePadding);
    out.terminal.inactivePaneDim = clampInt(inTerm.inactivePaneDim, 0, 45, baseTerm.inactivePaneDim);

    var inSurfaces = input.surfaces && typeof input.surfaces === 'object' ? input.surfaces : {};
    var baseSurfaces = base.surfaces || out.surfaces;
    var maxSurfTs = 0;
    for (var p = 0; p < profiles.length; p++) {
      var prof = profiles[p];
      out.surfaces[prof] = sanitizeSurface(prof, inSurfaces[prof], baseSurfaces[prof]);
      if (out.surfaces[prof].updatedAt > maxSurfTs) maxSurfTs = out.surfaces[prof].updatedAt;
    }

    var topTs = Number(input.updatedAt);
    out.updatedAt = Math.max(
      isFinite(topTs) && topTs >= 0 ? Math.round(topTs) : 0,
      base.updatedAt || 0,
      out.customThemesUpdatedAt,
      out.terminalUpdatedAt,
      maxThemeTs,
      maxSurfTs
    );
    return out;
  }

  function resolveThemeIdInState(themeId, customThemes) {
    if (typeof themeId !== 'string') return DEFAULT_THEME;
    var id = Object.prototype.hasOwnProperty.call(THEME_ALIASES, themeId) ? THEME_ALIASES[themeId] : themeId;
    if (Object.prototype.hasOwnProperty.call(themes, id)) return id;
    if (Array.isArray(customThemes)) {
      for (var i = 0; i < customThemes.length; i++) {
        if (customThemes[i].id === id) return id;
      }
    }
    return DEFAULT_THEME;
  }

  function readLegacyOnceState() {
    var st = defaultState();
    try {
      var savedTheme = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (savedTheme) st.themes[getDeviceProfileKey()].themeId = resolveThemeIdInState(savedTheme, st.customThemes);
      var savedTrans = localStorage.getItem(LEGACY_TRANSPARENCY_KEY);
      var tVal = clampTransparency(savedTrans);
      st.surfaces.native.transparency = tVal;
      if (supportsTransparency() && tVal > 0) {
        st.surfaces.native.mode = 'desktop';
      }
      var savedGlass = localStorage.getItem(LEGACY_GLASS_KEY);
      st.surfaces.native.glassIntensity = savedGlass === null ? 100 : clampGlassIntensity(savedGlass);
    } catch (_e) {}
    return st;
  }

  function loadInitialState() {
    try {
      var rawV4 = localStorage.getItem(APPEARANCE_KEY);
      if (rawV4) {
        return sanitizeState(JSON.parse(rawV4), defaultState());
      }
      var rawV3 = localStorage.getItem(V3_APPEARANCE_KEY);
      if (rawV3) {
        return sanitizeState(JSON.parse(rawV3), defaultState());
      }
      var rawV2 = localStorage.getItem(V2_APPEARANCE_KEY);
      if (rawV2) {
        return sanitizeState(JSON.parse(rawV2), defaultState());
      }
    } catch (_e) {}
    return readLegacyOnceState();
  }

  var state = loadInitialState();
  var previewThemeId = null;
  var customWallpapers = [];
  var saveServerTimer = null;
  var customWallpaperMap = {};
  var compiledCustomCache = {};
  var systemSchemeMedia = null;

  function activeTheme() {
    return state.themes[getDeviceProfileKey()] || state.themes.web;
  }

  function activeSurface() {
    return state.surfaces[getDeviceProfileKey()] || state.surfaces.web;
  }

  function rebuildCustomCaches() {
    customWallpaperMap = {};
    for (var i = 0; i < customWallpapers.length; i++) {
      customWallpaperMap[customWallpapers[i].id] = customWallpapers[i];
    }
    compiledCustomCache = {};
    for (var j = 0; j < state.customThemes.length; j++) {
      var ct = state.customThemes[j];
      compiledCustomCache[ct.id] = compileTheme({
        id: ct.id,
        name: ct.name,
        description: ct.description,
        defaultWallpaper: 'obsidian-topo',
        ui: ct.ui,
        terminal: ct.terminal,
        isCustom: true,
      }, null);
    }
  }
  rebuildCustomCaches();

  function persistLocal() {
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(state));
    } catch (_e) {}
  }

  function dispatchEventSafe(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, detail ? { detail: detail } : undefined));
    } catch (_e) {}
  }

  function isSystemLight() {
    if (!systemSchemeMedia && typeof window.matchMedia === 'function') {
      try { systemSchemeMedia = window.matchMedia('(prefers-color-scheme: light)'); }
      catch (_e) { systemSchemeMedia = null; }
    }
    return Boolean(systemSchemeMedia && systemSchemeMedia.matches);
  }

  function resolveThemeId(themeId) {
    return resolveThemeIdInState(themeId, state.customThemes);
  }

  function getRawThemeEntry(themeId) {
    var id = resolveThemeId(themeId);
    if (Object.prototype.hasOwnProperty.call(themes, id)) return themes[id];
    if (Object.prototype.hasOwnProperty.call(compiledCustomCache, id)) return compiledCustomCache[id];
    return themes[DEFAULT_THEME];
  }

  function getCompiledTheme(themeId, includeAccent) {
    var entry = getRawThemeEntry(themeId);
    var accent = activeTheme().accentOverride;
    if (!includeAccent || !accent) return entry;
    return compileTheme(entry.raw, accent);
  }

  function getCurrent() {
    var th = activeTheme();
    if (th.mode === 'system') {
      return resolveThemeId(isSystemLight() ? th.lightThemeId : th.darkThemeId);
    }
    return resolveThemeId(th.themeId);
  }

  function getEffectiveThemeId() {
    return previewThemeId !== null ? previewThemeId : getCurrent();
  }

  function getBuiltInWallpaperById(id) {
    for (var i = 0; i < BUILT_IN_WALLPAPERS.length; i++) {
      if (BUILT_IN_WALLPAPERS[i].id === id) return BUILT_IN_WALLPAPERS[i];
    }
    return null;
  }

  function getResolvedWallpaperId(themeId) {
    var surf = activeSurface();
    if (surf.mode !== 'wallpaper') return null;
    if (surf.wallpaperSource === 'follow' || (!surf.wallpaperId && surf.wallpaperSource !== 'custom')) {
      var entry = getRawThemeEntry(themeId || getEffectiveThemeId());
      if (entry.defaultWallpaper && getBuiltInWallpaperById(entry.defaultWallpaper)) {
        return entry.defaultWallpaper;
      }
      return entry.colorScheme === 'light' ? 'zen-silk' : 'obsidian-topo';
    }
    if (surf.wallpaperSource === 'builtin') {
      return getBuiltInWallpaperById(surf.wallpaperId)
        ? surf.wallpaperId
        : getRawThemeEntry(themeId || getEffectiveThemeId()).defaultWallpaper;
    }
    if (surf.wallpaperSource === 'custom' && surf.wallpaperId) {
      return surf.wallpaperId;
    }
    return null;
  }

  function appendAuthToken(url) {
    try {
      if (window.Auth && typeof window.Auth.getToken === 'function') {
        var token = window.Auth.getToken();
        if (token) return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
      }
    } catch (_e) {}
    return url;
  }

  function getResolvedWallpaperUrl(themeId) {
    var surf = activeSurface();
    if (surf.mode !== 'wallpaper') return null;
    if (surf.wallpaperSource === 'custom' && surf.wallpaperId) {
      if (customWallpaperMap[surf.wallpaperId] || /^wp-[a-f0-9]{16}\.(png|jpg|webp|avif|gif)$/.test(surf.wallpaperId)) {
        return appendAuthToken('/api/appearance/wallpapers/' + encodeURIComponent(surf.wallpaperId));
      }
      return null;
    }
    var id = getResolvedWallpaperId(themeId);
    var item = id ? getBuiltInWallpaperById(id) : null;
    return item ? item.url : null;
  }

  function isWallpaperActive() {
    var surf = activeSurface();
    return surf.mode === 'wallpaper' && Boolean(getResolvedWallpaperUrl());
  }

  function getTransparency() {
    var surf = activeSurface();
    return supportsTransparency() && surf.mode === 'desktop' ? surf.transparency : 0;
  }

  function isBackdropActive() {
    var surf = activeSurface();
    var nativeDesktop = supportsTransparency() && surf.mode === 'desktop' && getTransparency() > 0;
    return nativeDesktop || isWallpaperActive();
  }

  function ensureBackdropElement() {
    var doc = document;
    var existing = doc.getElementById('anymux-wallpaper-backdrop');
    if (existing) return existing;
    if (!doc.body) {
      if (!ensureBackdropElement._queued) {
        ensureBackdropElement._queued = true;
        doc.addEventListener('DOMContentLoaded', function () {
          ensureBackdropElement._queued = false;
          applyVisualBackdrop(getEffectiveThemeId());
        }, { once: true });
      }
      return null;
    }
    var wrap = doc.createElement('div');
    wrap.id = 'anymux-wallpaper-backdrop';
    wrap.className = 'anymux-wallpaper-backdrop';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.hidden = true;

    var img = doc.createElement('div');
    img.className = 'anymux-wp-image';
    var scrim = doc.createElement('div');
    scrim.className = 'anymux-wp-scrim';
    var noise = doc.createElement('div');
    noise.className = 'anymux-wp-noise';

    wrap.appendChild(img);
    wrap.appendChild(scrim);
    wrap.appendChild(noise);
    doc.body.insertBefore(wrap, doc.body.firstChild);
    return wrap;
  }

  function applyVisualBackdrop(themeId) {
    var root = document.documentElement;
    var targetTheme = themeId || getEffectiveThemeId();
    var activeTheme = getCompiledTheme(targetTheme, true);
    var surf = activeSurface();
    var amount = getTransparency();
    var wpActive = isWallpaperActive();
    var nativeTrans = supportsTransparency() && surf.mode === 'desktop' && amount > 0;
    var backdropActive = nativeTrans || wpActive;

    root.toggleAttribute('data-native-transparency', nativeTrans);
    root.toggleAttribute('data-wallpaper-active', wpActive);
    root.toggleAttribute('data-backdrop-active', backdropActive);

    var bgHex = activeTheme.ui['--bg-primary'];
    var bgRgb = rgb(bgHex);
    root.style.setProperty('--native-window-background', 'rgba(' + bgRgb.join(', ') + ', ' + (1 - amount / 100) + ')');

    var typo = state.terminal;
    var combinedBrightness = Math.round((surf.wallpaperBrightness * surf.brightness) / 100);
    root.style.setProperty('--anymux-wp-blur', surf.blurRadius + 'px');
    root.style.setProperty('--anymux-wp-saturate', surf.saturation + '%');
    root.style.setProperty('--anymux-wp-brightness', combinedBrightness + '%');
    root.style.setProperty('--anymux-wp-scrim', 'rgba(' + bgRgb.join(', ') + ', ' + (surf.terminalTint / 100).toFixed(3) + ')');
    root.style.setProperty('--anymux-wp-noise-opacity', (surf.noiseOpacity / 100).toFixed(3));
    root.style.setProperty('--anymux-sidebar-alpha', surf.sidebarTint + '%');
    root.style.setProperty('--anymux-sidebar-blur', Math.round(surf.blurRadius * 0.65) + 'px');
    root.style.setProperty('--anymux-float-blur', Math.max(12, Math.min(36, Math.round(surf.blurRadius * 1.1))) + 'px');
    root.style.setProperty('--anymux-pane-inactive-dim', typo.inactivePaneDim + '%');
    root.style.setProperty('--terminal-pane-padding', typo.panePadding + 'px');

    var backdrop = ensureBackdropElement();
    if (backdrop) {
      var imgEl = backdrop.querySelector('.anymux-wp-image');
      if (wpActive) {
        var url = getResolvedWallpaperUrl(targetTheme);
        backdrop.hidden = false;
        if (imgEl) {
          imgEl.style.backgroundImage = url ? 'url("' + url.replace(/"/g, '%22') + '")' : 'none';
          imgEl.style.backgroundSize = surf.wallpaperFit === 'fill'
            ? '100% 100%'
            : (surf.wallpaperFit === 'contain' ? 'contain' : 'cover');
        }
      } else {
        backdrop.hidden = true;
        if (imgEl) imgEl.style.backgroundImage = 'none';
      }
    }
  }

  function applyNativeAppearance(forceRich) {
    if (!supportsGlassIntensity()) return;
    var handler = appearanceHandler();
    try {
      var surf = state.surfaces.native;
      if (hasRichNativeEngine() || forceRich === true) {
        var activeTheme = getCompiledTheme(getEffectiveThemeId(), true);
        var nativeMode = (surf.mode === 'desktop' && surf.transparency > 0) ? 'desktop' : 'none';
        var engine = surf.nativeEngine;
        if ((engine === 'liquid-regular' || engine === 'liquid-clear') && !supportsLiquidGlass()) {
          engine = 'material';
        }
        handler.postMessage({
          glassIntensity: surf.glassIntensity,
          mode: nativeMode,
          engine: engine,
          blurRadius: surf.blurRadius,
          saturation: Number((surf.saturation / 100).toFixed(2)),
          brightness: Number(((surf.brightness - 100) / 100).toFixed(2)),
          tintHex: activeTheme.ui['--bg-primary'],
          tintAlpha: Number(((100 - surf.transparency) / 100).toFixed(2)),
          colorScheme: activeTheme.colorScheme,
        });
      } else {
        handler.postMessage({ glassIntensity: surf.glassIntensity });
      }
    } catch (_e) {}
  }

  function applyThemeInternal(themeId, options) {
    var opts = options || {};
    var resolved = resolveThemeId(themeId);
    var t = getCompiledTheme(resolved, true);

    var root = document.documentElement;
    var ui = t.ui;
    for (var key in ui) {
      if (Object.prototype.hasOwnProperty.call(ui, key)) {
        root.style.setProperty(key, ui[key]);
      }
    }

    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = t.colorScheme;
    root.setAttribute('data-color-scheme', t.colorScheme);
    applyVisualBackdrop(resolved);

    if (opts.persist !== false) {
      var now = Date.now();
      var th = activeTheme();
      if (!opts.keepMode) th.mode = 'manual';
      th.themeId = resolved;
      if (opts.bump !== false) {
        th.updatedAt = now;
        state.updatedAt = now;
      }
      persistLocal();
      if (opts.sync !== false) scheduleServerSave();
    }

    if (hasRichNativeEngine() && opts.notifyNative !== false) {
      applyNativeAppearance(false);
    }

    dispatchEventSafe('tmux-theme-change', { themeId: resolved, preview: Boolean(opts.preview) });
    if (opts.announceAppearance) dispatchEventSafe('anymux-appearance-change');
  }

  function apply(themeId, options) {
    var opts = options || {};
    var resolved = resolveThemeId(themeId);
    previewThemeId = null;
    var persist = opts.persist !== false;
    if (persist) {
      var th = activeTheme();
      if (opts.keepMode !== true && th.mode === 'system') {
        th.mode = 'manual';
      }
      th.themeId = resolved;
      var now = Date.now();
      th.updatedAt = now;
      state.updatedAt = now;
    }
    applyThemeInternal(resolved, {
      persist: persist,
      keepMode: opts.keepMode,
      bump: false,
      sync: opts.sync !== false,
      announceAppearance: opts.announceAppearance !== false,
    });
  }

  function previewTheme(themeId) {
    var resolved = resolveThemeId(themeId);
    previewThemeId = resolved;
    applyThemeInternal(resolved, {
      persist: false,
      sync: false,
      announceAppearance: false,
      preview: true,
    });
  }

  function clearPreview() {
    if (previewThemeId === null) return;
    previewThemeId = null;
    applyThemeInternal(getCurrent(), {
      persist: false,
      sync: false,
      announceAppearance: false,
    });
  }

  function getGlassIntensity() {
    return activeSurface().glassIntensity;
  }

  function setGlassIntensity(value) {
    if (!supportsGlassIntensity()) return;
    var surf = state.surfaces.native;
    surf.glassIntensity = clampGlassIntensity(value);
    var now = Date.now();
    surf.updatedAt = now;
    state.updatedAt = now;
    persistLocal();
    applyNativeAppearance(false);
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('anymux-appearance-change');
  }

  function setTransparency(value) {
    if (!supportsTransparency()) return;
    var next = clampTransparency(value);
    var surf = state.surfaces.native;
    surf.transparency = next;
    surf.mode = next > 0 ? 'desktop' : 'solid';
    var now = Date.now();
    surf.updatedAt = now;
    state.updatedAt = now;
    persistLocal();
    applyVisualBackdrop(getEffectiveThemeId());
    if (hasRichNativeEngine()) applyNativeAppearance(false);
    scheduleServerSave();
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
    dispatchEventSafe('anymux-appearance-change');
  }

  function applyWebPresetValues(surf, preset) {
    surf.webPreset = preset.id;
    surf.blurRadius = preset.blurRadius;
    surf.saturation = preset.saturation;
    surf.brightness = preset.brightness;
    surf.noiseOpacity = preset.noiseOpacity;
    surf.sidebarTint = preset.sidebarTint;
    surf.terminalTint = preset.terminalTint;
  }

  function setSurface(patch) {
    if (!patch || typeof patch !== 'object') return;
    var profile = getDeviceProfileKey();
    var surf = activeSurface();
    var prevMode = surf.mode;

    if ('mode' in patch) {
      if (patch.mode === 'desktop' && !supportsTransparency()) return;
      if (patch.mode === 'solid' || patch.mode === 'wallpaper' || (patch.mode === 'desktop' && profile === 'native')) {
        surf.mode = patch.mode;
      }
    }
    if ('wallpaperSource' in patch && { follow: true, builtin: true, custom: true }[patch.wallpaperSource]) {
      surf.wallpaperSource = patch.wallpaperSource;
    }
    if ('wallpaperId' in patch) {
      surf.wallpaperId = patch.wallpaperId || null;
      if (surf.wallpaperId && !('wallpaperSource' in patch)) {
        surf.wallpaperSource = /^wp-[a-f0-9]{16}\./.test(surf.wallpaperId) ? 'custom' : 'builtin';
      }
    }
    if ({ cover: true, contain: true, fill: true }[patch.wallpaperFit]) {
      surf.wallpaperFit = patch.wallpaperFit;
    }
    if ('wallpaperBrightness' in patch) {
      surf.wallpaperBrightness = clampInt(patch.wallpaperBrightness, 40, 130, surf.wallpaperBrightness);
    }

    var webSliderTouched = false;
    if ('blurRadius' in patch) {
      surf.blurRadius = clampInt(patch.blurRadius, 0, 48, surf.blurRadius);
      webSliderTouched = true;
    }
    if ('saturation' in patch) {
      surf.saturation = clampInt(patch.saturation, 60, 200, surf.saturation);
      webSliderTouched = true;
    }
    if ('brightness' in patch) {
      surf.brightness = clampInt(patch.brightness, 75, 125, surf.brightness);
      webSliderTouched = true;
    }
    if ('noiseOpacity' in patch) {
      surf.noiseOpacity = clampInt(patch.noiseOpacity, 0, 18, surf.noiseOpacity);
      webSliderTouched = true;
    }
    if ('sidebarTint' in patch) {
      surf.sidebarTint = clampInt(patch.sidebarTint, 0, 85, surf.sidebarTint);
      webSliderTouched = true;
    }
    if ('terminalTint' in patch) {
      surf.terminalTint = clampInt(patch.terminalTint, 20, 95, surf.terminalTint);
      webSliderTouched = true;
    }
    if (patch.webPreset && WEB_PRESETS[patch.webPreset]) {
      applyWebPresetValues(surf, WEB_PRESETS[patch.webPreset]);
    } else if (webSliderTouched && surf.mode === 'wallpaper') {
      surf.webPreset = 'custom';
    }

    if (patch.nativeEngine && { material: true, 'liquid-regular': true, 'liquid-clear': true, system: true }[patch.nativeEngine]) {
      var nextEngine = patch.nativeEngine;
      if ((nextEngine === 'liquid-regular' || nextEngine === 'liquid-clear') && !supportsLiquidGlass()) {
        nextEngine = 'material';
      }
      surf.nativeEngine = nextEngine;
    }
    if ('transparency' in patch && supportsTransparency()) {
      surf.transparency = clampTransparency(patch.transparency);
    }
    if ('glassIntensity' in patch && supportsGlassIntensity()) {
      surf.glassIntensity = clampGlassIntensity(patch.glassIntensity);
    }

    if (surf.mode === 'desktop' && surf.transparency <= 0 && supportsTransparency()) {
      surf.transparency = 25;
    }
    if (surf.mode !== 'wallpaper' || surf.wallpaperSource === 'follow') {
      surf.wallpaperId = null;
    }
    if (surf.mode !== 'wallpaper' && surf.mode !== prevMode && surf.mode === 'solid') {
      surf.wallpaperSource = 'follow';
    }

    var now = Date.now();
    surf.updatedAt = now;
    state.updatedAt = now;
    persistLocal();
    applyVisualBackdrop(getEffectiveThemeId());
    if (supportsGlassIntensity()) {
      applyNativeAppearance(hasRichNativeEngine() || surf.mode === 'desktop');
    }
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
    dispatchEventSafe('anymux-appearance-change');
  }

  function applyWebPreset(presetId) {
    var preset = WEB_PRESETS[presetId];
    if (!preset) return;
    setSurface({ webPreset: preset.id });
  }

  function setWallpaper(patch) {
    if (!patch || typeof patch !== 'object') return;
    var mapped = {};
    if ('mode' in patch) {
      if (patch.mode === 'none') {
        mapped.mode = 'solid';
        mapped.wallpaperSource = 'follow';
        mapped.wallpaperId = null;
      } else if (patch.mode === 'desktop') {
        if (!supportsTransparency()) return;
        mapped.mode = 'desktop';
        mapped.wallpaperId = null;
      } else if (patch.mode === 'builtin') {
        mapped.mode = 'wallpaper';
        if (!('followTheme' in patch)) {
          mapped.wallpaperSource = patch.id ? 'builtin' : 'follow';
        }
      } else if (patch.mode === 'custom') {
        mapped.mode = 'wallpaper';
        mapped.wallpaperSource = 'custom';
      }
    }
    if ('id' in patch) {
      mapped.wallpaperId = patch.id || null;
      if (!patch.id && !('followTheme' in patch) && mapped.mode === 'wallpaper') {
        mapped.wallpaperSource = 'follow';
      }
    }
    if (typeof patch.followTheme === 'boolean') {
      mapped.wallpaperSource = patch.followTheme ? 'follow' : (patch.id ? (/^wp-[a-f0-9]{16}\./.test(patch.id) ? 'custom' : 'builtin') : 'builtin');
      if (patch.followTheme) mapped.wallpaperId = null;
    }
    if ('fit' in patch) mapped.wallpaperFit = patch.fit;
    if ('brightness' in patch) mapped.wallpaperBrightness = patch.brightness;
    setSurface(mapped);
  }

  function setGlass(patch) {
    if (!patch || typeof patch !== 'object') return;
    if ('inactivePaneDim' in patch) {
      setTerminalTypography({ inactivePaneDim: patch.inactivePaneDim });
    }
    var mapped = {};
    ['blurRadius', 'saturation', 'brightness', 'noiseOpacity', 'sidebarTint', 'terminalTint', 'nativeEngine', 'transparency', 'glassIntensity'].forEach(function (k) {
      if (k in patch) mapped[k] = patch[k];
    });
    if (patch.preset && WEB_PRESETS[patch.preset]) mapped.webPreset = patch.preset;
    if (Object.keys(mapped).length) setSurface(mapped);
  }

  function setTerminalTypography(patch) {
    if (!patch || typeof patch !== 'object') return;
    var typo = state.terminal;
    if ('fontSize' in patch) typo.fontSize = clampInt(patch.fontSize, 10, 22, typo.fontSize);
    if ('lineHeight' in patch) typo.lineHeight = clampFloat(patch.lineHeight, 1.0, 1.8, 0.05, typo.lineHeight);
    if ({ block: true, bar: true, underline: true }[patch.cursorStyle]) typo.cursorStyle = patch.cursorStyle;
    if (typeof patch.cursorBlink === 'boolean') typo.cursorBlink = patch.cursorBlink;
    if ('panePadding' in patch) typo.panePadding = clampInt(patch.panePadding, 0, 16, typo.panePadding);
    if ('inactivePaneDim' in patch) typo.inactivePaneDim = clampInt(patch.inactivePaneDim, 0, 45, typo.inactivePaneDim);

    var now = Date.now();
    state.terminalUpdatedAt = now;
    state.updatedAt = now;
    persistLocal();
    document.documentElement.style.setProperty('--terminal-pane-padding', typo.panePadding + 'px');
    document.documentElement.style.setProperty('--anymux-pane-inactive-dim', typo.inactivePaneDim + '%');
    scheduleServerSave();
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
    dispatchEventSafe('anymux-appearance-change');
  }

  function setThemeMode(mode) {
    var next = mode === 'system' ? 'system' : 'manual';
    var th = activeTheme();
    if (th.mode === next) return;
    previewThemeId = null;
    th.mode = next;
    var now = Date.now();
    th.updatedAt = now;
    state.updatedAt = now;
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: false, announceAppearance: true });
  }

  function setLightThemeId(id) {
    var th = activeTheme();
    th.lightThemeId = resolveThemeId(id);
    var now = Date.now();
    th.updatedAt = now;
    state.updatedAt = now;
    if (th.mode === 'system') {
      applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: false, announceAppearance: true });
    } else {
      persistLocal();
      scheduleServerSave();
      dispatchEventSafe('anymux-appearance-change');
    }
  }

  function setDarkThemeId(id) {
    var th = activeTheme();
    th.darkThemeId = resolveThemeId(id);
    var now = Date.now();
    th.updatedAt = now;
    state.updatedAt = now;
    if (th.mode === 'system') {
      applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: false, announceAppearance: true });
    } else {
      persistLocal();
      scheduleServerSave();
      dispatchEventSafe('anymux-appearance-change');
    }
  }

  function setAccentOverride(value) {
    var th = activeTheme();
    th.accentOverride = value ? normalizeHex(value) : null;
    var now = Date.now();
    th.updatedAt = now;
    state.updatedAt = now;
    applyThemeInternal(getEffectiveThemeId(), { persist: true, keepMode: true, bump: false, announceAppearance: true });
  }

  function importThemeJson(input) {
    var parsed = typeof input === 'string' ? JSON.parse(input) : input;
    var existingMap = {};
    Object.keys(themes).forEach(function (id) { existingMap[id] = true; });
    state.customThemes.forEach(function (t) { existingMap[t.id] = true; });

    var cleaned = sanitizeCustomThemeInput(parsed, existingMap);
    if (!cleaned) {
      throw new Error('无效的主题 JSON：需要提供 name 以及 terminal (background + foreground) 或 ui (--bg-primary + --text-primary)');
    }
    if (state.customThemes.length >= MAX_CUSTOM_THEMES) {
      throw new Error('最多保存 ' + MAX_CUSTOM_THEMES + ' 个自定义主题');
    }
    state.customThemes.push(cleaned);
    rebuildCustomCaches();
    previewThemeId = null;
    var th = activeTheme();
    th.mode = 'manual';
    th.themeId = cleaned.id;
    var now = Date.now();
    state.customThemesUpdatedAt = now;
    th.updatedAt = now;
    state.updatedAt = now;
    applyThemeInternal(cleaned.id, { persist: true, keepMode: true, bump: false, announceAppearance: true });
    return getThemeList().filter(function (item) { return item.id === cleaned.id; })[0];
  }

  function exportThemeJson(themeId) {
    var currentId = getEffectiveThemeId();
    var entry = getCompiledTheme(themeId || currentId, !themeId || themeId === currentId);
    return JSON.stringify({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      colorScheme: entry.colorScheme,
      ui: cloneObj(entry.ui),
      terminal: cloneObj(entry.terminal),
    }, null, 2);
  }

  function deleteCustomTheme(id) {
    var next = state.customThemes.filter(function (t) { return t.id !== id; });
    if (next.length === state.customThemes.length) return false;
    var now = Date.now();
    state.customThemes = next;
    state.customThemesUpdatedAt = now;
    rebuildCustomCaches();
    var profiles = ['native', 'web', 'mobile'];
    var activeProf = getDeviceProfileKey();
    for (var i = 0; i < profiles.length; i++) {
      var prof = profiles[i];
      var slot = state.themes[prof];
      var touched = false;
      if (slot.themeId === id) { slot.themeId = DEFAULT_THEME; touched = true; }
      if (slot.lightThemeId === id) { slot.lightThemeId = 'oyster'; touched = true; }
      if (slot.darkThemeId === id) { slot.darkThemeId = DEFAULT_THEME; touched = true; }
      if (touched && prof === activeProf) slot.updatedAt = now;
    }
    state.updatedAt = now;
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: false, announceAppearance: true });
    return true;
  }

  function resetAppearance() {
    var fresh = defaultState();
    var now = Date.now();
    var profile = getDeviceProfileKey();
    state.themes[profile] = defaultThemeSlot();
    state.themes[profile].updatedAt = now;
    state.terminal = fresh.terminal;
    state.surfaces[profile] = defaultSurface(profile);
    state.surfaces[profile].updatedAt = now;
    state.terminalUpdatedAt = now;
    state.updatedAt = now;
    previewThemeId = null;
    rebuildCustomCaches();
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: false, announceAppearance: true });
    if (supportsGlassIntensity()) applyNativeAppearance(hasRichNativeEngine());
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
  }

  function getSnapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function restoreSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state = sanitizeState(snap, defaultState());
    previewThemeId = null;
    rebuildCustomCaches();
    persistLocal();
    applyThemeInternal(getCurrent(), { persist: false, announceAppearance: false });
    if (supportsGlassIntensity()) applyNativeAppearance(hasRichNativeEngine());
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
    dispatchEventSafe('anymux-appearance-change');
  }

  function getOpaqueTerminalTheme(themeId) {
    var id = resolveThemeId(themeId || getEffectiveThemeId());
    var t = getCompiledTheme(id, !themeId || themeId === getEffectiveThemeId()).terminal;
    return cloneObj(t);
  }

  function getColorScheme(themeId) {
    var id = resolveThemeId(themeId || getEffectiveThemeId());
    return getCompiledTheme(id, !themeId || themeId === getEffectiveThemeId()).colorScheme;
  }

  function getTerminalTheme(themeId) {
    var copy = getOpaqueTerminalTheme(themeId);
    if (isBackdropActive()) copy.background = 'rgba(0, 0, 0, 0)';
    return copy;
  }

  function getThemeList() {
    var list = [];
    function pushEntry(entry) {
      list.push({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        colorScheme: entry.colorScheme,
        defaultWallpaper: entry.defaultWallpaper,
        isCustom: Boolean(entry.isCustom),
        colors: cloneObj(entry.ui),
        terminal: cloneObj(entry.terminal),
      });
    }
    Object.keys(themes).forEach(function (id) { pushEntry(themes[id]); });
    state.customThemes.forEach(function (ct) {
      if (compiledCustomCache[ct.id]) pushEntry(compiledCustomCache[ct.id]);
    });
    return list;
  }

  function getName(themeId) {
    return getRawThemeEntry(themeId || getEffectiveThemeId()).name;
  }

  function getSurface() {
    return cloneObj(activeSurface());
  }

  function getWallpaper() {
    var surf = activeSurface();
    var mode = 'none';
    if (surf.mode === 'desktop') mode = 'desktop';
    else if (surf.mode === 'wallpaper') mode = surf.wallpaperSource === 'custom' ? 'custom' : 'builtin';
    return {
      mode: mode,
      id: surf.wallpaperId,
      followTheme: surf.wallpaperSource === 'follow',
      fit: surf.wallpaperFit,
      brightness: surf.wallpaperBrightness,
    };
  }

  function getGlass() {
    var surf = activeSurface();
    return {
      preset: surf.webPreset,
      nativeEngine: surf.nativeEngine,
      transparency: surf.transparency,
      glassIntensity: surf.glassIntensity,
      blurRadius: surf.blurRadius,
      saturation: surf.saturation,
      brightness: surf.brightness,
      noiseOpacity: surf.noiseOpacity,
      sidebarTint: surf.sidebarTint,
      terminalTint: surf.terminalTint,
      inactivePaneDim: state.terminal.inactivePaneDim,
    };
  }

  function getTerminalTypography() {
    return cloneObj(state.terminal);
  }

  function getBuiltInWallpapers() {
    return BUILT_IN_WALLPAPERS.map(function (item) {
      return Object.assign({}, item, { themes: item.themes.slice() });
    });
  }

  function getCustomWallpapers() {
    return customWallpapers.map(function (item) {
      return Object.assign({}, item, { url: appendAuthToken('/api/appearance/wallpapers/' + encodeURIComponent(item.id)) });
    });
  }

  function exportStateForServer() {
    var profile = getDeviceProfileKey();
    var payload = {
      version: 4,
      updatedAt: state.updatedAt,
      customThemesUpdatedAt: state.customThemesUpdatedAt,
      terminalUpdatedAt: state.terminalUpdatedAt,
      customThemes: JSON.parse(JSON.stringify(state.customThemes)),
      terminal: cloneObj(state.terminal),
      themes: {},
      surfaces: {},
    };
    payload.themes[profile] = cloneObj(state.themes[profile] || defaultThemeSlot());
    payload.surfaces[profile] = cloneObj(state.surfaces[profile] || defaultSurface(profile));
    return payload;
  }

  function scheduleServerSave() {
    if (!window.Api || typeof window.Api.put !== 'function') return;
    if (saveServerTimer) clearTimeout(saveServerTimer);
    saveServerTimer = setTimeout(function () {
      saveServerTimer = null;
      saveToServer();
    }, 350);
  }

  function saveToServer() {
    if (!window.Api || typeof window.Api.put !== 'function') return Promise.resolve(null);
    return window.Api.put('/api/appearance', exportStateForServer()).catch(function () { return null; });
  }

  function syncFromServer() {
    if (!window.Api || typeof window.Api.get !== 'function') return Promise.resolve(null);
    return window.Api.get('/api/appearance').then(function (data) {
      if (!data || typeof data !== 'object') return null;
      if (Array.isArray(data.customWallpapers)) {
        customWallpapers = data.customWallpapers.slice();
        rebuildCustomCaches();
      }
      var rawRemote = data.config;
      if (rawRemote && typeof rawRemote === 'object') {
        var remote = sanitizeState(rawRemote, defaultState());
        var activeProf = getDeviceProfileKey();
        var customChanged = false;
        var activeThemeChanged = false;
        var anySlotUpdated = false;
        var termChanged = false;
        var activeSurfChanged = false;
        var pushNeeded = false;

        if ((remote.customThemesUpdatedAt || 0) > (state.customThemesUpdatedAt || 0)) {
          state.customThemes = JSON.parse(JSON.stringify(remote.customThemes));
          state.customThemesUpdatedAt = remote.customThemesUpdatedAt;
          customChanged = true;
          anySlotUpdated = true;
        } else if ((state.customThemesUpdatedAt || 0) > (remote.customThemesUpdatedAt || 0)) {
          pushNeeded = true;
        }

        var profiles = ['native', 'web', 'mobile'];
        for (var t = 0; t < profiles.length; t++) {
          var tProf = profiles[t];
          var rtTs = remote.themes[tProf].updatedAt || 0;
          var ltTs = state.themes[tProf].updatedAt || 0;
          if (rtTs > ltTs) {
            state.themes[tProf] = cloneObj(remote.themes[tProf]);
            anySlotUpdated = true;
            if (tProf === activeProf) activeThemeChanged = true;
          } else if (tProf === activeProf && ltTs > rtTs) {
            pushNeeded = true;
          }
        }

        var activeSlot = state.themes[activeProf];
        var nextThemeId = resolveThemeIdInState(activeSlot.themeId, state.customThemes);
        var nextLightId = resolveThemeIdInState(activeSlot.lightThemeId, state.customThemes);
        var nextDarkId = resolveThemeIdInState(activeSlot.darkThemeId, state.customThemes);
        if (nextThemeId !== activeSlot.themeId || nextLightId !== activeSlot.lightThemeId || nextDarkId !== activeSlot.darkThemeId) {
          activeSlot.themeId = nextThemeId;
          activeSlot.lightThemeId = nextLightId;
          activeSlot.darkThemeId = nextDarkId;
          activeThemeChanged = true;
          anySlotUpdated = true;
        }

        if ((remote.terminalUpdatedAt || 0) > (state.terminalUpdatedAt || 0)) {
          state.terminal = cloneObj(remote.terminal);
          state.terminalUpdatedAt = remote.terminalUpdatedAt;
          termChanged = true;
          anySlotUpdated = true;
        } else if ((state.terminalUpdatedAt || 0) > (remote.terminalUpdatedAt || 0)) {
          pushNeeded = true;
        }

        for (var i = 0; i < profiles.length; i++) {
          var prof = profiles[i];
          var rTs = remote.surfaces[prof].updatedAt || 0;
          var lTs = state.surfaces[prof].updatedAt || 0;
          if (rTs > lTs) {
            state.surfaces[prof] = cloneObj(remote.surfaces[prof]);
            anySlotUpdated = true;
            if (prof === activeProf) activeSurfChanged = true;
          } else if (prof === activeProf && lTs > rTs) {
            pushNeeded = true;
          }
        }
        state.updatedAt = Math.max(
          state.customThemesUpdatedAt,
          state.terminalUpdatedAt,
          state.themes.native.updatedAt,
          state.themes.web.updatedAt,
          state.themes.mobile.updatedAt,
          state.surfaces.native.updatedAt,
          state.surfaces.web.updatedAt,
          state.surfaces.mobile.updatedAt
        );

        if (customChanged || activeThemeChanged || termChanged || activeSurfChanged) {
          rebuildCustomCaches();
          persistLocal();
          applyThemeInternal(getCurrent(), { persist: false, announceAppearance: false });
          if (supportsGlassIntensity()) applyNativeAppearance(hasRichNativeEngine());
          dispatchEventSafe('tmux-glass-change');
          dispatchEventSafe('tmux-transparency-change');
          dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
          dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
          dispatchEventSafe('anymux-appearance-change');
        } else {
          if (anySlotUpdated) persistLocal();
          applyVisualBackdrop(getEffectiveThemeId());
          dispatchEventSafe('anymux-appearance-change');
        }
        if (pushNeeded && state.updatedAt > 0) saveToServer();
      }
      return data;
    }).catch(function () { return null; });
  }

  function uploadCustomWallpaper(file) {
    if (!file) return Promise.reject(new Error('请选择图片文件'));
    var form = new FormData();
    form.append('file', file);
    var headers = (window.Auth && typeof window.Auth.headers === 'function') ? window.Auth.headers() : {};
    return fetch('/api/appearance/wallpapers', {
      method: 'POST',
      headers: headers,
      body: form,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || body.success === false) {
          var errMsg = typeof body.error === 'string' ? body.error : (body.error && body.error.message);
          throw new Error(errMsg || ('上传失败 (' + res.status + ')'));
        }
        var payload = body.data || body;
        if (Array.isArray(payload.customWallpapers)) {
          customWallpapers = payload.customWallpapers.slice();
          rebuildCustomCaches();
        } else if (payload.wallpaper) {
          customWallpapers.unshift(payload.wallpaper);
          rebuildCustomCaches();
        }
        if (payload.wallpaper && payload.wallpaper.id) {
          setSurface({ mode: 'wallpaper', wallpaperSource: 'custom', wallpaperId: payload.wallpaper.id });
        }
        return payload.wallpaper;
      });
    });
  }

  function deleteCustomWallpaper(id) {
    if (!window.Api || typeof window.Api.del !== 'function') return Promise.resolve(null);
    return window.Api.del('/api/appearance/wallpapers/' + encodeURIComponent(id)).then(function (data) {
      if (data && Array.isArray(data.customWallpapers)) {
        customWallpapers = data.customWallpapers.slice();
        rebuildCustomCaches();
      } else {
        customWallpapers = customWallpapers.filter(function (item) { return item.id !== id; });
        rebuildCustomCaches();
      }
      var surf = activeSurface();
      if (surf.mode === 'wallpaper' && surf.wallpaperSource === 'custom' && surf.wallpaperId === id) {
        setSurface({ mode: 'solid', wallpaperSource: 'follow', wallpaperId: null });
      } else {
        dispatchEventSafe('anymux-appearance-change');
      }
      return data;
    });
  }

  // Apply saved theme immediately on load without bumping updatedAt or pushing to server.
  applyThemeInternal(getCurrent(), { persist: false, sync: false, notifyNative: false });
  applyNativeAppearance(false);

  if (typeof window.matchMedia === 'function') {
    try {
      systemSchemeMedia = window.matchMedia('(prefers-color-scheme: light)');
      var onSchemeChange = function () {
        if (activeTheme().mode !== 'system' || previewThemeId !== null) return;
        applyThemeInternal(getCurrent(), { persist: false, sync: false, announceAppearance: true });
      };
      if (typeof systemSchemeMedia.addEventListener === 'function') {
        systemSchemeMedia.addEventListener('change', onSchemeChange);
      } else if (typeof systemSchemeMedia.addListener === 'function') {
        systemSchemeMedia.addListener(onSchemeChange);
      }
    } catch (_e) {}
  }

  // Cross-tab synchronization listens ONLY to APPEARANCE_KEY so legacy keys never overwrite v3.
  window.addEventListener('storage', function (event) {
    if (event.key !== APPEARANCE_KEY && event.key !== null) return;
    if (event.key === null) {
      state = defaultState();
    } else {
      try {
        state = sanitizeState(JSON.parse(event.newValue || '{}'), defaultState());
      } catch (_e) {
        state = defaultState();
      }
    }
    previewThemeId = null;
    rebuildCustomCaches();
    applyThemeInternal(getCurrent(), { persist: false, sync: false, notifyNative: false });
    if (supportsGlassIntensity()) applyNativeAppearance(false);
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
    dispatchEventSafe('anymux-appearance-change');
  });

  function getWebPresets() {
    return ['clear', 'mist', 'frosted'].map(function (id) {
      return Object.assign({}, WEB_PRESETS[id]);
    });
  }

  return {
    getCurrent: getCurrent,
    apply: apply,
    previewTheme: previewTheme,
    clearPreview: clearPreview,
    getTerminalTheme: getTerminalTheme,
    getOpaqueTerminalTheme: getOpaqueTerminalTheme,
    getColorScheme: getColorScheme,
    getThemeList: getThemeList,
    getName: getName,
    supportsTransparency: supportsTransparency,
    getTransparency: getTransparency,
    setTransparency: setTransparency,
    supportsGlassIntensity: supportsGlassIntensity,
    getGlassIntensity: getGlassIntensity,
    setGlassIntensity: setGlassIntensity,
    supportsLiquidGlass: supportsLiquidGlass,
    supportsMaterialEngine: supportsMaterialEngine,
    getDeviceProfileKey: getDeviceProfileKey,
    getSurface: getSurface,
    setSurface: setSurface,
    getThemeMode: function () { return activeTheme().mode; },
    setThemeMode: setThemeMode,
    getLightThemeId: function () { return activeTheme().lightThemeId; },
    setLightThemeId: setLightThemeId,
    getDarkThemeId: function () { return activeTheme().darkThemeId; },
    setDarkThemeId: setDarkThemeId,
    getAccentOverride: function () { return activeTheme().accentOverride; },
    setAccentOverride: setAccentOverride,
    getAccentSwatches: function () { return ACCENT_SWATCHES.slice(); },
    importThemeJson: importThemeJson,
    exportThemeJson: exportThemeJson,
    deleteCustomTheme: deleteCustomTheme,
    getBuiltInWallpapers: getBuiltInWallpapers,
    getCustomWallpapers: getCustomWallpapers,
    getWallpaper: getWallpaper,
    setWallpaper: setWallpaper,
    getResolvedWallpaperId: getResolvedWallpaperId,
    getResolvedWallpaperUrl: getResolvedWallpaperUrl,
    isWallpaperActive: isWallpaperActive,
    isBackdropActive: isBackdropActive,
    getGlass: getGlass,
    setGlass: setGlass,
    getWebPresets: getWebPresets,
    applyWebPreset: applyWebPreset,
    getGlassPresets: getWebPresets,
    applyGlassPreset: applyWebPreset,
    getTerminalTypography: getTerminalTypography,
    setTerminalTypography: setTerminalTypography,
    getSnapshot: getSnapshot,
    restoreSnapshot: restoreSnapshot,
    resetAppearance: resetAppearance,
    syncFromServer: syncFromServer,
    saveToServer: saveToServer,
    uploadCustomWallpaper: uploadCustomWallpaper,
    deleteCustomWallpaper: deleteCustomWallpaper,
  };
})();
