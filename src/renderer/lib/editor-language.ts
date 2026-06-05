const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  csv: 'csv',
  cts: 'typescript',
  dockerfile: 'dockerfile',
  go: 'go',
  h: 'cpp',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  less: 'less',
  lock: 'json',
  log: 'plaintext',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell'
};

const BASENAME_LANGUAGE_MAP: Record<string, string> = {
  '.env': 'shell',
  '.gitignore': 'ignore',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  license: 'plaintext'
};

export function monacoLanguageFromPath(filePath: string | undefined): string {
  if (!filePath) return 'plaintext';
  const basename = filePath.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() ?? '';
  if (BASENAME_LANGUAGE_MAP[basename]) return BASENAME_LANGUAGE_MAP[basename];
  const extension = basename.includes('.') ? basename.split('.').pop() ?? '' : '';
  return EXTENSION_LANGUAGE_MAP[extension] ?? 'plaintext';
}
