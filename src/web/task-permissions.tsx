import { useId, useState } from 'react';
import { type RuntimeStatus, type Task, type TaskPermissions } from '../shared.ts';
import { t } from './i18n.ts';

// Keep runtime-provided text discoverable by the locale catalog extractor.
function permissionText(text: string) {
  const messages: Record<string, string> = {
    "Workspace access": t("Workspace access"),
    "Full access": t("Full access"),
    "Sandboxed edits": t("Sandboxed edits"),
    "Bypass permissions": t("Bypass permissions"),
    "Write within the workspace and configured writable roots, with network access. Ask before exceeding sandbox restrictions.": t("Write within the workspace and configured writable roots, with network access. Ask before exceeding sandbox restrictions."),
    "Disable the sandbox and run tools without approval, subject to managed settings.": t("Disable the sandbox and run tools without approval, subject to managed settings."),
    "Automatically approve edits and sandboxed commands. Other permission requests are denied in print mode.": t("Automatically approve edits and sandboxed commands. Other permission requests are denied in print mode."),
    "Automatically approve edits and sandboxed commands. Ask before other actions.": t("Automatically approve edits and sandboxed commands. Ask before other actions."),
    "Disable the command sandbox and bypass tool approvals, subject to managed settings.": t("Disable the command sandbox and bypass tool approvals, subject to managed settings."),
  };
  return messages[text] || text;
}

export function PermissionOptions({ runtime, value, disabled, hint, onChange }: { runtime?: RuntimeStatus; value: TaskPermissions; disabled?: boolean; hint?: string; onChange: (value: TaskPermissions) => void }) {
  const id = useId();
  const options = runtime?.permissionOptions || [];
  if (!options.length) return null;
  return <div className="task-permissions"><fieldset disabled={disabled} aria-describedby={`${id}-hint`}>
    <legend>{t('Task permissions')}</legend>
    <p id={`${id}-hint`} className="task-permissions-hint">{hint || t('Applies to the next message.')}</p>
    {options.map(option => <label key={option.value} className="task-permission-option">
      <input type="radio" name={id} value={option.value} checked={value === option.value} aria-labelledby={`${id}-${option.value}-label`} aria-describedby={`${id}-${option.value}-detail`} onChange={() => onChange(option.value)}/>
      <span><strong id={`${id}-${option.value}-label`}>{permissionText(option.label)}</strong><small id={`${id}-${option.value}-detail`}>{permissionText(option.detail)}</small></span>
    </label>)}
  </fieldset></div>;
}

export function TaskPermissionOptions({ task, runtime, disabled, save, onSaving, refresh, reportError }: {
  task: Task; runtime?: RuntimeStatus; disabled: boolean; save: (permissions: TaskPermissions) => Promise<Task>;
  onSaving: (value: boolean) => void; refresh: () => void; reportError: (error: unknown) => void;
}) {
  const [saving, setSaving] = useState(false);
  const busy = ['running', 'waiting_input', 'building', 'uncertain', 'queued', 'deleting'].includes(task.status);
  if (task.mode === 'review') return null;
  return <PermissionOptions runtime={runtime} value={task.permissions || 'workspace'} disabled={disabled || busy || saving} hint={busy ? t('Pause the task before changing permissions.') : undefined}
    onChange={async permissions => {
      setSaving(true); onSaving(true);
      try { await save(permissions); }
      catch (error) { reportError(error); }
      finally { refresh(); setSaving(false); onSaving(false); }
    }}/>;
}
