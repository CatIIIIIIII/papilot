import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import type { Node, Expression } from '@babel/types';
import { GROUP_NAMES } from '../../src/note-groups.ts';
import { SKILL_ICONS } from '../../src/skill-icons.ts';
import { parseSkill } from '../../src/server/skills.ts';

export type Occurrence = { file: string; line: number; context: string };
export type Message = { source: string; occurrences: Occurrence[] };
export type DynamicMessage = Occurrence & { expression: string };

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments')) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, visit);
    }
  }
}

function literals(node: Node | null | undefined): string[] | null {
  if (node?.type === 'StringLiteral') return [node.value];
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return [node.quasis[0].value.cooked ?? node.quasis[0].value.raw];
  if (node?.type === 'ConditionalExpression') {
    const yes = literals(node.consequent), no = literals(node.alternate);
    return yes && no ? [...yes, ...no] : null;
  }
  return null;
}

// Parse syntax, never execute application source to discover its messages.
export function extractSource(source: string, file: string) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const names = new Map<string, 't' | 'tn'>(), namespaces = new Set<string>();
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !/(?:^|\/)i18n(?:\.ts)?$/.test(node.source.value)) continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name);
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
      if (imported === 't' || imported === 'tn') names.set(specifier.local.name, imported);
    }
  }
  const messages: Message[] = [], dynamic: DynamicMessage[] = [];
  const comments = ast.comments?.filter(comment => /i18n:/.test(comment.value)) || [];
  walk(ast, node => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const kind = callee.type === 'Identifier' ? names.get(callee.name)
      : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier'
        ? callee.property.name : null;
    if (kind !== 't' && kind !== 'tn') return;
    const line = node.loc!.start.line;
    const hint = comments.find(comment => comment.loc!.end.line >= line - 1 && comment.loc!.end.line <= line)?.value.trim();
    const context = [path.basename(file, path.extname(file)), hint].filter(Boolean).join(': ');
    const occurrence = { file, line, context };
    for (const index of kind === 't' ? [0] : [1, 2]) {
      const argument = node.arguments[index];
      const texts = literals(argument);
      if (texts) for (const text of texts) messages.push({ source: text, occurrences: [occurrence] });
      else dynamic.push({ ...occurrence, expression: argument ? source.slice(argument.start!, argument.end!) : '(missing argument)' });
    }
  });
  return { messages, dynamic };
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/^(?:i18n|zh-CN)\.ts$/.test(entry.name) ? [file] : [];
  });
}

export function collectCatalog(root: string) {
  const all = new Map<string, Message>(), dynamic: DynamicMessage[] = [];
  const add = (source: string, occurrence: Occurrence) => {
    const entry = all.get(source) || { source, occurrences: [] };
    if (!entry.occurrences.some(item => JSON.stringify(item) === JSON.stringify(occurrence))) entry.occurrences.push(occurrence);
    all.set(source, entry);
  };
  for (const file of sourceFiles(path.join(root, 'src/web'))) {
    const extracted = extractSource(fs.readFileSync(file, 'utf8'), path.relative(root, file).split(path.sep).join('/'));
    for (const message of extracted.messages) for (const occurrence of message.occurrences) add(message.source, occurrence);
    dynamic.push(...extracted.dynamic);
  }
  for (const name of Object.values(GROUP_NAMES)) add(name, { file: 'src/note-groups.ts', line: 1, context: 'Built-in PDF annotation group name' });
  for (const icon of SKILL_ICONS) add(icon.label, { file: 'src/skill-icons.ts', line: 1, context: 'Skill icon label' });
  for (const file of fs.readdirSync(path.join(root, 'skills')).filter(file => file.endsWith('.md')).sort()) {
    const skill = parseSkill(fs.readFileSync(path.join(root, 'skills', file), 'utf8'), file, 'builtin');
    if (skill) for (const field of ['name', 'description'] as const) add(skill[field], { file: `skills/${file}`, line: 1, context: `Built-in skill ${field}; ${skill.description}` });
  }
  return { messages: [...all.values()].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0), dynamic };
}

// Read the existing curated dictionary without importing browser code.
export function readLegacyChinese(root: string, file = 'src/web/zh-CN.ts'): Record<string, string> {
  const ast = parse(fs.readFileSync(path.join(root, file), 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
  const result: Record<string, string> = Object.create(null);
  walk(ast, node => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || node.id.name !== 'zhCN' || node.init?.type !== 'ObjectExpression') return;
    for (const property of node.init.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) throw new Error('The curated dictionary must contain literal entries.');
      const key = property.key.type === 'Identifier' ? [property.key.name] : literals(property.key), value = literals(property.value as Expression);
      if (!key || !value) throw new Error('The curated dictionary must contain literal strings.');
      if (Object.hasOwn(result, key[0])) throw new Error(`Duplicate translation: ${key[0]}`);
      result[key[0]] = value[0];
    }
  });
  return result;
}

export function collectErrorCatalog(root: string) {
  const all = new Map<string, Message>();
  for (const file of sourceFiles(path.join(root, 'src/server'))) {
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
    walk(ast, node => {
      let value: Node | undefined;
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && /Error$/.test(node.callee.name)) value = node.arguments[0];
      if (node.type === 'ObjectProperty' && ((node.key.type === 'Identifier' && node.key.name === 'error') || (node.key.type === 'StringLiteral' && node.key.value === 'error'))) value = node.value;
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'deny') value = node.arguments[2];
      for (const source of literals(value) || []) {
        const entry = all.get(source) || { source, occurrences: [] };
        entry.occurrences.push({ file: path.relative(root, file), line: node.loc!.start.line, context: 'Product error or validation message shown to the author.' });
        all.set(source, entry);
      }
    });
  }
  return { messages: [...all.values()], dynamic: [] };
}
