import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { detectReviewLanguages, normalizeReviewLanguageHint } from '../admin/reviewLanguages';

/**
 * A review skill discovered on disk in Agent SDK SKILL.md format.
 *
 * Matching metadata lives in the SKILL.md frontmatter under `metadata:`:
 *   review-always: "true"                      -> included in every pass and in scoring
 *   review-passes: "bug-scan,history-context"  -> only for these pass ids (empty = any pass)
 *   review-languages: "typescript,javascript"  -> only when the diff contains these languages
 *   review-globs: "**\/*.test.*,**\/tests/**"  -> only when a changed file matches a glob
 */
export interface ReviewSkillDefinition {
  name: string;
  description: string;
  body: string;
  filePath: string;
  /** Whether the SDK exposes this skill as a slash command; defaults to true. */
  userInvocable: boolean;
  always: boolean;
  passIds: string[];
  languages: string[];
  globs: string[];
}

export interface ReviewSkillMatchInput {
  passId: string;
  changedFiles: string[];
}

interface ParsedFrontmatter {
  fields: Record<string, string>;
  metadata: Record<string, string>;
  body: string;
}

export class ReviewSkillConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewSkillConfigurationError';
  }
}

export class ReviewSkillCatalog {
  private cache: { dir: string; mtimeKey: string; skills: ReviewSkillDefinition[] } | null = null;
  private pluginName: string | null = null;

  private readonly skillsDir: string;

  constructor(skillsDir: string) {
    // Capture the service cwd once; SDK queries execute in a different MR checkout.
    this.skillsDir = path.resolve(skillsDir);
  }

  public getSkillsDir(): string {
    return this.skillsDir;
  }

  public getPluginDir(): string {
    return this.skillsDir;
  }

  /** Plugin name from `.claude-plugin/plugin.json`; the SDK namespaces skills as `<plugin>:<skill>`. */
  public getPluginName(): string {
    if (this.pluginName) {
      return this.pluginName;
    }
    let name = '';
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(this.skillsDir, '.claude-plugin', 'plugin.json'), 'utf8')
      ) as { name?: unknown };
      name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    } catch {
      // fall through to the directory name
    }
    this.pluginName = name || path.basename(this.skillsDir);
    return this.pluginName;
  }

  /**
   * Slash command that makes the Agent SDK expand a skill's body into the first user turn.
   * The SDK only expands a slash command that starts the prompt, and only the first one.
   */
  public getInvocationCommand(skillName: string): string {
    return `/${this.getPluginName()}:${skillName}`;
  }

  public isAvailable(): boolean {
    try {
      return fs.statSync(path.join(this.skillsDir, 'skills')).isDirectory();
    } catch {
      return false;
    }
  }

  /** Fail closed for enabled review stages while keeping inspection APIs harmless. */
  public assertUsable(): void {
    try {
      const manifestPath = path.join(this.skillsDir, '.claude-plugin', 'plugin.json');
      let manifestRaw: string | undefined;
      try {
        manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      } catch (error) {
        // The SDK supports manifest-less custom plugins, namespaced by directory name.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (manifestRaw !== undefined) {
        const manifest = JSON.parse(manifestRaw) as { name?: unknown };
        if (typeof manifest?.name !== 'string' || !manifest.name.trim()) {
          throw new Error(`Plugin manifest must define a non-empty name: ${manifestPath}`);
        }
      }

      const skillsRoot = path.join(this.skillsDir, 'skills');
      const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(skillsRoot, entry.name, 'SKILL.md');
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = parseFrontmatter(raw);
        if (
          /^---(?:\r?\n|$)/.test(raw) &&
          !/^---\n[\s\S]*?\n---(?:\n|$)/.test(raw.replace(/\r\n/g, '\n'))
        ) {
          throw new Error(`Review skill frontmatter is not closed: ${filePath}`);
        }
        if (!parsed.body.trim()) {
          throw new Error(`Review skill body is empty: ${filePath}`);
        }
        count += 1;
      }
      if (count === 0) {
        throw new Error(`No review skills found in ${skillsRoot}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ReviewSkillConfigurationError(
        `Review skill configuration error at "${this.skillsDir}": ${reason}. ` +
          'Set REVIEW_SKILLS_DIR to a readable plugin directory or disable REVIEW_USE_BUILTIN_SKILLS.'
      );
    }
  }

  public listSkills(): ReviewSkillDefinition[] {
    const skillsRoot = path.join(this.skillsDir, 'skills');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const mtimeKey = entries
      .map(entry => {
        try {
          return `${entry.name}:${fs.statSync(path.join(skillsRoot, entry.name, 'SKILL.md')).mtimeMs}`;
        } catch {
          return `${entry.name}:missing`;
        }
      })
      .join('|');

    if (this.cache && this.cache.dir === skillsRoot && this.cache.mtimeKey === mtimeKey) {
      return this.cache.skills;
    }

    const skills: ReviewSkillDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const filePath = path.join(skillsRoot, entry.name, 'SKILL.md');
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const parsed = parseFrontmatter(raw);
      const name = parsed.fields.name?.trim() || entry.name;
      if (name !== entry.name) {
        logger.warn('Review skill directory name does not match SKILL.md name', {
          directory: entry.name,
          name,
        });
      }

      skills.push({
        name,
        description: parsed.fields.description?.trim() || '',
        body: parsed.body.trim(),
        filePath,
        userInvocable: !/^false(?:\s+#.*)?$/i.test(parsed.fields['user-invocable'] || ''),
        always: /^(true|yes|1)$/i.test(parsed.metadata['review-always'] || ''),
        passIds: splitList(parsed.metadata['review-passes']),
        languages: splitList(parsed.metadata['review-languages'])
          .map(normalizeReviewLanguageHint)
          .filter((language): language is string => Boolean(language)),
        globs: splitList(parsed.metadata['review-globs']),
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { dir: skillsRoot, mtimeKey, skills };
    return skills;
  }

  public getSkill(name: string): ReviewSkillDefinition | undefined {
    return this.listSkills().find(skill => skill.name === name);
  }

  /** Skills that should be active for every pass and for the scoring stage. */
  public getAlwaysSkills(): ReviewSkillDefinition[] {
    return this.listSkills().filter(skill => skill.always);
  }

  public matchSkills(input: ReviewSkillMatchInput): ReviewSkillDefinition[] {
    const languages = detectReviewLanguages(input.changedFiles);

    return this.listSkills().filter(skill => {
      if (skill.always) {
        return true;
      }
      if (skill.passIds.length > 0 && !skill.passIds.includes(input.passId)) {
        return false;
      }
      if (
        skill.languages.length > 0 &&
        !skill.languages.some(language => languages.has(language))
      ) {
        return false;
      }
      if (skill.globs.length > 0 && !matchesAnyGlob(skill.globs, input.changedFiles)) {
        return false;
      }
      return true;
    });
  }
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    )
  );
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal frontmatter parser: top-level `key: value` scalars plus one level of
 * nested scalars under `metadata:`. Sufficient for SKILL.md files; avoids a YAML dependency.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { fields: {}, metadata: {}, body: normalized };
  }

  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let currentBlock: 'metadata' | null = null;

  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    const indented = /^\s+/.test(line);
    const keyValue = line.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyValue) {
      continue;
    }
    const [, key, value] = keyValue;

    if (!indented) {
      if (key === 'metadata' && value.trim() === '') {
        currentBlock = 'metadata';
        continue;
      }
      currentBlock = null;
      fields[key] = stripQuotes(value);
      continue;
    }

    if (currentBlock === 'metadata') {
      metadata[key] = stripQuotes(value);
    }
  }

  return { fields, metadata, body: match[2] };
}

export function matchesAnyGlob(globs: string[], files: string[]): boolean {
  if (globs.length === 0) {
    return true;
  }
  return files.some(file => globs.some(glob => matchesGlob(glob, file)));
}

export function matchesGlob(glob: string, file: string): boolean {
  if (glob === '**' || glob === file) {
    return true;
  }

  const GLOBSTAR_SLASH = '\0GS\0';
  const GLOBSTAR = '\0G\0';
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .split(GLOBSTAR_SLASH)
    .join('(?:.*/)?')
    .split(GLOBSTAR)
    .join('.*');
  return new RegExp(`^${escaped}$`).test(file);
}

export function resolveDefaultReviewSkillsDir(): string {
  // Explicit overrides are authoritative, even when missing: enabled stages report the error.
  if (process.env.REVIEW_SKILLS_DIR) {
    return path.resolve(process.env.REVIEW_SKILLS_DIR);
  }
  const candidates = [
    path.resolve(process.cwd(), 'review-skills'),
    path.resolve(__dirname, '..', '..', 'review-skills'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'skills')).isDirectory()) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }

  return candidates[0] || path.resolve(process.cwd(), 'review-skills');
}

export const reviewSkillCatalog = new ReviewSkillCatalog(resolveDefaultReviewSkillsDir());
