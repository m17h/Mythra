import { describe, expect, it } from 'vitest';
import { diffLineClass, parseDiffGroups } from './diff-view';

describe('diff view helpers', () => {
  it('classifies diff lines', () => {
    expect(diffLineClass('@@ -1,1 +1,1 @@')).toContain('hunk');
    expect(diffLineClass('+added')).toContain('add');
    expect(diffLineClass('-removed')).toContain('del');
  });

  it('groups diff by file and reports truncation', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.ts b/b.ts',
      '+next'
    ].join('\n');

    const result = parseDiffGroups(diff, 7);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.title).toBe('a.ts');
    expect(result.groups[1]?.title).toBe('b.ts');
    expect(result.truncated).toBe(true);
    expect(result.originalLineCount).toBe(8);
  });
});
