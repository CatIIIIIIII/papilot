import { parse, serialize, serializeOuter, parseFragment } from 'parse5';

function visit(node, fn) {
  fn(node);
  for (const child of [...(node.childNodes || [])]) visit(child, fn);
}
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const attributeNames = ['alt', 'aria-label', 'title', 'content'];

// Use the built English page, including demo UI, as the translation source.
export function siteMessages(html) {
  const messages = new Map();
  const add = (source, context) => { if (source?.trim()) messages.set(source, context); };
  visit(parse(html), node => {
    if (attr(node, 'lang') === 'en' && node.tagName !== 'html' && !attr(node, 'role')?.startsWith('menuitem')) add(serialize(node), 'Website copy; preserve all inline HTML tags and attributes exactly.');
    for (const name of attributeNames) if (attr(node, `data-zh-${name}`) !== undefined) add(attr(node, name), `Website ${name} attribute; plain text.`);
    if (node.tagName === 'title') add(serialize(node), 'Website page title.');
  });
  return [...messages].map(([source, context]) => ({ source, occurrences: [{ file: 'site/index.html + site/demo-templates.mjs', line: 1, context }] }));
}

export function translatedSite(html, translations) {
  const document = parse(html);
  visit(document, node => {
    if (attr(node, 'lang') === 'en' && node.tagName !== 'html' && !attr(node, 'role')?.startsWith('menuitem')) {
      const source = serialize(node), translated = translations[source];
      if (translated === undefined) throw new Error(`Missing website translation: ${source}`);
      const clone = parseFragment(serializeOuter(node)).childNodes[0];
      clone.attrs.find(item => item.name === 'lang').value = 'zh-Hant';
      clone.childNodes = parseFragment(translated).childNodes;
      for (const child of clone.childNodes) child.parentNode = clone;
      clone.parentNode = node.parentNode;
      const siblings = node.parentNode.childNodes;
      siblings.splice(siblings.indexOf(node) + 1, 0, clone);
    }
    for (const name of attributeNames) if (attr(node, `data-zh-${name}`) !== undefined) {
      const source = attr(node, name), translated = translations[source];
      if (translated === undefined) throw new Error(`Missing website attribute translation: ${source}`);
      node.attrs.push({ name: `data-hant-${name}`, value: translated });
    }
    if (node.tagName === 'title') {
      const translated = translations[serialize(node)];
      if (translated === undefined) throw new Error('Missing website title translation');
      node.attrs.push({ name: 'data-hant-title', value: translated });
    }
  });
  return serialize(document);
}

export function htmlStructure(text) {
  const signatures = [];
  visit(parseFragment(text), node => { if (node.tagName) signatures.push([node.tagName, node.attrs]); });
  return JSON.stringify(signatures);
}
