import type { AppSettings } from '@shared/types';
import { premiumSearchTryOrder } from './web-search';

function tryParseArgs(raw: string | undefined): Record<string, unknown> | null {
  if (raw == null || !raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ss(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Short file label (basename); prefers the last segment of relative paths */
function displayFile(path: unknown): string {
  const raw = ss(path).replace(/\\/g, '/').trim();
  if (!raw) return 'file';
  const parts = raw.split('/').filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : raw;
  return base ?? raw;
}

function truncateSnippet(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function webSearchProviderLabel(search: AppSettings['search']): string {
  const head = premiumSearchTryOrder(search)[0];
  if (head === 'tavily') return 'Tavily';
  if (head === 'brave') return 'Brave Search';
  return 'DuckDuckGo';
}

function humanFallback(toolName: string): string {
  return toolName.replace(/_/g, ' ');
}

/** User-facing summary when a tool invocation starts (`Tool` row). */
export function formatToolActivityStart(toolName: string, rawArguments: string | undefined, settings: AppSettings): string {
  const args = tryParseArgs(rawArguments);
  if (args === null) {
    return `Using ${humanFallback(toolName)}`;
  }

  switch (toolName) {
    case 'web_search': {
      const q = truncateSnippet(ss(args.query), 100);
      if (!q) return 'Searching the web';
      const who = webSearchProviderLabel(settings.search);
      return `Searching with ${who} for "${q}"`;
    }
    case 'read_file':
      return `Reading ${displayFile(args.path)}`;
    case 'write_file':
      return `Writing ${displayFile(args.path)}`;
    case 'replace_in_file':
      return `Editing ${displayFile(args.path)}`;
    case 'insert_after':
      return `Inserting into ${displayFile(args.path)}`;
    case 'apply_patch':
      return 'Applying a patch';
    case 'rename_file': {
      const from = displayFile(args.from);
      const to = displayFile(args.to);
      return `Renaming ${from} → ${to}`;
    }
    case 'delete_path':
      return `Deleting ${displayFile(args.path)}`;
    case 'list_files':
      return 'Listing workspace files';
    case 'search_symbols': {
      const q = truncateSnippet(ss(args.query), 80);
      return q ? `Searching code for "${q}"` : 'Searching project code';
    }
    case 'get_file_outline':
      return `Showing outline of ${displayFile(args.path)}`;
    case 'get_git_diff':
      return 'Checking workspace changes';
    case 'run_command': {
      const cmd = truncateSnippet(ss(args.command), 70);
      return cmd ? `Running: ${cmd}` : 'Running a command';
    }
    case 'run_tests': {
      const cmd = truncateSnippet(ss(args.command) || 'npm test', 70);
      return `Running tests: ${cmd}`;
    }
    case 'set_app_theme': {
      const id = truncateSnippet(ss((args as { theme_id?: string }).theme_id), 48);
      return id ? `Switching theme to ${id}` : 'Changing app theme';
    }
    case 'merge_custom_theme_tokens':
      return 'Updating custom theme colors';
    case 'set_custom_theme':
      return 'Applying a custom theme';
    case 'get_app_theme':
      return 'Reading current theme';
    case 'get_tool_access':
      return 'Reading tool permissions';
    case 'get_system_prompt':
      return 'Reading AI instructions (system prompt)';
    case 'get_wizard_system_prompt':
      return 'Reading Wizard instructions';
    case 'set_system_prompt':
      return 'Updating system prompt';
    case 'set_wizard_system_prompt':
      return 'Updating Wizard instructions';
    case 'set_wizard_display_name': {
      const name = truncateSnippet(ss((args as { display_name?: string }).display_name), 64);
      return name ? `Renaming Wizard to “${name}”` : 'Renaming Wizard';
    }
    case 'revert_app_theme':
      return 'Reverting theme';
    default:
      return `Using ${humanFallback(toolName)}`;
  }
}

/** User-facing summary when a tool invocation finishes (`Update` row). */
export function formatToolActivityDone(toolName: string, rawArguments: string | undefined): string {
  const args = tryParseArgs(rawArguments);
  if (args === null) {
    return `Finished (${humanFallback(toolName)})`;
  }

  switch (toolName) {
    case 'web_search':
      return 'Search finished';
    case 'read_file':
      return `Read ${displayFile(args.path)}`;
    case 'write_file':
      return `Wrote ${displayFile(args.path)}`;
    case 'replace_in_file':
      return `Updated ${displayFile(args.path)}`;
    case 'insert_after':
      return `Inserted into ${displayFile(args.path)}`;
    case 'apply_patch':
      return 'Patch applied';
    case 'rename_file':
      return `Renamed ${displayFile(args.from)} → ${displayFile(args.to)}`;
    case 'delete_path':
      return `Deleted ${displayFile(args.path)}`;
    case 'list_files':
      return 'Listed files';
    case 'search_symbols':
      return 'Code search finished';
    case 'get_file_outline':
      return `Outlined ${displayFile(args.path)}`;
    case 'get_git_diff':
      return 'Change check finished';
    case 'run_command':
      return 'Command finished';
    case 'run_tests':
      return 'Tests finished';
    case 'set_app_theme':
      return 'Theme updated';
    case 'merge_custom_theme_tokens':
    case 'set_custom_theme':
      return 'Theme updated';
    case 'get_app_theme':
      return 'Theme details loaded';
    case 'get_tool_access':
      return 'Permissions loaded';
    case 'get_system_prompt':
    case 'get_wizard_system_prompt':
      return 'Instructions loaded';
    case 'set_system_prompt':
    case 'set_wizard_system_prompt':
      return 'Instructions saved';
    case 'set_wizard_display_name':
      return 'Wizard name saved';
    case 'revert_app_theme':
      return 'Theme reverted';
    default:
      return 'Done';
  }
}
