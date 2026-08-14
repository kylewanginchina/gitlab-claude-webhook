import fs from 'fs/promises';
import path from 'path';
import { simpleGit } from 'simple-git';

export type ProgressStatus =
  | 'queued'
  | 'running'
  | 'search'
  | 'read'
  | 'command'
  | 'review'
  | 'warning'
  | 'error'
  | 'success';

export interface ProgressEntry {
  timestamp: Date;
  status: ProgressStatus;
  message: string;
}

export interface ProgressCommentOptions {
  entries: ProgressEntry[];
  isComplete?: boolean;
  isError?: boolean;
  startedAt?: Date;
  updatedAt?: Date;
}

export interface ReviewLinkContext {
  projectPath: string;
  projectUrl: string;
  ref: string;
}

interface FileTarget {
  path: string;
  line?: number;
}

const TIME_ZONE = 'Asia/Shanghai';
const TIME_ZONE_OFFSET_LABEL = 'UTC+08:00';
const MAX_PROJECT_FILES = 20000;
const MAX_SYMBOL_FILE_BYTES = 1024 * 1024;

const CODE_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.go',
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.m',
  '.mm',
]);

export function sanitizeProgressMessage(message: string): string {
  const withoutPrefix = message
    .replace(/^[\s\p{Extended_Pictographic}\uFE0F]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();

  const successNormalized = withoutPrefix.replace(/!+$/, '.');

  const grepMatch = successNormalized.match(/^Grep\s+(.+?)\s+in\s+(.+)$/i);
  if (grepMatch) {
    return `Grep ${formatInlineCode(grepMatch[1] || '')} in ${formatInlineCode(grepMatch[2] || '')}`;
  }

  const readMatch = successNormalized.match(/^Read\s+(.+)$/i);
  if (readMatch) {
    return `Read ${formatInlineCode(readMatch[1] || '')}`;
  }

  const bashMatch = successNormalized.match(/^Bash\s+(.+)$/i);
  if (bashMatch) {
    return `Bash ${formatInlineCode(bashMatch[1] || '')}`;
  }

  const globMatch = successNormalized.match(/^Glob\s+(.+)$/i);
  if (globMatch) {
    return `Glob ${formatInlineCode(globMatch[1] || '')}`;
  }

  return successNormalized;
}

export function inferProgressStatus(
  message: string,
  isComplete?: boolean,
  isError?: boolean
): ProgressStatus {
  if (isError) {
    return 'error';
  }
  if (isComplete || /completed successfully/i.test(message)) {
    return 'success';
  }
  if (/validation command failed|failed|warning|skipped/i.test(message)) {
    return 'warning';
  }
  if (/^🔎|^Grep\b/i.test(message)) {
    return 'search';
  }
  if (/^📖|^Read\b/i.test(message)) {
    return 'read';
  }
  if (/^💻|^Bash\b/i.test(message)) {
    return 'command';
  }
  if (/review/i.test(message)) {
    return 'review';
  }
  if (/starting|initialized|queued/i.test(message)) {
    return 'queued';
  }
  return 'running';
}

export function formatProgressComment(options: ProgressCommentOptions): string {
  const updatedAt = options.updatedAt || new Date();
  const entries = options.entries.slice(-10);
  const lines = ['### AI Agent Progress Report', ''];

  if (options.startedAt) {
    lines.push(
      `**Started:** ${formatDateTime(options.startedAt)}`,
      `**Elapsed:** ${formatDuration(updatedAt.getTime() - options.startedAt.getTime())}`,
      ''
    );
  }

  lines.push('| Time (UTC+08) | Status | Activity |', '| --- | --- | --- |');

  for (const entry of entries) {
    lines.push(
      `| ${formatTime(entry.timestamp)} | ${statusLabel(entry.status)} | ${escapeTableCell(
        sanitizeProgressMessage(entry.message)
      )} |`
    );
  }

  if (entries.length === 0) {
    lines.push(`| ${formatTime(updatedAt)} | Queued | Waiting for the first progress update. |`);
  }

  lines.push('', '---', '');

  if (options.isComplete) {
    lines.push(
      options.isError ? '**Status:** Completed with errors' : '**Status:** Completed successfully'
    );
  } else {
    lines.push('**Status:** In progress');
  }

  lines.push('', `_Last updated: ${formatDateTime(updatedAt)}_`);

  return lines.join('\n');
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function isServiceStatusCommentBody(body: string): boolean {
  const trimmed = body.trim();
  return (
    trimmed.startsWith('### AI Agent Progress Report') ||
    trimmed.startsWith('### AI Agent Queue Status') ||
    trimmed.startsWith('**AI Agent Queue Status**') ||
    trimmed.startsWith('AI Agent Queue Status') ||
    trimmed.startsWith('**Updated Progress:**') ||
    trimmed.startsWith('Updated Progress:') ||
    /^#+\s+AI Agent Progress Report/m.test(trimmed) ||
    /^#+\s+AI Agent Queue Status/m.test(trimmed)
  );
}

export async function linkifyReviewReferences(
  output: string,
  context: ReviewLinkContext
): Promise<string> {
  if (!output.trim()) {
    return output;
  }

  const codeSegments = extractInlineCodeSegments(output);
  if (codeSegments.length === 0) {
    return output;
  }

  const fileCandidates = new Set<string>();
  const symbolCandidates = new Set<string>();

  for (const segment of codeSegments) {
    const fileRef = parseFileReference(segment);
    if (fileRef && looksLikeFileReference(fileRef.path)) {
      fileCandidates.add(fileRef.path);
    }

    const symbol = parseFunctionSymbol(segment);
    if (symbol) {
      symbolCandidates.add(symbol);
    }
  }

  if (fileCandidates.size === 0 && symbolCandidates.size === 0) {
    return output;
  }

  const projectFiles = await listProjectFiles(context.projectPath);
  const fileTargets = resolveFileTargets(projectFiles, fileCandidates);
  const symbolTargets =
    symbolCandidates.size > 0
      ? await resolveSymbolTargets(context.projectPath, projectFiles, symbolCandidates)
      : new Map<string, FileTarget>();

  return replaceInlineCodeSegments(output, segment => {
    const fileRef = parseFileReference(segment);
    if (fileRef && looksLikeFileReference(fileRef.path)) {
      const target = fileTargets.get(fileRef.path);
      if (target) {
        return linkInlineCode(segment, buildBlobUrl(context, target.path, fileRef.line));
      }
    }

    const symbol = parseFunctionSymbol(segment);
    if (symbol) {
      const target = symbolTargets.get(symbol);
      if (target) {
        return linkInlineCode(segment, buildBlobUrl(context, target.path, target.line));
      }
    }

    return null;
  });
}

function formatInlineCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '``';
  }
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed;
  }
  return `\`${trimmed}\``;
}

function formatTime(date: Date): string {
  return formatDateParts(date).time;
}

function formatDateTime(date: Date): string {
  const parts = formatDateParts(date);
  return `${parts.date} ${parts.time} ${TIME_ZONE_OFFSET_LABEL}`;
}

function formatDateParts(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function statusLabel(status: ProgressStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'search':
      return 'Search';
    case 'read':
      return 'Read';
    case 'command':
      return 'Command';
    case 'review':
      return 'Review';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'success':
      return 'Completed';
    case 'running':
    default:
      return 'Running';
  }
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function extractInlineCodeSegments(markdown: string): string[] {
  const segments: string[] = [];
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      if (match[1]) {
        segments.push(match[1]);
      }
    }
  }

  return segments;
}

function replaceInlineCodeSegments(
  markdown: string,
  replacementFor: (segment: string) => string | null
): string {
  let inFence = false;
  const lines = markdown.split('\n');

  return lines
    .map(line => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }

      return line.replace(/`([^`\n]+)`/g, (match, segment: string, offset: number) => {
        if (offset > 0 && line[offset - 1] === '[') {
          return match;
        }

        return replacementFor(segment) || match;
      });
    })
    .join('\n');
}

function parseFileReference(segment: string): FileTarget | null {
  const trimmed = segment.trim();
  const match = trimmed.match(/^(.+?)(?::(\d+)|#L(\d+))?$/);
  if (!match?.[1]) {
    return null;
  }

  return {
    path: normalizePath(match[1]),
    line: match[2] || match[3] ? Number(match[2] || match[3]) : undefined,
  };
}

function parseFunctionSymbol(segment: string): string | null {
  const match = segment.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\(\)$/);
  return match?.[1] || null;
}

function looksLikeFileReference(filePath: string): boolean {
  const basename = path.posix.basename(filePath);
  return filePath.includes('/') || /\.[A-Za-z0-9_+-]+$/.test(basename);
}

async function listProjectFiles(projectPath: string): Promise<string[]> {
  try {
    const output = await simpleGit(projectPath).raw(['ls-files']);
    const files = output
      .split('\n')
      .map(file => normalizePath(file))
      .filter(Boolean);
    if (files.length > 0) {
      return files.slice(0, MAX_PROJECT_FILES);
    }
  } catch {
    // Fall through to filesystem walk for temporary test fixtures or non-git workspaces.
  }

  const files: string[] = [];
  await walkProjectFiles(projectPath, '', files);
  return files.slice(0, MAX_PROJECT_FILES);
}

async function walkProjectFiles(root: string, relativeDir: string, files: string[]): Promise<void> {
  if (files.length >= MAX_PROJECT_FILES) {
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_PROJECT_FILES) {
      return;
    }

    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }

    const nextRelative = normalizePath(path.posix.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      await walkProjectFiles(root, nextRelative, files);
    } else if (entry.isFile()) {
      files.push(nextRelative);
    }
  }
}

function resolveFileTargets(
  projectFiles: string[],
  candidates: Set<string>
): Map<string, FileTarget> {
  const resolved = new Map<string, FileTarget>();

  for (const candidate of candidates) {
    const target = resolveProjectFile(projectFiles, candidate);
    if (target) {
      resolved.set(candidate, { path: target });
    }
  }

  return resolved;
}

function resolveProjectFile(projectFiles: string[], candidate: string): string | null {
  const normalized = normalizePath(candidate);
  if (projectFiles.includes(normalized)) {
    return normalized;
  }

  const suffixMatches = projectFiles.filter(file => file.endsWith(`/${normalized}`));
  if (suffixMatches.length === 1) {
    return suffixMatches[0] || null;
  }

  const basename = path.posix.basename(normalized);
  const basenameMatches = projectFiles.filter(file => path.posix.basename(file) === basename);
  return basenameMatches.length === 1 ? basenameMatches[0] || null : null;
}

async function resolveSymbolTargets(
  projectPath: string,
  projectFiles: string[],
  symbols: Set<string>
): Promise<Map<string, FileTarget>> {
  const matches = new Map<string, FileTarget[]>();
  for (const symbol of symbols) {
    matches.set(symbol, []);
  }

  for (const file of projectFiles) {
    if (!isCodeFile(file)) {
      continue;
    }

    const absolutePath = path.join(projectPath, file);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      continue;
    }

    if (stat.size > MAX_SYMBOL_FILE_BYTES) {
      continue;
    }

    let content;
    try {
      content = await fs.readFile(absolutePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const symbol of symbols) {
      const line = findSymbolDefinitionLine(lines, symbol);
      if (line) {
        matches.get(symbol)?.push({ path: file, line });
      }
    }
  }

  const resolved = new Map<string, FileTarget>();
  for (const [symbol, targets] of matches) {
    if (targets.length === 1 && targets[0]) {
      resolved.set(symbol, targets[0]);
    }
  }

  return resolved;
}

function findSymbolDefinitionLine(lines: string[], symbol: string): number | null {
  const escaped = escapeRegExp(symbol);
  const definitionPattern = new RegExp(`\\b${escaped}\\s*\\([^;]*\\)\\s*(?:\\{|$)`);
  const fallbackPattern = new RegExp(`\\b${escaped}\\s*\\(`);

  for (let index = 0; index < lines.length; index += 1) {
    if (definitionPattern.test(lines[index] || '')) {
      return index + 1;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (fallbackPattern.test(lines[index] || '')) {
      return index + 1;
    }
  }

  return null;
}

function isCodeFile(filePath: string): boolean {
  return CODE_FILE_EXTENSIONS.has(path.posix.extname(filePath));
}

function linkInlineCode(label: string, url: string): string {
  return `[\`${label}\`](${url})`;
}

function buildBlobUrl(context: ReviewLinkContext, filePath: string, line?: number): string {
  const encodedRef = encodeURIComponent(context.ref);
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `${context.projectUrl}/-/blob/${encodedRef}/${encodedPath}${line ? `#L${line}` : ''}`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
