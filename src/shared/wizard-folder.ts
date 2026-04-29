/**
 * Folder basename derived from a Wizard display name (must stay aligned with main-process workspace naming).
 */
export function sanitizeWizardFolderSegment(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim() || 'OpenKiwi Wizard';
}
