/** Preset themes shown as tiles in Settings (when not on Custom). */
export const themeCatalog = [
  { id: 'neon-grid' as const, name: 'Neon Grid', preview: 'Cyan / Lime / Deep Navy' },
  { id: 'sunset-terminal' as const, name: 'Sunset Terminal', preview: 'Coral / Amber / Plum' },
  { id: 'ice-station' as const, name: 'Ice Station', preview: 'Blue / Mint / Graphite' },
  { id: 'kiwi' as const, name: 'Kiwi', preview: 'Green / Teal / Graphite (light)' }
] as const;

export type PresetThemeId = (typeof themeCatalog)[number]['id'];

/** Saved `themeId`; `custom` applies `customThemeTokens` on top of the custom base stylesheet. */
export type ThemeId = PresetThemeId | 'custom';

export const PRESET_THEME_IDS: readonly PresetThemeId[] = themeCatalog.map((t) => t.id);

export function isPresetThemeId(value: string): value is PresetThemeId {
  return (PRESET_THEME_IDS as readonly string[]).includes(value);
}

export function isThemeId(value: string): value is ThemeId {
  return isPresetThemeId(value) || value === 'custom';
}

export function getThemeName(themeId: string): string {
  if (themeId === 'custom') return 'Custom';
  const entry = themeCatalog.find((t) => t.id === themeId);
  return entry?.name ?? themeId;
}

/** CSS variables the agent may set via `merge_custom_theme_tokens`; must match stylesheet usage. */
export const CUSTOMIZABLE_THEME_TOKEN_KEYS = [
  '--bg-0',
  '--bg-1',
  '--bg-2',
  '--bg-surface',
  '--bg-elevated',
  '--panel',
  '--panel-strong',
  '--line',
  '--line-strong',
  '--text-0',
  '--text-1',
  '--text-2',
  '--accent',
  '--accent-light',
  '--accent-subtle',
  '--accent-2',
  '--accent-2-subtle',
  '--accent-rgb',
  '--danger',
  '--danger-subtle',
  '--warning',
  '--app-bg',
  '--titlebar-bg',
  '--sidebar-bg',
  '--chat-panel-bg',
  '--chat-thread-bg',
  '--chat-assistant-bg',
  '--chat-user-bg',
  '--thinking-bg',
  '--composer-bg',
  '--composer-input-bg',
  '--inspector-bg',
  '--settings-bg',
  '--editor-bg'
] as const;

export type CustomThemeTokenKey = (typeof CUSTOMIZABLE_THEME_TOKEN_KEYS)[number];

export function isAllowedCustomThemeTokenKey(key: string): key is CustomThemeTokenKey {
  return (CUSTOMIZABLE_THEME_TOKEN_KEYS as readonly string[]).includes(key);
}

const THEME_COLOR_SLOT_ALIASES: Record<string, readonly CustomThemeTokenKey[]> = {
  app: ['--app-bg', '--bg-0'],
  appbackground: ['--app-bg', '--bg-0'],
  window: ['--app-bg', '--bg-0'],
  windowbackground: ['--app-bg', '--bg-0'],
  page: ['--app-bg', '--bg-0'],
  background: ['--app-bg', '--bg-0'],
  titlebar: ['--titlebar-bg'],
  topbar: ['--titlebar-bg'],
  sidebar: ['--sidebar-bg'],
  leftsidebar: ['--sidebar-bg'],
  chat: ['--chat-panel-bg'],
  chatpanel: ['--chat-panel-bg'],
  chatbackground: ['--chat-thread-bg'],
  chatthread: ['--chat-thread-bg'],
  thread: ['--chat-thread-bg'],
  chatbubble: ['--chat-assistant-bg', '--chat-user-bg'],
  chatbubbles: ['--chat-assistant-bg', '--chat-user-bg'],
  bubbles: ['--chat-assistant-bg', '--chat-user-bg'],
  assistant: ['--chat-assistant-bg'],
  assistantmessage: ['--chat-assistant-bg'],
  assistantbubble: ['--chat-assistant-bg'],
  message: ['--chat-assistant-bg'],
  bubble: ['--chat-assistant-bg'],
  user: ['--chat-user-bg'],
  usermessage: ['--chat-user-bg'],
  userbubble: ['--chat-user-bg'],
  thinking: ['--thinking-bg'],
  reasoning: ['--thinking-bg'],
  composer: ['--composer-bg'],
  input: ['--composer-input-bg'],
  messageinput: ['--composer-input-bg'],
  inspector: ['--inspector-bg'],
  rightpanel: ['--inspector-bg'],
  settings: ['--settings-bg'],
  editor: ['--editor-bg'],
  fileeditor: ['--editor-bg'],
  text: ['--text-0'],
  primarytext: ['--text-0'],
  bodytext: ['--text-0'],
  mutedtext: ['--text-2'],
  secondarytext: ['--text-1'],
  border: ['--line', '--line-strong'],
  borders: ['--line', '--line-strong'],
  line: ['--line'],
  accent: ['--accent'],
  primaryaccent: ['--accent'],
  primary: ['--accent'],
  secondaryaccent: ['--accent-2'],
  secondary: ['--accent-2'],
  danger: ['--danger'],
  error: ['--danger'],
  warning: ['--warning']
};

function expandThemeColorSlot(slot: string, value: unknown, out: Record<string, unknown>) {
  if (typeof value !== 'string' || value.trim().length === 0) return;
  const normalized = slot.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokenKeys = THEME_COLOR_SLOT_ALIASES[normalized];
  if (!tokenKeys) return;
  for (const tokenKey of tokenKeys) {
    out[tokenKey] = value;
  }
}

/** Token map from `merge_custom_theme_tokens`: `tokens` object and/or top-level `--*` keys (`palette`/`preset` excluded). */
export function flattenMergeThemeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const boxed = args.tokens ?? args.theme_tokens ?? args.token;
  if (boxed != null && typeof boxed === 'object' && !Array.isArray(boxed)) {
    for (const [key, value] of Object.entries(boxed as Record<string, unknown>)) {
      if (key.startsWith('--')) out[key] = value;
      else expandThemeColorSlot(key, value, out);
    }
  }
  const slots = args.slots ?? args.areas ?? args.ui ?? args.ui_colors;
  if (slots != null && typeof slots === 'object' && !Array.isArray(slots)) {
    for (const [slot, value] of Object.entries(slots as Record<string, unknown>)) {
      expandThemeColorSlot(slot, value, out);
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (
      k === 'tokens' ||
      k === 'theme_tokens' ||
      k === 'token' ||
      k === 'slots' ||
      k === 'areas' ||
      k === 'ui' ||
      k === 'ui_colors' ||
      k === 'palette' ||
      k === 'preset'
    ) continue;
    if (k.startsWith('--')) out[k] = v;
    else expandThemeColorSlot(k, v, out);
  }
  return out;
}

/** Keep only whitelist keys with non-empty string values. */
export function sanitizeCustomThemeTokens(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawK, rawV] of Object.entries(input)) {
    const k = rawK.trim();
    if (!isAllowedCustomThemeTokenKey(k)) continue;
    if (typeof rawV !== 'string') continue;
    const v = rawV.trim();
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Defaults when merge payload is empty; chosen via optional `palette` on `merge_custom_theme_tokens`,
 * or fuzzy substring match (`ice`, `gray`, etc.).
 */
export const MERGE_THEME_PALETTE_IDS = [
  'soft_kiwi_dark',
  'ice_cool_dark',
  'neutral_slate_dark',
  'light_paper_gray'
] as const;

export type MergeThemePaletteId = (typeof MERGE_THEME_PALETTE_IDS)[number];

export const SEMANTIC_CUSTOM_THEME_PALETTE_IDS = [
  'red',
  'pink',
  'purple',
  'blue',
  'green',
  'orange',
  'slate',
  'white',
  'ice',
  'kiwi'
] as const;

export const SEMANTIC_CUSTOM_THEME_MODE_IDS = ['light', 'dark'] as const;

export type SemanticCustomThemePaletteId = (typeof SEMANTIC_CUSTOM_THEME_PALETTE_IDS)[number];
export type SemanticCustomThemeModeId = (typeof SEMANTIC_CUSTOM_THEME_MODE_IDS)[number];

export function isSemanticCustomThemePaletteId(value: string): value is SemanticCustomThemePaletteId {
  return (SEMANTIC_CUSTOM_THEME_PALETTE_IDS as readonly string[]).includes(value);
}

export function isSemanticCustomThemeModeId(value: string): value is SemanticCustomThemeModeId {
  return (SEMANTIC_CUSTOM_THEME_MODE_IDS as readonly string[]).includes(value);
}

const semanticHues: Record<
  Exclude<SemanticCustomThemePaletteId, 'white' | 'slate' | 'ice' | 'kiwi'>,
  { accent: string; accentLight: string; accentRgb: string; accent2: string; danger: string; warning: string }
> = {
  red: {
    accent: '#dc2626',
    accentLight: '#ef4444',
    accentRgb: '220, 38, 38',
    accent2: '#b91c1c',
    danger: '#991b1b',
    warning: '#f59e0b'
  },
  pink: {
    accent: '#ec4899',
    accentLight: '#f472b6',
    accentRgb: '236, 72, 153',
    accent2: '#db2777',
    danger: '#e11d48',
    warning: '#f59e0b'
  },
  purple: {
    accent: '#8b5cf6',
    accentLight: '#a78bfa',
    accentRgb: '139, 92, 246',
    accent2: '#d946ef',
    danger: '#f43f5e',
    warning: '#f59e0b'
  },
  blue: {
    accent: '#2563eb',
    accentLight: '#60a5fa',
    accentRgb: '37, 99, 235',
    accent2: '#06b6d4',
    danger: '#ef4444',
    warning: '#f59e0b'
  },
  green: {
    accent: '#16a34a',
    accentLight: '#22c55e',
    accentRgb: '22, 163, 74',
    accent2: '#0d9488',
    danger: '#ef4444',
    warning: '#d97706'
  },
  orange: {
    accent: '#f97316',
    accentLight: '#fb923c',
    accentRgb: '249, 115, 22',
    accent2: '#f59e0b',
    danger: '#e11d48',
    warning: '#facc15'
  }
};

function semanticPaletteFromDescription(value: string | undefined): SemanticCustomThemePaletteId | undefined {
  const raw = value?.toLowerCase() ?? '';
  if (/\bred\b|ruby|crimson|scarlet|\bfire\b|blood(?!\s*sugar)|cherry(?!\s*blossom)/.test(raw)) return 'red';
  if (/\bpink|rose|magenta|fuchsia|hot\s*pink\b/.test(raw)) return 'pink';
  if (/\bpurple|violet|lavender\b/.test(raw)) return 'purple';
  if (/\bblue|cyan|aqua\b/.test(raw)) return 'blue';
  if (/\bgreen|kiwi|lime|mint\b/.test(raw)) return raw.includes('kiwi') ? 'kiwi' : 'green';
  if (/\borange|amber|sunset|coral\b/.test(raw)) return 'orange';
  if (/\bice|icy|frost|winter\b/.test(raw)) return 'ice';
  if (/\bwhite|paper|cream|ivory|gray|grey|slate|neutral|mono/.test(raw)) {
    return /\bwhite|paper|cream|ivory\b/.test(raw) ? 'white' : 'slate';
  }
  return undefined;
}

function semanticModeFromDescription(value: string | undefined): SemanticCustomThemeModeId | undefined {
  const raw = value?.toLowerCase() ?? '';
  if (/\bdark|night|black|deep|midnight\b/.test(raw)) return 'dark';
  if (/\blight|white|bright|paper|pastel|cream|ivory\b/.test(raw)) return 'light';
  return undefined;
}

export function buildSemanticCustomThemeTokens(input: {
  palette?: string;
  mode?: string;
  description?: string;
  intensity?: string;
}): {
  tokens: Record<string, string>;
  palette: SemanticCustomThemePaletteId;
  mode: SemanticCustomThemeModeId;
} {
  const palette =
    input.palette && isSemanticCustomThemePaletteId(input.palette)
      ? input.palette
      : semanticPaletteFromDescription(input.description) ?? 'pink';
  const mode =
    input.mode && isSemanticCustomThemeModeId(input.mode)
      ? input.mode
      : semanticModeFromDescription(input.description) ?? 'light';

  if (palette === 'white') {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY }, palette, mode: 'light' };
  }
  if (palette === 'slate') {
    return {
      tokens: mode === 'light' ? { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY } : { ...CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE },
      palette,
      mode
    };
  }
  if (palette === 'ice') {
    return {
      tokens: mode === 'light' ? { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY, ...semanticLightTokens(semanticHues.blue, 'ice') } : { ...CUSTOM_THEME_FALLBACK_ICE_COOL_DARK },
      palette,
      mode
    };
  }
  if (palette === 'kiwi') {
    return {
      tokens: mode === 'light' ? semanticLightTokens(semanticHues.green, 'kiwi') : { ...CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI },
      palette,
      mode
    };
  }

  const hue = semanticHues[palette];
  return {
    tokens: mode === 'dark' ? semanticDarkTokens(hue, palette) : semanticLightTokens(hue, palette),
    palette,
    mode
  };
}

function semanticLightTokens(
  hue: { accent: string; accentLight: string; accentRgb: string; accent2: string; danger: string; warning: string },
  palette: string
): Record<string, string> {
  const tinted =
    palette === 'red'
      ? { bg0: '#fff1f2', bg1: '#ffe4e6', bg2: '#fecdd3', line: '220, 38, 38' }
      : palette === 'pink'
      ? { bg0: '#fff1f7', bg1: '#ffe4f0', bg2: '#fbcfe8', line: '236, 72, 153' }
      : palette === 'purple'
        ? { bg0: '#f6f1ff', bg1: '#ede4ff', bg2: '#ddd6fe', line: '139, 92, 246' }
        : palette === 'orange'
          ? { bg0: '#fff7ed', bg1: '#ffedd5', bg2: '#fed7aa', line: '249, 115, 22' }
          : palette === 'blue' || palette === 'ice'
            ? { bg0: '#eff6ff', bg1: '#dbeafe', bg2: '#bfdbfe', line: '37, 99, 235' }
            : { bg0: '#f0fdf4', bg1: '#dcfce7', bg2: '#bbf7d0', line: '22, 163, 74' };

  return {
    '--bg-0': tinted.bg0,
    '--bg-1': tinted.bg1,
    '--bg-2': tinted.bg2,
    '--bg-surface': 'rgba(255, 255, 255, 0.94)',
    '--bg-elevated': 'rgba(255, 255, 255, 0.98)',
    '--panel': 'rgba(255, 255, 255, 0.92)',
    '--panel-strong': 'rgba(255, 255, 255, 0.97)',
    '--line': `rgba(${tinted.line}, 0.14)`,
    '--line-strong': `rgba(${tinted.line}, 0.24)`,
    '--text-0': '#18181b',
    '--text-1': 'rgba(24, 24, 27, 0.78)',
    '--text-2': 'rgba(82, 82, 91, 0.58)',
    '--accent': hue.accent,
    '--accent-light': hue.accentLight,
    '--accent-rgb': hue.accentRgb,
    '--accent-subtle': `rgba(${hue.accentRgb}, 0.12)`,
    '--accent-2': hue.accent2,
    '--accent-2-subtle': `rgba(${hue.accentRgb}, 0.10)`,
    '--chat-assistant-bg': `rgba(${hue.accentRgb}, 0.07)`,
    '--chat-user-bg': `rgba(${hue.accentRgb}, 0.16)`,
    '--thinking-bg': `rgba(${hue.accentRgb}, 0.07)`,
    '--composer-input-bg': 'rgba(255, 255, 255, 0.72)',
    '--danger': hue.danger,
    '--danger-subtle': 'rgba(225, 29, 72, 0.08)',
    '--warning': hue.warning
  };
}

function semanticDarkTokens(
  hue: { accent: string; accentLight: string; accentRgb: string; accent2: string; danger: string; warning: string },
  palette: string
): Record<string, string> {
  const tinted =
    palette === 'red'
      ? { bg0: '#1c0a0a', bg1: '#2a1010', bg2: '#3f1515', line: '220, 38, 38' }
      : palette === 'pink'
      ? { bg0: '#170812', bg1: '#230b1a', bg2: '#331127', line: '236, 72, 153' }
      : palette === 'purple'
        ? { bg0: '#10091f', bg1: '#18102b', bg2: '#24163f', line: '139, 92, 246' }
        : palette === 'orange'
          ? { bg0: '#160c05', bg1: '#211208', bg2: '#321a0b', line: '249, 115, 22' }
          : palette === 'blue'
            ? { bg0: '#07101f', bg1: '#0b1730', bg2: '#102040', line: '37, 99, 235' }
            : { bg0: '#07140e', bg1: '#0b1e14', bg2: '#102b1c', line: '22, 163, 74' };

  return {
    '--bg-0': tinted.bg0,
    '--bg-1': tinted.bg1,
    '--bg-2': tinted.bg2,
    '--bg-surface': `rgba(${tinted.line}, 0.06)`,
    '--bg-elevated': `rgba(${tinted.line}, 0.10)`,
    '--panel': 'rgba(12, 12, 18, 0.88)',
    '--panel-strong': 'rgba(8, 8, 14, 0.96)',
    '--line': `rgba(${tinted.line}, 0.18)`,
    '--line-strong': `rgba(${tinted.line}, 0.30)`,
    '--text-0': '#f8fafc',
    '--text-1': 'rgba(226, 232, 240, 0.84)',
    '--text-2': 'rgba(148, 163, 184, 0.62)',
    '--accent': hue.accent,
    '--accent-light': hue.accentLight,
    '--accent-rgb': hue.accentRgb,
    '--accent-subtle': `rgba(${hue.accentRgb}, 0.18)`,
    '--accent-2': hue.accent2,
    '--accent-2-subtle': `rgba(${hue.accentRgb}, 0.14)`,
    '--chat-assistant-bg': `rgba(${hue.accentRgb}, 0.08)`,
    '--chat-user-bg': `rgba(${hue.accentRgb}, 0.18)`,
    '--thinking-bg': `rgba(${hue.accentRgb}, 0.08)`,
    '--composer-input-bg': `rgba(${hue.accentRgb}, 0.08)`,
    '--danger': hue.danger,
    '--danger-subtle': 'rgba(225, 29, 72, 0.14)',
    '--warning': hue.warning
  };
}

/** Dark, cool blue — “icy” look without using the light `ice-station` preset. */
export const CUSTOM_THEME_FALLBACK_ICE_COOL_DARK: Record<string, string> = {
  '--bg-0': '#0a1018',
  '--bg-1': '#0d1520',
  '--bg-2': '#131c28',
  '--bg-surface': 'rgba(13, 21, 32, 0.94)',
  '--bg-elevated': 'rgba(19, 28, 40, 0.97)',
  '--panel': 'rgba(13, 21, 32, 0.92)',
  '--panel-strong': 'rgba(10, 16, 24, 0.96)',
  '--line': 'rgba(100, 150, 200, 0.14)',
  '--line-strong': 'rgba(120, 170, 220, 0.22)',
  '--text-0': '#f0f6ff',
  '--text-1': 'rgba(199, 216, 240, 0.86)',
  '--text-2': 'rgba(130, 160, 200, 0.55)',
  '--accent': '#3b82f6',
  '--accent-light': '#60a5fa',
  '--accent-rgb': '59, 130, 246',
  '--accent-subtle': 'rgba(59, 130, 246, 0.16)',
  '--accent-2': '#22d3ee',
  '--accent-2-subtle': 'rgba(34, 211, 238, 0.12)',
  '--chat-assistant-bg': 'rgba(59, 130, 246, 0.08)',
  '--chat-user-bg': 'rgba(34, 211, 238, 0.16)',
  '--thinking-bg': 'rgba(59, 130, 246, 0.08)',
  '--composer-input-bg': 'rgba(59, 130, 246, 0.08)',
  '--danger': '#fb7185',
  '--danger-subtle': 'rgba(251, 113, 133, 0.12)',
  '--warning': '#fbbf24'
};

/** Muted slate/gray accents — no green or bright blue. */
export const CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE: Record<string, string> = {
  '--bg-0': '#0c0e12',
  '--bg-1': '#11141a',
  '--bg-2': '#181c24',
  '--bg-surface': 'rgba(17, 20, 26, 0.94)',
  '--bg-elevated': 'rgba(24, 28, 36, 0.97)',
  '--panel': 'rgba(17, 20, 26, 0.92)',
  '--panel-strong': 'rgba(12, 14, 18, 0.96)',
  '--line': 'rgba(148, 163, 184, 0.12)',
  '--line-strong': 'rgba(148, 163, 184, 0.22)',
  '--text-0': '#f1f5f9',
  '--text-1': 'rgba(203, 213, 225, 0.84)',
  '--text-2': 'rgba(148, 163, 184, 0.58)',
  '--accent': '#94a3b8',
  '--accent-light': '#cbd5e1',
  '--accent-rgb': '148, 163, 184',
  '--accent-subtle': 'rgba(148, 163, 184, 0.16)',
  '--accent-2': '#64748b',
  '--accent-2-subtle': 'rgba(100, 116, 139, 0.14)',
  '--chat-assistant-bg': 'rgba(148, 163, 184, 0.08)',
  '--chat-user-bg': 'rgba(148, 163, 184, 0.16)',
  '--thinking-bg': 'rgba(148, 163, 184, 0.08)',
  '--composer-input-bg': 'rgba(148, 163, 184, 0.08)',
  '--danger': '#f87171',
  '--danger-subtle': 'rgba(248, 113, 113, 0.12)',
  '--warning': '#fbbf24'
};

/** Near-white backgrounds, gray borders & accents — pairs with `[data-custom-light='true']` CSS. */
export const CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY: Record<string, string> = {
  '--bg-0': '#fafafa',
  '--bg-1': '#f4f4f5',
  '--bg-2': '#e4e4e7',
  '--bg-surface': 'rgba(250, 250, 250, 0.96)',
  '--bg-elevated': 'rgba(255, 255, 255, 0.98)',
  '--panel': 'rgba(244, 244, 245, 0.94)',
  '--panel-strong': 'rgba(255, 255, 255, 0.97)',
  '--line': 'rgba(15, 23, 42, 0.08)',
  '--line-strong': 'rgba(15, 23, 42, 0.14)',
  '--text-0': '#18181b',
  '--text-1': 'rgba(24, 24, 27, 0.78)',
  '--text-2': 'rgba(82, 82, 91, 0.58)',
  '--accent': '#64748b',
  '--accent-light': '#475569',
  '--accent-rgb': '100, 116, 139',
  '--accent-subtle': 'rgba(100, 116, 139, 0.12)',
  '--accent-2': '#71717a',
  '--accent-2-subtle': 'rgba(113, 113, 122, 0.12)',
  '--chat-assistant-bg': 'rgba(100, 116, 139, 0.06)',
  '--chat-user-bg': 'rgba(100, 116, 139, 0.13)',
  '--thinking-bg': 'rgba(100, 116, 139, 0.06)',
  '--composer-input-bg': 'rgba(255, 255, 255, 0.72)',
  '--danger': '#dc2626',
  '--danger-subtle': 'rgba(220, 38, 38, 0.08)',
  '--warning': '#d97706'
};

export const CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI: Record<string, string> = {
  '--bg-0': '#0b1210',
  '--bg-1': '#0f1714',
  '--bg-2': '#15201b',
  '--bg-surface': 'rgba(15, 23, 20, 0.94)',
  '--bg-elevated': 'rgba(22, 32, 28, 0.97)',
  '--panel': 'rgba(15, 23, 20, 0.92)',
  '--panel-strong': 'rgba(12, 18, 16, 0.96)',
  '--line': 'rgba(148, 180, 160, 0.12)',
  '--line-strong': 'rgba(148, 180, 160, 0.22)',
  '--text-0': '#eef7f2',
  '--text-1': 'rgba(214, 232, 220, 0.85)',
  '--text-2': 'rgba(148, 180, 160, 0.58)',
  '--accent': '#22c55e',
  '--accent-light': '#4ade80',
  '--accent-rgb': '34, 197, 94',
  '--accent-subtle': 'rgba(34, 197, 94, 0.14)',
  '--accent-2': '#14b8a6',
  '--accent-2-subtle': 'rgba(20, 184, 166, 0.14)',
  '--chat-assistant-bg': 'rgba(34, 197, 94, 0.08)',
  '--chat-user-bg': 'rgba(34, 197, 94, 0.18)',
  '--thinking-bg': 'rgba(34, 197, 94, 0.08)',
  '--composer-input-bg': 'rgba(34, 197, 94, 0.08)',
  '--danger': '#fb7185',
  '--danger-subtle': 'rgba(251, 113, 133, 0.12)',
  '--warning': '#fbbf24'
};

/** Rough luminance probe for `[data-custom-light]` and merge replace behavior. */
export function isLikelyLightCssBackground(value: string | undefined): boolean {
  if (value == null) return false;
  const s = value.trim().toLowerCase();
  if (s === 'white' || s === '#fff' || s === '#ffffff' || s === 'snow') return true;
  const hex6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex6) {
    const r = parseInt(hex6[1].slice(0, 2), 16);
    const g = parseInt(hex6[1].slice(2, 4), 16);
    const b = parseInt(hex6[1].slice(4, 6), 16);
    return (r + g + b) / 3 > 210 || (r > 238 && g > 238); /* permit off-whites */
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(s);
  if (hex3) {
    const ch = hex3[1];
    const r = parseInt(ch[0] + ch[0], 16);
    const g = parseInt(ch[1] + ch[1], 16);
    const bch = parseInt(ch[2] + ch[2], 16);
    return (r + g + bch) / 3 > 210;
  }
  return /^#f[A-Fa-f0-9]{2}[A-Fa-f0-9]{2}[A-Fa-f0-9]{2}/i.test(s);
}

/** When replacing dark custom leftovers with a bright theme, omit keys from the old layer. */
export function shouldReplaceFullCustomPalette(
  hadUserTokens: boolean,
  mergedPartial: Record<string, string>,
  resolvedPaletteId: MergeThemePaletteId | undefined,
  mergedBgCandidate: string | undefined
): boolean {
  if (resolvedPaletteId === 'light_paper_gray') return true;
  if (hadUserTokens && mergedBgCandidate && isLikelyLightCssBackground(mergedBgCandidate)) return true;
  return false;
}

/** When the model sends no valid token map, pick a built-in palette (weak models often omit CSS). */
export function resolveCustomThemeFallback(paletteHint: string | undefined): {
  tokens: Record<string, string>;
  id: MergeThemePaletteId;
} {
  const raw = paletteHint?.trim().toLowerCase() ?? '';
  if (raw === 'ice_cool_dark') {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_ICE_COOL_DARK }, id: 'ice_cool_dark' };
  }
  if (raw === 'neutral_slate_dark') {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE }, id: 'neutral_slate_dark' };
  }
  if (raw === 'light_paper_gray') {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY }, id: 'light_paper_gray' };
  }
  if (raw === 'soft_kiwi_dark' || raw === '') {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI }, id: 'soft_kiwi_dark' };
  }

  const mentionsWhitePaper =
    /\b(all[-_\s]?white|white\b|paper\b|ivory\b|cream\b|snow\b|milky\b|pastel\b|bright\b\s*(theme|bg|palette|appearance|ui))\b/i.test(raw) ||
    (/\blight\b/i.test(raw) &&
      /\b(theme|themes|palette|appearance|bg|background|scheme|chrome|bright)\b/i.test(raw) &&
      !/\bdark\b/i.test(raw));

  const isIce =
    /\b(?:icy|ice[-_\s]?station|ice_cool|icecool)\b/i.test(raw) ||
    /\bice\b/i.test(raw) && /\b(?:dark|blue|cool|station)\b/i.test(raw) ||
    (raw.includes('cool') && /\b(?:blue|icy|cold)\b/i.test(raw));
  const looksNeutralMuted =
    /\bneutral\b/i.test(raw) ||
    /\bgray\b|\bgrey\b|\bslate\b/i.test(raw) ||
    /\bmuted\b|\bmonochrome\b/i.test(raw) ||
    /\bneutral[-_\s]?slate\b/i.test(raw);

  if (mentionsWhitePaper) {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_LIGHT_PAPER_GRAY }, id: 'light_paper_gray' };
  }

  if (looksNeutralMuted && !isIce) {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_NEUTRAL_SLATE }, id: 'neutral_slate_dark' };
  }

  if (isIce) {
    return { tokens: { ...CUSTOM_THEME_FALLBACK_ICE_COOL_DARK }, id: 'ice_cool_dark' };
  }

  return { tokens: { ...CUSTOM_THEME_FALLBACK_SOFT_NIGHT_KIWI }, id: 'soft_kiwi_dark' };
}
