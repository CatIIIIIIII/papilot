import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Skill } from '../shared.ts';
import type { LibrarySkill, SkillCatalog, SkillDocument } from '../skill-library.ts';
import { listedSkill, loadSkills, parseSkill, skillFiles, skillRoots, SKILL_NAME } from './skills.ts';

const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
const revision = (content: string) => createHash('sha256').update(content).digest('hex');

export class SkillLibrary {
  constructor(readonly roots = skillRoots) {}

  private root(source: unknown, paper?: string): string {
    if (source === 'builtin' || source === 'user') return this.roots[source];
    if (source === 'paper' && paper) return path.join(paper, '.papilot', 'skills');
    return fail('Choose a valid skill location.');
  }

  private id(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !SKILL_NAME.test(id)) fail('Use 1–48 lowercase letters, numbers or hyphens for the skill ID.');
  }

  // A paper can contain links checked into Git. Never follow those links when
  // editing, nor replace a linked SKILL.md or a hard link to another file.
  private safe(file: string, root: string, paper?: string) {
    const boundary = path.resolve(paper || root), target = path.resolve(file);
    if (!target.startsWith(boundary + path.sep)) fail('The skill must stay inside its skills folder.');
    let cursor = boundary;
    for (const part of ['', ...path.relative(boundary, target).split(path.sep)]) {
      if (part) cursor = path.join(cursor, part);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) fail('Linked skill files cannot be edited here.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private locate(source: unknown, id: unknown, paper?: string) {
    this.id(id);
    const root = this.root(source, paper);
    const matches = skillFiles(root).filter(file => file.id === id && fs.existsSync(file.file));
    if (matches.length > 1) fail('Several files use this skill ID. Give them distinct names before editing.');
    const found = matches[0];
    const file = found?.file || path.join(root, id, 'SKILL.md');
    this.safe(file, root, source === 'paper' ? paper : undefined);
    return { root, file, found };
  }

  list(paper?: string): SkillCatalog {
    const effective = new Map(loadSkills(paper, this.roots).map(skill => [skill.id, skill.source]));
    const skills: LibrarySkill[] = [];
    const sources: Skill['source'][] = ['user', ...(paper ? ['paper' as const] : []), 'builtin'];
    for (const source of sources) {
      const root = this.root(source, paper);
      const unique = new Map<string, LibrarySkill>();
      for (const { id, file } of skillFiles(root)) {
        try {
          this.safe(file, root, source === 'paper' ? paper : undefined);
          const skill = parseSkill(fs.readFileSync(file, 'utf8'), id, source);
          if (skill) unique.set(id, { ...listedSkill(skill), location: file, active: effective.get(id) === source });
        } catch { /* A broken or linked file is not editable from the library. */ }
      }
      skills.push(...unique.values());
    }
    return { skills, locations: { user: this.roots.user, ...(paper ? { paper: this.root('paper', paper) } : {}) } };
  }

  read(source: unknown, id: unknown, paper?: string): SkillDocument {
    const { file, found } = this.locate(source, id, paper);
    if (!found) return fail('This skill no longer exists. Refresh the list.', 404);
    const content = fs.readFileSync(file, 'utf8');
    const skill = parseSkill(content, id as string, source as Skill['source']);
    if (!skill) return fail('The skill must contain instructions.');
    return { ...listedSkill(skill), location: file, active: loadSkills(paper, this.roots).find(item => item.id === id)?.source === source, content, revision: revision(content) };
  }

  save(source: unknown, id: unknown, content: unknown, expected: unknown, paper?: string): SkillDocument {
    if (source === 'builtin') fail('Built-in skills are read-only. Make a custom copy first.', 403);
    if (typeof content !== 'string' || !content.trim() || content.includes('\0')) fail('The skill must contain instructions.');
    if (!parseSkill(content as string, String(id), source as Skill['source'])) fail('The skill must contain instructions.');
    const { file, found } = this.locate(source, id, paper);
    if (found) {
      if (expected === undefined) fail('A skill with this ID already exists in this location.', 409);
      if (typeof expected !== 'string' || revision(fs.readFileSync(file, 'utf8')) !== expected) fail('This skill changed on disk. Reload it before saving.', 409);
    } else if (expected !== undefined) fail('This skill was removed on disk. Reload the list before saving.', 409);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!found) {
      // Exclusive creation also prevents a retry from silently overwriting a
      // file created by another browser since the catalog was loaded.
      try { fs.writeFileSync(file, content as string, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('A skill with this ID already exists in this location.', 409); throw error; }
    } else {
      const temporary = path.join(path.dirname(file), `.skill-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, content as string, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    return this.read(source, id, paper);
  }

  remove(source: unknown, id: unknown, expected: unknown, paper?: string) {
    if (source === 'builtin') fail('Built-in skills are read-only.', 403);
    const { file, found } = this.locate(source, id, paper);
    if (!found) return fail('This skill no longer exists. Refresh the list.', 404);
    if (typeof expected !== 'string' || revision(fs.readFileSync(file, 'utf8')) !== expected) fail('This skill changed on disk. Reload it before deleting.', 409);
    fs.unlinkSync(file);
    // Keep supporting scripts and references. Only remove an empty skill folder.
    if (found.folder && fs.readdirSync(found.folder).length === 0) fs.rmdirSync(found.folder);
    return { ok: true };
  }
}
