/* global */

// === Theme, Wallpaper, Glass & Typography Manager ===

var Theme = (function () {
  var STORAGE_KEY = 'tmux_theme';
  var APPEARANCE_KEY = 'anymux_appearance_v2';
  var TRANSPARENCY_KEY = 'tmux_native_transparency';
  var GLASS_KEY = 'tmux_native_glass_intensity';
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

  var GLASS_PRESETS = {
    'solid': {
      id: 'solid',
      name: '纯净实色',
      description: '零模糊高对比实色表面',
      blurRadius: 0,
      saturation: 100,
      brightness: 100,
      noiseOpacity: 0,
      sidebarTint: 100,
      terminalTint: 95,
      inactivePaneDim: 12,
      nativeEngine: 'off',
      transparency: 0,
      glassIntensity: 0,
    },
    'mist': {
      id: 'mist',
      name: '柔雾磨砂',
      description: '轻度透光与低噪点磨砂',
      blurRadius: 14,
      saturation: 118,
      brightness: 100,
      noiseOpacity: 3,
      sidebarTint: 38,
      terminalTint: 78,
      inactivePaneDim: 14,
      nativeEngine: 'material',
      transparency: 18,
      glassIntensity: 55,
    },
    'frosted': {
      id: 'frosted',
      name: '深邃毛玻璃',
      description: '均衡模糊与细腻胶片质感',
      blurRadius: 24,
      saturation: 135,
      brightness: 98,
      noiseOpacity: 5,
      sidebarTint: 24,
      terminalTint: 66,
      inactivePaneDim: 18,
      nativeEngine: 'material',
      transparency: 28,
      glassIntensity: 80,
    },
    'liquid': {
      id: 'liquid',
      name: '液态清透',
      description: '高饱和通透呼吸感（macOS 26 液态玻璃）',
      blurRadius: 34,
      saturation: 155,
      brightness: 102,
      noiseOpacity: 4,
      sidebarTint: 18,
      terminalTint: 54,
      inactivePaneDim: 22,
      nativeEngine: 'liquid-regular',
      transparency: 38,
      glassIntensity: 95,
    },
    'clear-glass': {
      id: 'clear-glass',
      name: '晶透液态',
      description: '极简通透质感，最大程度显露背景',
      blurRadius: 18,
      saturation: 165,
      brightness: 104,
      noiseOpacity: 2,
      sidebarTint: 12,
      terminalTint: 44,
      inactivePaneDim: 24,
      nativeEngine: 'liquid-clear',
      transparency: 44,
      glassIntensity: 100,
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

  function defaultState() {
    return {
      version: 2,
      updatedAt: 0,
      themeMode: 'manual',
      themeId: DEFAULT_THEME,
      lightThemeId: 'oyster',
      darkThemeId: DEFAULT_THEME,
      accentOverride: null,
      wallpaper: {
        mode: 'none',
        id: null,
        followTheme: true,
        fit: 'cover',
        brightness: 100,
      },
      glass: {
        preset: 'frosted',
        nativeEngine: 'material',
        transparency: 0,
        glassIntensity: 100,
        blurRadius: 22,
        saturation: 135,
        brightness: 100,
        noiseOpacity: 4,
        sidebarTint: 24,
        terminalTint: 66,
        inactivePaneDim: 18,
      },
      typography: {
        fontSize: 14,
        lineHeight: 1.2,
        cursorStyle: 'block',
        cursorBlink: true,
        panePadding: 6,
      },
      customThemes: [],
    };
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

  function sanitizeState(raw, fallback) {
    var base = fallback || defaultState();
    var input = raw && typeof raw === 'object' ? raw : {};
    var out = defaultState();

    out.updatedAt = isFinite(Number(input.updatedAt)) && Number(input.updatedAt) >= 0
      ? Math.round(Number(input.updatedAt))
      : base.updatedAt;
    out.themeMode = input.themeMode === 'system' ? 'system' : (input.themeMode === 'manual' ? 'manual' : base.themeMode);

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

    out.accentOverride = 'accentOverride' in input
      ? (input.accentOverride === null || input.accentOverride === '' ? null : normalizeHex(input.accentOverride))
      : base.accentOverride;

    var rawWp = input.wallpaper && typeof input.wallpaper === 'object' ? input.wallpaper : {};
    var wpModes = { none: true, desktop: true, builtin: true, custom: true };
    var wpFits = { cover: true, contain: true, fill: true };
    out.wallpaper.mode = wpModes[rawWp.mode] ? rawWp.mode : base.wallpaper.mode;
    out.wallpaper.id = typeof rawWp.id === 'string' && rawWp.id.trim()
      ? rawWp.id.trim().slice(0, 128)
      : ('id' in rawWp ? null : base.wallpaper.id);
    if (out.wallpaper.mode === 'none' || out.wallpaper.mode === 'desktop') out.wallpaper.id = null;
    out.wallpaper.followTheme = typeof rawWp.followTheme === 'boolean' ? rawWp.followTheme : base.wallpaper.followTheme;
    out.wallpaper.fit = wpFits[rawWp.fit] ? rawWp.fit : base.wallpaper.fit;
    out.wallpaper.brightness = clampInt(rawWp.brightness, 40, 130, base.wallpaper.brightness);

    var rawGlass = input.glass && typeof input.glass === 'object' ? input.glass : {};
    var validPresets = { solid: true, mist: true, frosted: true, liquid: true, 'clear-glass': true, custom: true };
    var validEngines = { material: true, 'liquid-regular': true, 'liquid-clear': true, system: true, off: true };
    out.glass.preset = validPresets[rawGlass.preset] ? rawGlass.preset : base.glass.preset;
    out.glass.nativeEngine = validEngines[rawGlass.nativeEngine] ? rawGlass.nativeEngine : base.glass.nativeEngine;
    out.glass.transparency = clampInt(rawGlass.transparency, 0, 50, base.glass.transparency);
    out.glass.glassIntensity = clampInt(rawGlass.glassIntensity, 0, 100, base.glass.glassIntensity);
    out.glass.blurRadius = clampInt(rawGlass.blurRadius, 0, 48, base.glass.blurRadius);
    out.glass.saturation = clampInt(rawGlass.saturation, 60, 200, base.glass.saturation);
    out.glass.brightness = clampInt(rawGlass.brightness, 75, 125, base.glass.brightness);
    out.glass.noiseOpacity = clampInt(rawGlass.noiseOpacity, 0, 18, base.glass.noiseOpacity);
    out.glass.sidebarTint = clampInt(rawGlass.sidebarTint, 0, 85, base.glass.sidebarTint);
    out.glass.terminalTint = clampInt(rawGlass.terminalTint, 20, 95, base.glass.terminalTint);
    out.glass.inactivePaneDim = clampInt(rawGlass.inactivePaneDim, 0, 45, base.glass.inactivePaneDim);

    var rawTypo = input.typography && typeof input.typography === 'object' ? input.typography : {};
    var validCursors = { block: true, bar: true, underline: true };
    out.typography.fontSize = clampInt(rawTypo.fontSize, 10, 22, base.typography.fontSize);
    out.typography.lineHeight = clampFloat(rawTypo.lineHeight, 1.0, 1.8, 0.05, base.typography.lineHeight);
    out.typography.cursorStyle = validCursors[rawTypo.cursorStyle] ? rawTypo.cursorStyle : base.typography.cursorStyle;
    out.typography.cursorBlink = typeof rawTypo.cursorBlink === 'boolean' ? rawTypo.cursorBlink : base.typography.cursorBlink;
    out.typography.panePadding = clampInt(rawTypo.panePadding, 0, 16, base.typography.panePadding);

    // Resolve theme IDs after loading customThemes
    out.themeId = resolveThemeIdInState(input.themeId || base.themeId, out.customThemes);
    out.lightThemeId = resolveThemeIdInState(input.lightThemeId || base.lightThemeId, out.customThemes);
    out.darkThemeId = resolveThemeIdInState(input.darkThemeId || base.darkThemeId, out.customThemes);

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

  function readLegacyOnlyState() {
    var st = defaultState();
    try {
      var savedTheme = localStorage.getItem(STORAGE_KEY);
      if (savedTheme) st.themeId = resolveThemeIdInState(savedTheme, st.customThemes);
      var savedTrans = localStorage.getItem(TRANSPARENCY_KEY);
      var tVal = clampTransparency(savedTrans);
      st.glass.transparency = tVal;
      if (supportsTransparency() && tVal > 0) {
        st.wallpaper.mode = 'desktop';
      }
      var savedGlass = localStorage.getItem(GLASS_KEY);
      st.glass.glassIntensity = savedGlass === null ? 100 : clampGlassIntensity(savedGlass);
    } catch (_e) {}
    return st;
  }

  function loadInitialState() {
    try {
      var raw = localStorage.getItem(APPEARANCE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        var st = sanitizeState(parsed, defaultState());
        // Preserve legacy keys if they were explicitly seeded before v2
        var legacyTrans = localStorage.getItem(TRANSPARENCY_KEY);
        if (legacyTrans !== null) st.glass.transparency = clampTransparency(legacyTrans);
        var legacyGlass = localStorage.getItem(GLASS_KEY);
        if (legacyGlass !== null) st.glass.glassIntensity = clampGlassIntensity(legacyGlass);
        return st;
      }
    } catch (_e) {}
    return readLegacyOnlyState();
  }

  var state = loadInitialState();
  var customWallpapers = [];
  var saveServerTimer = null;
  var customWallpaperMap = {};
  var compiledCustomCache = {};
  var systemSchemeMedia = null;

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
      localStorage.setItem(STORAGE_KEY, state.themeId);
      localStorage.setItem(TRANSPARENCY_KEY, String(state.glass.transparency));
      localStorage.setItem(GLASS_KEY, String(state.glass.glassIntensity));
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
    if (!includeAccent || !state.accentOverride) return entry;
    return compileTheme(entry.raw, state.accentOverride);
  }

  function getCurrent() {
    if (state.themeMode === 'system') {
      return resolveThemeId(isSystemLight() ? state.lightThemeId : state.darkThemeId);
    }
    try {
      var lsTheme = localStorage.getItem(STORAGE_KEY);
      if (!localStorage.getItem(APPEARANCE_KEY) && lsTheme) {
        return resolveThemeId(lsTheme);
      }
    } catch (_e) {}
    return resolveThemeId(state.themeId);
  }

  function getBuiltInWallpaperById(id) {
    for (var i = 0; i < BUILT_IN_WALLPAPERS.length; i++) {
      if (BUILT_IN_WALLPAPERS[i].id === id) return BUILT_IN_WALLPAPERS[i];
    }
    return null;
  }

  function getResolvedWallpaperId(themeId) {
    var wp = state.wallpaper;
    if (wp.mode === 'builtin') {
      if (wp.followTheme || !wp.id) {
        var entry = getRawThemeEntry(themeId || getCurrent());
        if (entry.defaultWallpaper && getBuiltInWallpaperById(entry.defaultWallpaper)) {
          return entry.defaultWallpaper;
        }
        return entry.colorScheme === 'light' ? 'zen-silk' : 'obsidian-topo';
      }
      return getBuiltInWallpaperById(wp.id) ? wp.id : getRawThemeEntry(themeId || getCurrent()).defaultWallpaper;
    }
    if (wp.mode === 'custom' && wp.id) {
      return wp.id;
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
    var wp = state.wallpaper;
    if (wp.mode === 'builtin') {
      var id = getResolvedWallpaperId(themeId);
      var item = id ? getBuiltInWallpaperById(id) : null;
      return item ? item.url : null;
    }
    if (wp.mode === 'custom' && wp.id) {
      // Allow rendering even before list arrives if valid wp-<hex>.<ext> ID is saved
      if (customWallpaperMap[wp.id] || /^wp-[a-f0-9]{16}\.(png|jpg|webp|avif|gif)$/.test(wp.id)) {
        return appendAuthToken('/api/appearance/wallpapers/' + encodeURIComponent(wp.id));
      }
    }
    return null;
  }

  function isWallpaperActive() {
    return (state.wallpaper.mode === 'builtin' || state.wallpaper.mode === 'custom')
      && Boolean(getResolvedWallpaperUrl());
  }

  function getTransparency() {
    return supportsTransparency() ? state.glass.transparency : 0;
  }

  function isBackdropActive() {
    var nativeDesktop = supportsTransparency()
      && (state.wallpaper.mode === 'desktop' || state.wallpaper.mode === 'none')
      && getTransparency() > 0;
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
          applyVisualBackdrop(getCurrent());
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
    var activeTheme = getCompiledTheme(themeId || getCurrent(), true);
    var amount = getTransparency();
    var wpActive = isWallpaperActive();
    var nativeTrans = supportsTransparency()
      && (state.wallpaper.mode === 'desktop' || state.wallpaper.mode === 'none')
      && amount > 0;
    var backdropActive = nativeTrans || wpActive;

    root.toggleAttribute('data-native-transparency', nativeTrans);
    root.toggleAttribute('data-wallpaper-active', wpActive);
    root.toggleAttribute('data-backdrop-active', backdropActive);

    var bgHex = activeTheme.ui['--bg-primary'];
    var bgRgb = rgb(bgHex);
    root.style.setProperty('--native-window-background', 'rgba(' + bgRgb.join(', ') + ', ' + (1 - amount / 100) + ')');

    var g = state.glass;
    var wp = state.wallpaper;
    var typo = state.typography;
    var combinedBrightness = Math.round((wp.brightness * g.brightness) / 100);
    root.style.setProperty('--anymux-wp-blur', g.blurRadius + 'px');
    root.style.setProperty('--anymux-wp-saturate', g.saturation + '%');
    root.style.setProperty('--anymux-wp-brightness', combinedBrightness + '%');
    root.style.setProperty('--anymux-wp-scrim', 'rgba(' + bgRgb.join(', ') + ', ' + (g.terminalTint / 100).toFixed(3) + ')');
    root.style.setProperty('--anymux-wp-noise-opacity', (g.noiseOpacity / 100).toFixed(3));
    root.style.setProperty('--anymux-sidebar-alpha', g.sidebarTint + '%');
    root.style.setProperty('--anymux-sidebar-blur', Math.round(g.blurRadius * 0.65) + 'px');
    root.style.setProperty('--anymux-float-blur', Math.max(12, Math.min(36, Math.round(g.blurRadius * 1.1))) + 'px');
    root.style.setProperty('--anymux-pane-inactive-dim', g.inactivePaneDim + '%');
    root.style.setProperty('--terminal-pane-padding', typo.panePadding + 'px');

    var backdrop = ensureBackdropElement();
    if (backdrop) {
      var imgEl = backdrop.querySelector('.anymux-wp-image');
      if (wpActive) {
        var url = getResolvedWallpaperUrl(themeId);
        backdrop.hidden = false;
        if (imgEl) {
          imgEl.style.backgroundImage = url ? 'url("' + url.replace(/"/g, '%22') + '")' : 'none';
          imgEl.style.backgroundSize = wp.fit === 'fill' ? '100% 100%' : (wp.fit === 'contain' ? 'contain' : 'cover');
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
      if (hasRichNativeEngine() || forceRich === true) {
        var activeTheme = getCompiledTheme(getCurrent(), true);
        var g = state.glass;
        var nativeMode = state.wallpaper.mode;
        if (nativeMode === 'desktop' && g.transparency <= 0) {
          nativeMode = 'none';
        }
        var engine = g.nativeEngine;
        if ((engine === 'liquid-regular' || engine === 'liquid-clear') && !supportsLiquidGlass()) {
          engine = 'material';
        }
        handler.postMessage({
          glassIntensity: g.glassIntensity,
          mode: nativeMode,
          engine: engine,
          blurRadius: g.blurRadius,
          saturation: Number((g.saturation / 100).toFixed(2)),
          brightness: Number(((g.brightness - 100) / 100).toFixed(2)),
          tintHex: activeTheme.ui['--bg-primary'],
          tintAlpha: Number(((100 - g.transparency) / 100).toFixed(2)),
          colorScheme: activeTheme.colorScheme,
        });
      } else {
        handler.postMessage({ glassIntensity: state.glass.glassIntensity });
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
      if (!opts.keepMode) state.themeMode = 'manual';
      state.themeId = resolved;
      if (opts.bump !== false) state.updatedAt = Date.now();
      persistLocal();
      if (opts.sync !== false) scheduleServerSave();
    } else if (opts.syncLegacyKey) {
      try {
        if (localStorage.getItem(STORAGE_KEY) !== resolved) {
          localStorage.setItem(STORAGE_KEY, resolved);
        }
      } catch (_e) {}
    }

    if (hasRichNativeEngine() && opts.notifyNative !== false) {
      applyNativeAppearance(false);
    }

    dispatchEventSafe('tmux-theme-change', { themeId: resolved });
    if (opts.announceAppearance) dispatchEventSafe('anymux-appearance-change');
  }

  function apply(themeId, options) {
    var opts = options || {};
    var resolved = resolveThemeId(themeId);
    if (opts.keepMode !== true && state.themeMode === 'system') {
      state.themeMode = 'manual';
    }
    state.themeId = resolved;
    state.updatedAt = Date.now();
    applyThemeInternal(resolved, {
      persist: true,
      keepMode: opts.keepMode,
      bump: true,
      sync: opts.sync !== false,
      announceAppearance: opts.announceAppearance !== false,
    });
  }

  function getGlassIntensity() {
    return state.glass.glassIntensity;
  }

  function setGlassIntensity(value) {
    if (!supportsGlassIntensity()) return;
    state.glass.glassIntensity = clampGlassIntensity(value);
    state.updatedAt = Date.now();
    persistLocal();
    applyNativeAppearance(false);
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('anymux-appearance-change');
  }

  function setTransparency(value) {
    if (!supportsTransparency()) return;
    var next = clampTransparency(value);
    state.glass.transparency = next;
    if (next > 0 && state.wallpaper.mode === 'none') {
      state.wallpaper.mode = 'desktop';
    }
    state.updatedAt = Date.now();
    persistLocal();
    applyVisualBackdrop(getCurrent());
    if (hasRichNativeEngine()) applyNativeAppearance(false);
    scheduleServerSave();
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('anymux-appearance-change');
  }

  function setWallpaper(patch) {
    if (!patch || typeof patch !== 'object') return;
    var wp = state.wallpaper;
    if ('mode' in patch) {
      if (patch.mode === 'desktop' && !supportsTransparency()) return;
      if ({ none: true, desktop: true, builtin: true, custom: true }[patch.mode]) {
        wp.mode = patch.mode;
      }
    }
    if ('id' in patch) {
      wp.id = patch.id || null;
    }
    if (typeof patch.followTheme === 'boolean') {
      wp.followTheme = patch.followTheme;
    } else if (wp.mode === 'builtin') {
      if ('id' in patch && patch.id) {
        var recId = getRawThemeEntry(getCurrent()).defaultWallpaper;
        if (patch.id !== recId) wp.followTheme = false;
      } else if (!wp.id) {
        wp.followTheme = true;
      }
    }
    if ({ cover: true, contain: true, fill: true }[patch.fit]) {
      wp.fit = patch.fit;
    }
    if ('brightness' in patch) {
      wp.brightness = clampInt(patch.brightness, 40, 130, wp.brightness);
    }
    if (wp.mode === 'desktop' && state.glass.transparency <= 0 && supportsTransparency()) {
      state.glass.transparency = 25;
      if (state.glass.preset === 'solid') state.glass.preset = 'frosted';
    }
    if ((wp.mode === 'builtin' || wp.mode === 'custom') && state.glass.preset === 'solid') {
      var frosted = GLASS_PRESETS.frosted;
      state.glass.preset = 'frosted';
      state.glass.blurRadius = frosted.blurRadius;
      state.glass.saturation = frosted.saturation;
      state.glass.brightness = frosted.brightness;
      state.glass.noiseOpacity = frosted.noiseOpacity;
      state.glass.sidebarTint = frosted.sidebarTint;
      state.glass.terminalTint = frosted.terminalTint;
      state.glass.inactivePaneDim = frosted.inactivePaneDim;
    }
    if (wp.mode === 'none' || wp.mode === 'desktop') {
      wp.id = null;
    }
    state.updatedAt = Date.now();
    persistLocal();
    applyVisualBackdrop(getCurrent());
    if (supportsGlassIntensity() && (hasRichNativeEngine() || wp.mode === 'desktop' || wp.mode === 'none')) {
      applyNativeAppearance(hasRichNativeEngine());
    }
    scheduleServerSave();
    dispatchEventSafe('tmux-wallpaper-change', { wallpaper: getWallpaper() });
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('anymux-appearance-change');
  }

  function setGlass(patch) {
    if (!patch || typeof patch !== 'object') return;
    var g = state.glass;
    var custom = !patch.preset;
    if ('blurRadius' in patch) g.blurRadius = clampInt(patch.blurRadius, 0, 48, g.blurRadius);
    if ('saturation' in patch) g.saturation = clampInt(patch.saturation, 60, 200, g.saturation);
    if ('brightness' in patch) g.brightness = clampInt(patch.brightness, 75, 125, g.brightness);
    if ('noiseOpacity' in patch) g.noiseOpacity = clampInt(patch.noiseOpacity, 0, 18, g.noiseOpacity);
    if ('sidebarTint' in patch) g.sidebarTint = clampInt(patch.sidebarTint, 0, 85, g.sidebarTint);
    if ('terminalTint' in patch) g.terminalTint = clampInt(patch.terminalTint, 20, 95, g.terminalTint);
    if ('inactivePaneDim' in patch) g.inactivePaneDim = clampInt(patch.inactivePaneDim, 0, 45, g.inactivePaneDim);
    if ('transparency' in patch && supportsTransparency()) {
      g.transparency = clampTransparency(patch.transparency);
    }
    if ('glassIntensity' in patch) {
      g.glassIntensity = clampGlassIntensity(patch.glassIntensity);
    }
    if (patch.nativeEngine && { material: true, 'liquid-regular': true, 'liquid-clear': true, system: true, off: true }[patch.nativeEngine]) {
      g.nativeEngine = patch.nativeEngine;
      custom = false;
    }
    if (patch.preset && GLASS_PRESETS[patch.preset]) {
      g.preset = patch.preset;
    } else if (custom) {
      g.preset = 'custom';
    }
    state.updatedAt = Date.now();
    persistLocal();
    applyVisualBackdrop(getCurrent());
    if (supportsGlassIntensity()) applyNativeAppearance(true);
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('anymux-appearance-change');
  }

  function applyGlassPreset(presetId) {
    var preset = GLASS_PRESETS[presetId];
    if (!preset) return;
    var g = state.glass;
    g.preset = preset.id;
    g.blurRadius = preset.blurRadius;
    g.saturation = preset.saturation;
    g.brightness = preset.brightness;
    g.noiseOpacity = preset.noiseOpacity;
    g.sidebarTint = preset.sidebarTint;
    g.terminalTint = preset.terminalTint;
    g.inactivePaneDim = preset.inactivePaneDim;

    var engine = preset.nativeEngine;
    if ((engine === 'liquid-regular' || engine === 'liquid-clear') && !supportsLiquidGlass()) {
      engine = 'material';
    }
    g.nativeEngine = engine;
    if (supportsTransparency()) {
      g.transparency = preset.transparency;
      g.glassIntensity = preset.glassIntensity;
      if (preset.id === 'solid' && state.wallpaper.mode === 'desktop') {
        state.wallpaper.mode = 'none';
      } else if (preset.id !== 'solid' && state.wallpaper.mode === 'none') {
        state.wallpaper.mode = 'desktop';
      }
    } else if (preset.id !== 'solid' && state.wallpaper.mode === 'none') {
      state.wallpaper.mode = 'builtin';
      state.wallpaper.followTheme = true;
    } else if (preset.id === 'solid' && (state.wallpaper.mode === 'builtin' || state.wallpaper.mode === 'custom')) {
      state.wallpaper.mode = 'none';
      state.wallpaper.id = null;
    }

    state.updatedAt = Date.now();
    persistLocal();
    applyVisualBackdrop(getCurrent());
    if (supportsGlassIntensity()) applyNativeAppearance(true);
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change');
    dispatchEventSafe('anymux-appearance-change');
  }

  function setTerminalTypography(patch) {
    if (!patch || typeof patch !== 'object') return;
    var typo = state.typography;
    if ('fontSize' in patch) typo.fontSize = clampInt(patch.fontSize, 10, 22, typo.fontSize);
    if ('lineHeight' in patch) typo.lineHeight = clampFloat(patch.lineHeight, 1.0, 1.8, 0.05, typo.lineHeight);
    if ({ block: true, bar: true, underline: true }[patch.cursorStyle]) typo.cursorStyle = patch.cursorStyle;
    if (typeof patch.cursorBlink === 'boolean') typo.cursorBlink = patch.cursorBlink;
    if ('panePadding' in patch) typo.panePadding = clampInt(patch.panePadding, 0, 16, typo.panePadding);

    state.updatedAt = Date.now();
    persistLocal();
    document.documentElement.style.setProperty('--terminal-pane-padding', typo.panePadding + 'px');
    scheduleServerSave();
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
    dispatchEventSafe('anymux-appearance-change');
  }

  function setThemeMode(mode) {
    var next = mode === 'system' ? 'system' : 'manual';
    if (state.themeMode === next) return;
    state.themeMode = next;
    state.updatedAt = Date.now();
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: true, announceAppearance: true });
  }

  function setLightThemeId(id) {
    state.lightThemeId = resolveThemeId(id);
    state.updatedAt = Date.now();
    if (state.themeMode === 'system') {
      applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: true, announceAppearance: true });
    } else {
      persistLocal();
      scheduleServerSave();
      dispatchEventSafe('anymux-appearance-change');
    }
  }

  function setDarkThemeId(id) {
    state.darkThemeId = resolveThemeId(id);
    state.updatedAt = Date.now();
    if (state.themeMode === 'system') {
      applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: true, announceAppearance: true });
    } else {
      persistLocal();
      scheduleServerSave();
      dispatchEventSafe('anymux-appearance-change');
    }
  }

  function setAccentOverride(value) {
    state.accentOverride = value ? normalizeHex(value) : null;
    state.updatedAt = Date.now();
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: true, announceAppearance: true });
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
    state.themeMode = 'manual';
    state.themeId = cleaned.id;
    state.updatedAt = Date.now();
    applyThemeInternal(cleaned.id, { persist: true, keepMode: true, bump: true, announceAppearance: true });
    return getThemeList().filter(function (item) { return item.id === cleaned.id; })[0];
  }

  function exportThemeJson(themeId) {
    var entry = getCompiledTheme(themeId || getCurrent(), !themeId || themeId === getCurrent());
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
    state.customThemes = next;
    rebuildCustomCaches();
    if (state.themeId === id) state.themeId = DEFAULT_THEME;
    if (state.lightThemeId === id) state.lightThemeId = 'oyster';
    if (state.darkThemeId === id) state.darkThemeId = DEFAULT_THEME;
    state.updatedAt = Date.now();
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: true, announceAppearance: true });
    return true;
  }

  function resetAppearance() {
    var customThemesBackup = state.customThemes;
    state = defaultState();
    state.customThemes = customThemesBackup;
    state.updatedAt = Date.now();
    rebuildCustomCaches();
    applyThemeInternal(getCurrent(), { persist: true, keepMode: true, bump: true, announceAppearance: true });
    if (supportsGlassIntensity()) applyNativeAppearance(hasRichNativeEngine());
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change');
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
  }

  function getSnapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function restoreSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state = sanitizeState(snap, defaultState());
    rebuildCustomCaches();
    persistLocal();
    applyThemeInternal(getCurrent(), { persist: false, announceAppearance: false });
    if (supportsGlassIntensity()) applyNativeAppearance(hasRichNativeEngine());
    scheduleServerSave();
    dispatchEventSafe('tmux-glass-change');
    dispatchEventSafe('tmux-transparency-change');
    dispatchEventSafe('tmux-wallpaper-change');
    dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
    dispatchEventSafe('anymux-appearance-change');
  }

  function getTerminalTheme(themeId) {
    var id = resolveThemeId(themeId || getCurrent());
    var t = getCompiledTheme(id, !themeId || themeId === getCurrent()).terminal;
    var copy = cloneObj(t);
    // Only the page background carries alpha. Painting it again in xterm
    // would stack the two backgrounds and make the terminal nearly opaque.
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
    return getRawThemeEntry(themeId || getCurrent()).name;
  }

  function getWallpaper() {
    return cloneObj(state.wallpaper);
  }

  function getGlass() {
    return cloneObj(state.glass);
  }

  function getTerminalTypography() {
    return cloneObj(state.typography);
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
    return JSON.parse(JSON.stringify(state));
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
      var remote = data.config;
      if (remote && typeof remote === 'object') {
        var remoteUpdated = Number(remote.updatedAt) || 0;
        var localUpdated = Number(state.updatedAt) || 0;
        if (remoteUpdated > localUpdated) {
          state = sanitizeState(remote, state);
          rebuildCustomCaches();
          persistLocal();
          applyThemeInternal(getCurrent(), { persist: false, announceAppearance: false });
          if (supportsGlassIntensity()) applyNativeAppearance(hasRichNativeEngine());
          dispatchEventSafe('tmux-glass-change');
          dispatchEventSafe('tmux-transparency-change');
          dispatchEventSafe('tmux-wallpaper-change');
          dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
          dispatchEventSafe('anymux-appearance-change');
        } else if (localUpdated > remoteUpdated && localUpdated > 0) {
          saveToServer();
        } else {
          // Even if config timestamps tie, customWallpapers list may have refreshed
          applyVisualBackdrop(getCurrent());
          dispatchEventSafe('anymux-appearance-change');
        }
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
          setWallpaper({ mode: 'custom', id: payload.wallpaper.id });
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
      if (state.wallpaper.mode === 'custom' && state.wallpaper.id === id) {
        setWallpaper({ mode: 'none', id: null });
      } else {
        dispatchEventSafe('anymux-appearance-change');
      }
      return data;
    });
  }

  // Apply saved theme immediately on load without bumping updatedAt or pushing to server.
  applyThemeInternal(getCurrent(), { persist: false, sync: false, notifyNative: false, syncLegacyKey: true });
  applyNativeAppearance(false);

  // Listen to OS light/dark changes when themeMode === 'system'.
  if (typeof window.matchMedia === 'function') {
    try {
      systemSchemeMedia = window.matchMedia('(prefers-color-scheme: light)');
      var onSchemeChange = function () {
        if (state.themeMode !== 'system') return;
        applyThemeInternal(getCurrent(), { persist: false, sync: false, announceAppearance: true });
      };
      if (typeof systemSchemeMedia.addEventListener === 'function') {
        systemSchemeMedia.addEventListener('change', onSchemeChange);
      } else if (typeof systemSchemeMedia.addListener === 'function') {
        systemSchemeMedia.addListener(onSchemeChange);
      }
    } catch (_e) {}
  }

  // Cross-tab & pop-out terminal synchronization.
  window.addEventListener('storage', function (event) {
    if (event.key === APPEARANCE_KEY || event.key === null) {
      if (event.key === null) {
        state = defaultState();
      } else {
        try {
          state = sanitizeState(JSON.parse(event.newValue || '{}'), defaultState());
        } catch (_e) {
          state = defaultState();
        }
      }
      rebuildCustomCaches();
      applyThemeInternal(getCurrent(), { persist: false, sync: false, notifyNative: false });
      if (supportsGlassIntensity()) applyNativeAppearance(false);
      dispatchEventSafe('tmux-glass-change');
      dispatchEventSafe('tmux-transparency-change');
      dispatchEventSafe('tmux-wallpaper-change');
      dispatchEventSafe('tmux-typography-change', { typography: getTerminalTypography() });
      dispatchEventSafe('anymux-appearance-change');
      return;
    }

    if (!supportsTransparency()) return;
    if (event.key === GLASS_KEY) {
      state.glass.glassIntensity = event.newValue === null ? 100 : clampGlassIntensity(event.newValue);
      applyNativeAppearance(false);
      dispatchEventSafe('tmux-glass-change');
    }
    if (event.key === TRANSPARENCY_KEY) {
      state.glass.transparency = clampTransparency(event.newValue);
      if (state.glass.transparency > 0 && state.wallpaper.mode === 'none') {
        state.wallpaper.mode = 'desktop';
      } else if (state.glass.transparency === 0 && state.wallpaper.mode === 'desktop') {
        state.wallpaper.mode = 'none';
      }
      applyVisualBackdrop(getCurrent());
      if (hasRichNativeEngine()) applyNativeAppearance(false);
      dispatchEventSafe('tmux-transparency-change');
    }
    if (event.key === STORAGE_KEY) {
      state.themeId = resolveThemeId(event.newValue);
      applyThemeInternal(getCurrent(), { persist: false, sync: false, syncLegacyKey: true });
    }
  });

  return {
    getCurrent: getCurrent,
    apply: apply,
    getTerminalTheme: getTerminalTheme,
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
    getThemeMode: function () { return state.themeMode; },
    setThemeMode: setThemeMode,
    getLightThemeId: function () { return state.lightThemeId; },
    setLightThemeId: setLightThemeId,
    getDarkThemeId: function () { return state.darkThemeId; },
    setDarkThemeId: setDarkThemeId,
    getAccentOverride: function () { return state.accentOverride; },
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
    getGlassPresets: function () {
      return ['solid', 'mist', 'frosted', 'liquid', 'clear-glass'].map(function (id) {
        return Object.assign({}, GLASS_PRESETS[id]);
      });
    },
    applyGlassPreset: applyGlassPreset,
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
