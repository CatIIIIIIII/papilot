import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { ACP_PROFILES } from '../src/server/acp.ts';
import type { RuntimeStatus } from '../src/shared.ts';
import { setLanguage, t } from '../src/web/i18n.ts';
import { PermissionOptions } from '../src/web/task-permissions.tsx';

type Node = DefaultTreeAdapterMap['node'];
function elements(node: Node): DefaultTreeAdapterMap['element'][] {
  return [...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(elements) : [])];
}
const attr = (node: DefaultTreeAdapterMap['element'], name: string) => node.attrs.find(attr => attr.name === name)?.value;
const text = (node: Node): string => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
const runtime: RuntimeStatus = { connected: true, authenticated: true, account: null, error: null, models: [], permissionOptions: [
  { value: 'workspace', ...ACP_PROFILES.deepseek.permissionModes['workspace-write'] },
  ACP_PROFILES.deepseek.permissionModes['danger-full-access'],
] };

// Each option's explanation is its visible detail, accessible description and
// tooltip, in the interface language. `t` falls back to English, so the
// Chinese check also shows the strings are translated.
for (const id of ['en', 'zh-Hans'] as const) test(`DeepSeek permission explanations and accessible descriptions are present in ${id}`, () => {
  setLanguage(id);
  try {
    for (const value of ['workspace', 'full']) {
      const nodes = elements(parseFragment(renderToStaticMarkup(createElement(PermissionOptions, { runtime, value, onChange: () => {} }))));
      const detail = nodes.find(node => attr(node, 'class') === 'task-permission-detail')!;
      const source = value === 'workspace' ? 'Sandboxed; exceptions need approval' : 'Bypass sandbox and approvals';
      assert.equal(text(detail), t(source));
      if (id !== 'en') assert.notEqual(text(detail), source, 'the explanation is translated');
      for (const option of runtime.permissionOptions!) {
        const input = nodes.find(node => node.tagName === 'input' && attr(node, 'value') === option.value)!;
        assert.equal(attr(input, 'aria-description'), t(option.detail));
        const label = nodes.find(node => node.tagName === 'label' && elements(node).includes(input))!;
        assert.equal(attr(label, 'title'), t(option.detail));
        if (id !== 'en') assert.notEqual(attr(input, 'aria-description'), option.detail, 'the description is translated');
      }
    }
  } finally { setLanguage('system'); }
});
