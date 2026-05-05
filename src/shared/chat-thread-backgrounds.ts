import type { ThemeId } from './themes';

/** Built-in chat thread background packs (each may ship multiple theme-matched images). */
export type ChatThreadBackgroundPresetId = 'mystic';

export const CHAT_THREAD_BUILTIN_PRESETS: readonly {
  id: ChatThreadBackgroundPresetId;
  label: string;
  description: string;
}[] = [
  {
    id: 'mystic',
    label: 'Mystic',
    description:
      'Built-in art that tracks the UI theme: each preset tile gets a matching image; Custom uses the **light Mystic (ice)** artwork when the custom theme is light and the **dark (neon)** artwork when it is dark. Chat tints (`--chat-thread-bg`, bubble colors) layer on top so the thread matches your accent.'
  }
];

export type MysticVariant = 'neon' | 'sunset' | 'ice' | 'kiwi';

/** Which Mystic image file key to use for the active UI theme. */
export function mysticVariantForTheme(themeId: ThemeId, customThemeLight: boolean): MysticVariant {
  switch (themeId) {
    case 'neon-grid':
      return 'neon';
    case 'sunset-terminal':
      return 'sunset';
    case 'ice-station':
      return 'ice';
    case 'kiwi':
      return 'kiwi';
    case 'custom':
      return customThemeLight ? 'ice' : 'neon';
  }
}

export function isChatThreadBackgroundPresetId(value: string): value is ChatThreadBackgroundPresetId {
  return value === 'mystic';
}
