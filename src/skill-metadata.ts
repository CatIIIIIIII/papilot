// Keep a skill's source intact when editing one field in the visual editor.
// This is the same small, single-line front-matter format used by the loader.
function parts(content: string) {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = content.slice(bom.length);
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  return { bom, source, header, newline: source.includes('\r\n') ? '\r\n' : '\n' };
}
export function skillMetadata(content: string): Record<string, string> {
  const { header } = parts(content), fields: Record<string, string> = {};
  for (const line of header?.[1].split(/\r?\n/) || []) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (field) {
      const value = field[2].trim();
      let decoded = value.replace(/^(['"])(.*)\1$/, '$2');
      if (value.startsWith('"') && value.endsWith('"')) {
        try { decoded = JSON.parse(value); } catch { /* Preserve legacy quoted values. */ }
      }
      fields[field[1].toLowerCase()] = decoded;
    }
  }
  return fields;
}
export const skillInstructions = (content: string) => {
  const { source, header } = parts(content);
  return source.slice(header?.[0].length || 0);
};
export function setSkillMetadata(content: string, field: 'name' | 'description' | 'icon', value: string) {
  const { bom, source, header, newline } = parts(content);
  const clean = value.replace(/[\r\n]/g, ' ');
  const line = `${field}: ${field === 'icon' ? clean : JSON.stringify(clean)}`;
  if (!header) return `${bom}---${newline}${line}${newline}---${newline}${newline}${source}`;
  const rows = header[1].split(/\r?\n/);
  const matches = new RegExp(`^${field}:`, 'i');
  // Remove duplicate definitions so the visual value cannot be overridden later.
  const index = rows.findIndex(row => matches.test(row));
  const next = rows.filter(row => !matches.test(row));
  next.splice(index < 0 ? next.length : index, 0, line);
  const closingNewline = header[0].endsWith('\n') ? newline : '';
  return `${bom}---${newline}${next.join(newline)}${newline}---${closingNewline}${source.slice(header[0].length)}`;
}
export function setSkillInstructions(content: string, body: string) {
  const { bom, header, newline } = parts(content);
  return header ? `${bom}${header[0]}${header[0].endsWith('\n') ? '' : newline}${body}` : `${bom}${body}`;
}
