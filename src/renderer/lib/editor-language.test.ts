import { describe, expect, it } from 'vitest';
import { monacoLanguageFromPath } from './editor-language';

describe('monacoLanguageFromPath', () => {
  it('detects common source languages', () => {
    expect(monacoLanguageFromPath('/repo/src/App.tsx')).toBe('typescript');
    expect(monacoLanguageFromPath('/repo/server.py')).toBe('python');
    expect(monacoLanguageFromPath('styles/main.css')).toBe('css');
  });

  it('handles special basenames and unknown files', () => {
    expect(monacoLanguageFromPath('/repo/.env')).toBe('shell');
    expect(monacoLanguageFromPath('/repo/Dockerfile')).toBe('dockerfile');
    expect(monacoLanguageFromPath('/repo/file.unknown')).toBe('plaintext');
  });
});
