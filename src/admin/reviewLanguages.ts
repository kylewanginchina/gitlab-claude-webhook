import path from 'path';

const EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rs': 'rust',
  '.go': 'go',
  '.py': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.proto': 'protobuf',
  '.tf': 'terraform',
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  'c++': 'cpp',
  cpp: 'cpp',
  'c#': 'csharp',
  proto: 'protobuf',
  protobuf: 'protobuf',
};

for (const language of new Set(Object.values(EXTENSIONS))) {
  ALIASES[language] = language;
}
ALIASES.docker = 'dockerfile';
ALIASES.dockerfile = 'dockerfile';

export function normalizeReviewLanguageHint(value: string): string | null {
  return ALIASES[value.trim().toLowerCase()] || null;
}

export function detectReviewLanguages(paths: string[]): Set<string> {
  const languages = new Set<string>();
  for (const filePath of paths) {
    const base = path.posix.basename(filePath).toLowerCase();
    if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
      languages.add('dockerfile');
      continue;
    }
    const language = EXTENSIONS[path.posix.extname(base)];
    if (language) {
      languages.add(language);
    }
  }
  return languages;
}
