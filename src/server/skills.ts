import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './paths.ts';
import type { Skill } from '../shared.ts';
import { isSkillIcon } from '../skill-icons.ts';
import { skillMetadata, skillInstructions } from '../skill-metadata.ts';

// Skills are Markdown instructions an author runs with "/" in the composer.
// Papilot ships some in skills/; ~/.papilot/skills/ adds the author's
// own for every paper, and a paper's .papilot/skills/ its own. A later source
// replaces an earlier skill with the same name. Each skill is <name>.md, or a
// folder with a SKILL.md (the Agent Skills layout) whose other files the
// agent may read. Front matter gives its name, description, composer hint
// and order.
export interface SkillFile extends Skill { body: string; folder?: string; order: number }
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
// Global authoring tools belong to the user, independently of the database or
// a temporary demo's PAPILOT_DATA directory.
export const skillRoots = { builtin: path.join(ROOT, 'skills'), user: path.join(os.homedir(), '.papilot', 'skills') };

// Both the composer and the library address the same files, including legacy
// <name>.md files. New skills use the portable <name>/SKILL.md layout.
export function skillFiles(dir: string): { id: string; file: string; folder?: string }[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const id = entry.name.replace(/\.md$/i, '').toLowerCase();
    if (!SKILL_NAME.test(id)) return [];
    const folder = path.join(dir, entry.name);
    return entry.isDirectory() ? [{ id, file: path.join(folder, 'SKILL.md'), folder }]
      : entry.isFile() && /\.md$/i.test(entry.name) ? [{ id, file: folder }] : [];
  });
}

export function parseSkill(text: string, id: string, source: Skill['source'], folder?: string): SkillFile | null {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fields = skillMetadata(text), body = skillInstructions(text).trim();
  if (!body) return null;
  return { id, name: fields.name || id, description: fields.description || '', hint: fields.hint || '', ...(isSkillIcon(fields.icon) ? { icon: fields.icon } : {}), source, body, ...(fields.output === 'annotations' ? { output: 'annotations' as const } : {}), ...(folder ? { folder } : {}), order: fields.order && Number.isFinite(Number(fields.order)) ? Number(fields.order) : 1000 };
}

function read(dir: string, source: Skill['source']): SkillFile[] {
  const found: SkillFile[] = [];
  for (const { id, file, folder } of skillFiles(dir)) {
    try {
      const skill = parseSkill(fs.readFileSync(file, 'utf8'), id, source, folder);
      if (skill) found.push(skill);
    } catch { /* A folder without a readable SKILL.md is not a skill. */ }
  }
  return found;
}

export function loadSkills(paper?: string, roots = skillRoots): SkillFile[] {
  const skills = new Map<string, SkillFile>();
  const sources: [string, Skill['source']][] = [[roots.builtin, 'builtin'], [roots.user, 'user'], ...(paper ? [[path.join(paper, '.papilot', 'skills'), 'paper'] as [string, Skill['source']]] : [])];
  for (const [dir, source] of sources) for (const skill of read(dir, source)) skills.set(skill.id, skill);
  return [...skills.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function findSkill(paper: string, id: string) {
  const skill = loadSkills(paper).find(item => item.id === id);
  if (!skill) throw new Error(`The skill "${id}" is not available for this paper.`);
  return skill;
}

export const listedSkill = ({ id, name, description, hint, source, icon, output }: SkillFile): Skill => ({ id, name, description, hint, source, ...(icon ? { icon } : {}), ...(output ? { output } : {}) });
