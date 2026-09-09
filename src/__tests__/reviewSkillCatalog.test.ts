import fs from 'fs';
import os from 'os';
import path from 'path';
import { ReviewSkillCatalog, matchesGlob, parseFrontmatter } from '../services/reviewSkillCatalog';

function writeSkill(root: string, name: string, frontmatter: string, body = 'Body text'): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe('ReviewSkillCatalog', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skills-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses frontmatter scalars and nested metadata', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'name: demo',
        'description: "Quoted description: with colon"',
        'metadata:',
        '  review-passes: "bug-scan, history-context"',
        '  review-always: true',
        '---',
        '',
        '# Heading',
        'Body',
      ].join('\n')
    );

    expect(parsed.fields.name).toBe('demo');
    expect(parsed.fields.description).toBe('Quoted description: with colon');
    expect(parsed.metadata['review-passes']).toBe('bug-scan, history-context');
    expect(parsed.metadata['review-always']).toBe('true');
    expect(parsed.body.trim()).toBe('# Heading\nBody');
  });

  it('returns raw body when no frontmatter is present', () => {
    const parsed = parseFrontmatter('just text');
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe('just text');
  });

  it('reports availability based on the skills directory', () => {
    expect(new ReviewSkillCatalog(path.join(root, 'missing')).isAvailable()).toBe(false);
    writeSkill(root, 'core', 'name: core\ndescription: d\nmetadata:\n  review-always: "true"');
    expect(new ReviewSkillCatalog(root).isAvailable()).toBe(true);
  });

  it('matches skills by pass id, language, and glob, and always includes always-on skills', () => {
    writeSkill(root, 'core', 'name: core\ndescription: d\nmetadata:\n  review-always: "true"');
    writeSkill(
      root,
      'ts',
      'name: ts\ndescription: d\nmetadata:\n  review-passes: "bug-scan"\n  review-languages: "typescript"'
    );
    writeSkill(
      root,
      'tests',
      'name: tests\ndescription: d\nmetadata:\n  review-globs: "**/*.test.*"'
    );
    writeSkill(root, 'go', 'name: go\ndescription: d\nmetadata:\n  review-languages: "go"');

    const catalog = new ReviewSkillCatalog(root);

    expect(catalog.getAlwaysSkills().map(skill => skill.name)).toEqual(['core']);

    const bugScan = catalog
      .matchSkills({ passId: 'bug-scan', changedFiles: ['src/app.ts'] })
      .map(skill => skill.name);
    expect(bugScan).toEqual(['core', 'ts']);

    const history = catalog
      .matchSkills({ passId: 'history-context', changedFiles: ['src/app.ts'] })
      .map(skill => skill.name);
    expect(history).toEqual(['core']);

    const withTests = catalog
      .matchSkills({
        passId: 'comments-and-contracts',
        changedFiles: ['src/app.test.ts', 'main.go'],
      })
      .map(skill => skill.name);
    expect(withTests).toEqual(['core', 'go', 'tests']);
  });

  it('falls back to the directory name when SKILL.md has no name and exposes the body', () => {
    writeSkill(root, 'unnamed', 'description: d', 'Do the thing.');
    const catalog = new ReviewSkillCatalog(root);
    const skill = catalog.getSkill('unnamed');
    expect(skill?.name).toBe('unnamed');
    expect(skill?.body).toBe('Do the thing.');
    expect(skill?.always).toBe(false);
  });

  it('reloads when a SKILL.md changes on disk', () => {
    writeSkill(root, 'core', 'name: core\ndescription: first');
    const catalog = new ReviewSkillCatalog(root);
    expect(catalog.getSkill('core')?.description).toBe('first');

    const filePath = path.join(root, 'skills', 'core', 'SKILL.md');
    fs.writeFileSync(filePath, '---\nname: core\ndescription: second\n---\nBody\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);

    expect(catalog.getSkill('core')?.description).toBe('second');
  });
});

describe('matchesGlob', () => {
  it.each([
    ['**', 'a/b/c.ts', true],
    ['**/*.test.*', 'src/app.test.ts', true],
    ['**/*.test.*', 'app.test.ts', true],
    ['**/*.test.*', 'src/app.ts', false],
    ['src/**', 'src/deep/file.ts', true],
    ['src/**', 'lib/file.ts', false],
    ['**/tests/**', 'pkg/tests/unit/x.py', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/README.md', false],
  ])('%s vs %s -> %s', (glob, file, expected) => {
    expect(matchesGlob(glob, file)).toBe(expected);
  });
});

describe('bundled review skills', () => {
  it('loads the repository skill plugin with an always-on core skill', () => {
    const catalog = new ReviewSkillCatalog(path.resolve(__dirname, '..', '..', 'review-skills'));
    expect(catalog.isAvailable()).toBe(true);

    const names = catalog.listSkills().map(skill => skill.name);
    expect(names).toContain('mr-review-core');
    expect(catalog.getAlwaysSkills().map(skill => skill.name)).toEqual(['mr-review-core']);

    for (const skill of catalog.listSkills()) {
      expect(path.basename(path.dirname(skill.filePath))).toBe(skill.name);
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.body.length).toBeGreaterThan(200);
    }
  });

  it('derives the slash command from the plugin manifest', () => {
    const catalog = new ReviewSkillCatalog(path.resolve(__dirname, '..', '..', 'review-skills'));
    expect(catalog.getPluginName()).toBe('gitlab-review');
    expect(catalog.getInvocationCommand('mr-review-core')).toBe('/gitlab-review:mr-review-core');
  });
});

describe('plugin naming', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the plugin name from .claude-plugin/plugin.json', () => {
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-review', version: '1.0.0' })
    );
    const catalog = new ReviewSkillCatalog(root);
    expect(catalog.getPluginName()).toBe('demo-review');
    expect(catalog.getInvocationCommand('core')).toBe('/demo-review:core');
  });

  it('falls back to the directory name when the manifest is missing or malformed', () => {
    expect(new ReviewSkillCatalog(root).getPluginName()).toBe(path.basename(root));

    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{not json');
    expect(new ReviewSkillCatalog(root).getPluginName()).toBe(path.basename(root));
  });
});
