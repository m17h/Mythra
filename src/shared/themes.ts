/** Single source for theme ids, names, and Settings theme tiles. */
export const themeCatalog = [
  { id: 'neon-grid' as const, name: 'Neon Grid', preview: 'Cyan / Lime / Deep Navy' },
  { id: 'sunset-terminal' as const, name: 'Sunset Terminal', preview: 'Coral / Amber / Plum' },
  { id: 'ice-station' as const, name: 'Ice Station', preview: 'Blue / Mint / Graphite' },
  { id: 'kiwi' as const, name: 'Kiwi', preview: 'Green / Teal / Graphite (light)' }
] as const;

export type ThemeId = (typeof themeCatalog)[number]['id'];

export const THEME_IDS: readonly ThemeId[] = themeCatalog.map((t) => t.id);

export function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value);
}

export function getThemeName(themeId: string): string {
  const entry = themeCatalog.find((t) => t.id === themeId);
  return entry?.name ?? themeId;
}
