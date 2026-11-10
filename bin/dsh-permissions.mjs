// Papilot ACP extension for DeepSeek Harness. It exposes the Harness's native
// per-session permission presets without changing the user's regular dsh CLI.
import { registerHooks } from 'node:module';

const optionsBefore = `\tconfigOptions(signal) {
\t\tthis.assertActive();
\t\treturn this.modelControl.options(signal);
\t}`;
const optionsAfter = `\tasync configOptions(signal) {
\t\tthis.assertActive();
\t\tconst options = await this.modelControl.options(signal);
\t\tconst permissions = this.ctx.permissionPresets;
\t\tif (!permissions) throw new Error('Papilot requires native dsh permission presets.');
\t\treturn [...options, { id: 'permission_mode', name: 'Permissions', category: 'mode', type: 'select',
\t\t\tcurrentValue: permissions.current(this.agent.session),
\t\t\toptions: permissions.names.filter(name => ['read-only', 'workspace-write', 'danger-full-access'].includes(name)).map(name => permissions.optionOf(name)) }];
\t}`;
const setBefore = `\tsetConfig(configId, value, signal) {
\t\tthis.assertActive();
\t\treturn this.modelControl.set(configId, value, signal);
\t}`;
const setAfter = `\tasync setConfig(configId, value, signal) {
\t\tthis.assertActive();
\t\tif (configId === 'permission_mode') {
\t\t\tif (this.inflight !== undefined) throw invalidParams$1('Pause the current turn before changing permissions.');
\t\t\tif (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) throw invalidParams$1('Unsupported permission mode.');
\t\t\tthis.ctx.permissionPresets.apply(this.agent.session, value, policy => this.ctx.approval.setPolicy(this.agent, policy));
\t\t\tawait this.ctx.sessions.flush(this.agent.session);
\t\t} else await this.modelControl.set(configId, value, signal);
\t\treturn this.configOptions(signal);
\t}`;

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/@deepseek-ai/dsh-acp/lib/index.js')) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    // Refuse unknown source layouts rather than show a control that does nothing.
    if (source.split(optionsBefore).length !== 2 || source.split(setBefore).length !== 2)
      throw new Error('This dsh version needs an updated Papilot permission adapter.');
    return {
      ...result,
      source: source.replace(optionsBefore, optionsAfter).replace(setBefore, setAfter)
        .replace('const inject = [', 'const inject = [\n\t"permissionPresets",\n\t"approval",'),
    };
  },
});
