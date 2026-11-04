import { parse, serialize, parseFragment } from 'parse5';

function visit(node, fn) {
  fn(node);
  for (const child of [...(node.childNodes || [])]) visit(child, fn);
}
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const attributeNames = ['alt', 'aria-label', 'title', 'content'];

// Use the English page as the translation source.
export function siteMessages(html) {
  const messages = new Map();
  const add = (source, context) => { if (source?.trim()) messages.set(source, context); };
  visit(parse(html), node => {
    if (attr(node, 'lang') === 'en' && node.tagName !== 'html' && !attr(node, 'role')?.startsWith('menuitem')) add(serialize(node), 'Website copy; preserve all inline HTML tags and attributes exactly.');
    for (const name of attributeNames) if (attr(node, `data-zh-${name}`) !== undefined) add(attr(node, name), `Website ${name} attribute; plain text.`);
    if (node.tagName === 'title') add(serialize(node), 'Website page title.');
  });
  return [...messages].map(([source, context]) => ({ source, occurrences: [{ file: 'site/index.html', line: 1, context }] }));
}

export function translatedSite(html, translations, locale = 'zh-Hant') {
  const document = parse(html);
  const translate = source => {
    if (locale === 'en') return source;
    if (translations[source] === undefined) throw new Error(`Missing website translation: ${source}`);
    return translations[source];
  };
  visit(document, node => {
    if (attr(node, 'lang') === 'zh-CN') {
      const siblings = node.parentNode.childNodes;
      siblings.splice(siblings.indexOf(node), 1);
      return;
    }
    if (attr(node, 'lang') === 'en') {
      node.attrs.find(item => item.name === 'lang').value = locale;
      if (node.tagName !== 'html') {
        node.childNodes = parseFragment(translate(serialize(node))).childNodes;
        for (const child of node.childNodes) child.parentNode = node;
      }
    }
    for (const name of attributeNames) if (attr(node, `data-zh-${name}`) !== undefined) {
      node.attrs.find(item => item.name === name).value = translate(attr(node, name));
    }
    if (node.tagName === 'title') node.childNodes = parseFragment(translate(serialize(node))).childNodes;
    if (node.attrs) node.attrs = node.attrs.filter(item => !item.name.startsWith('data-zh-'));
  });
  return serialize(document);
}

export function htmlStructure(text) {
  const signatures = [];
  visit(parseFragment(text), node => { if (node.tagName) signatures.push([node.tagName, node.attrs]); });
  return JSON.stringify(signatures);
}
