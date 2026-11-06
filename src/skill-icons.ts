// Shared by the file parser and every surface that displays a skill.
export const SKILL_ICONS = [
  { id: 'spark', label: 'Sparkles' }, { id: 'pen', label: 'Pen' },
  { id: 'spellcheck', label: 'Spelling' }, { id: 'compress', label: 'Shorten' },
  { id: 'sigma', label: 'Math' }, { id: 'checklist', label: 'Checklist' },
  { id: 'notes', label: 'Comments' }, { id: 'book', label: 'Book' },
  { id: 'search', label: 'Search' }, { id: 'code', label: 'Code' },
  { id: 'tool', label: 'Tools' }, { id: 'chart', label: 'Chart' },
  { id: 'globe', label: 'Globe' }, { id: 'lightbulb', label: 'Idea' },
  { id: 'link', label: 'Link' }, { id: 'branch', label: 'Branch' },
  { id: 'paper', label: 'Document' }, { id: 'bookmark', label: 'Bookmark' },
  { id: 'quote', label: 'Quotation' }, { id: 'library', label: 'Library' },
  { id: 'languages', label: 'Translation' }, { id: 'heading', label: 'Heading' },
  { id: 'list', label: 'List' }, { id: 'highlighter', label: 'Highlighter' },
  { id: 'table', label: 'Table' }, { id: 'image', label: 'Image' },
  { id: 'presentation', label: 'Presentation' }, { id: 'diagram', label: 'Diagram' },
  { id: 'database', label: 'Database' }, { id: 'calculator', label: 'Calculator' },
  { id: 'ruler', label: 'Ruler' }, { id: 'target', label: 'Target' },
  { id: 'flask', label: 'Experiment' }, { id: 'atom', label: 'Atom' },
  { id: 'dna', label: 'DNA' }, { id: 'microscope', label: 'Microscope' },
  { id: 'brain', label: 'Brain' }, { id: 'network', label: 'Network' },
  { id: 'shield', label: 'Shield' }, { id: 'scale', label: 'Balance' },
  { id: 'people', label: 'People' }, { id: 'graduation', label: 'Graduation' },
  { id: 'calendar', label: 'Calendar' }, { id: 'clock', label: 'Clock' },
  { id: 'folder', label: 'Folder' }, { id: 'tag', label: 'Tag' },
  { id: 'layers', label: 'Layers' }, { id: 'workflow', label: 'Workflow' },
] as const;
export type SkillIcon = typeof SKILL_ICONS[number]['id'];
export const isSkillIcon = (value: unknown): value is SkillIcon => SKILL_ICONS.some(icon => icon.id === value);
const defaults: Record<string, SkillIcon> = {
  polish: 'spark', proofread: 'spellcheck', shorten: 'compress', 'check-math': 'sigma',
  consistency: 'checklist', 'latex-warnings': 'tool', 'reviewer-response': 'notes', 'ai-review': 'notes',
};
export const resolveSkillIcon = (skill: { id: string; icon?: string }): SkillIcon => isSkillIcon(skill.icon) ? skill.icon : Object.hasOwn(defaults, skill.id) ? defaults[skill.id] : 'spark';
