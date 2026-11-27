// Unicode 11 + ZWJ width provider matching Orca's glyph-advance contract.
// Ported from stablyai/orca (MIT).

export const ANYMUX_UNICODE_VERSION = 'anymux-11-zwj';
const UNICODE11_VERSION = '11';
const ZERO_WIDTH_JOINER = 0x200d;

function extractWidth(properties) {
  return (properties >> 1) & 3;
}

function extractCharKind(properties) {
  return properties >> 3;
}

function createProperties(charKind, width, shouldJoin) {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);
}

/**
 * Wrap xterm's Unicode 11 provider so ZWJ sequences (e.g. family/profession emoji)
 * occupy one single wide cluster instead of advancing cursor width for every component.
 */
export class AnymuxUnicode11ZwjProvider {
  constructor(baseProvider) {
    this.version = ANYMUX_UNICODE_VERSION;
    this.baseProvider = baseProvider;
  }

  wcwidth(codepoint) {
    return this.baseProvider.wcwidth(codepoint);
  }

  charProperties(codepoint, preceding) {
    const precedingWidth = extractWidth(preceding);
    const precedingKind = extractCharKind(preceding);

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true);
    }
    if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      return createProperties(codepoint, precedingWidth, true);
    }
    return this.baseProvider.charProperties(codepoint, preceding);
  }
}

/**
 * Load `@xterm/addon-unicode11` (when present) and activate the ZWJ-aware Unicode 11 provider.
 * Safe no-op on lightweight mock terminals in unit tests.
 */
export function activateAnymuxUnicodeProvider(term, globalObj = globalThis) {
  if (!term) return false;
  try {
    const Unicode11Ctor = globalObj?.Unicode11Addon?.Unicode11Addon;
    if (Unicode11Ctor && typeof term.loadAddon === 'function' && (!term.unicode?.versions || !term.unicode.versions.includes(UNICODE11_VERSION))) {
      term.loadAddon(new Unicode11Ctor());
    }
    const unicode = term.unicode;
    if (!unicode) return false;
    if (unicode.activeVersion === ANYMUX_UNICODE_VERSION) return true;

    const baseProvider = term._core?.unicodeService?._providers?.[UNICODE11_VERSION];
    if (!baseProvider) {
      if (unicode.versions?.includes?.(UNICODE11_VERSION)) {
        unicode.activeVersion = UNICODE11_VERSION;
        return true;
      }
      return false;
    }

    if (!unicode.versions?.includes?.(ANYMUX_UNICODE_VERSION) && typeof unicode.register === 'function') {
      unicode.register(new AnymuxUnicode11ZwjProvider(baseProvider));
    }
    unicode.activeVersion = ANYMUX_UNICODE_VERSION;
    return true;
  } catch {
    return false;
  }
}
