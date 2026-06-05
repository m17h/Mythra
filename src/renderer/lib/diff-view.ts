export interface DiffLine {
  id: string;
  text: string;
  className: string;
}

export interface DiffFileGroup {
  id: string;
  title: string;
  lines: DiffLine[];
  patchHeader: string[];
}

export const diffLineClass = (line: string) => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'changes-diff__line--file';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'changes-diff__line--meta';
  if (line.startsWith('@@')) return 'changes-diff__line--hunk';
  if (line.startsWith('+')) return 'changes-diff__line--add';
  if (line.startsWith('-')) return 'changes-diff__line--del';
  return '';
};

function diffTitleFromHeader(line: string, fallback: string): string {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return match?.[2] ?? fallback;
}

export function parseDiffGroups(diff: string, maxLines = Number.POSITIVE_INFINITY): {
  groups: DiffFileGroup[];
  originalLineCount: number;
  truncated: boolean;
} {
  const trimmed = diff.trim();
  if (!trimmed) return { groups: [], originalLineCount: 0, truncated: false };

  const rawLines = trimmed.split('\n');
  const visibleLines = rawLines.slice(0, maxLines);
  const groups: DiffFileGroup[] = [];
  let current: DiffFileGroup | null = null;

  const ensureGroup = (title: string) => {
    if (!current) {
      current = { id: `diff-group-${groups.length}`, title, lines: [], patchHeader: [] };
      groups.push(current);
    }
    return current;
  };

  visibleLines.forEach((line, index) => {
    if (line.startsWith('diff --git')) {
      current = {
        id: `diff-group-${groups.length}`,
        title: diffTitleFromHeader(line, `File ${groups.length + 1}`),
        lines: [],
        patchHeader: []
      };
      groups.push(current);
    }
    const group = ensureGroup('Diff');
    if (!line.startsWith('@@') && group.lines.every((existing) => !existing.text.startsWith('@@'))) {
      group.patchHeader.push(line);
    }
    group.lines.push({
      id: `${index}-${line.slice(0, 24)}`,
      text: line || ' ',
      className: diffLineClass(line)
    });
  });

  return {
    groups,
    originalLineCount: rawLines.length,
    truncated: rawLines.length > visibleLines.length
  };
}
