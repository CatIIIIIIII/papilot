import { useState } from 'react';
import { type RuntimeStatus, type Task, type TaskPermissions } from '../shared.ts';
import { ChipSelect } from './chip-select.tsx';
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

export function PermissionPicker({ runtime, value, disabled, onChange }: { runtime?: RuntimeStatus; value: TaskPermissions; disabled?: boolean; onChange: (value: TaskPermissions) => void }) {
  const options = runtime?.permissionOptions || [];
  if (!options.length) return null;
  return <span className="task-permission-picker" title={t('Applies to the next message.')}><ChipSelect label={t('Task permissions')} value={value} disabled={disabled} onChange={value => onChange(value as TaskPermissions)} options={options.map(option => ({ ...option, label: permissionText(option.label), detail: `${permissionText(option.detail)} ${t('Applies to the next message.')}` }))}/></span>;
}

export function TaskPermissionPicker({ task, runtime, disabled, save, onSaving, refresh, reportError }: {
  task: Task; runtime?: RuntimeStatus; disabled: boolean; save: (permissions: TaskPermissions) => Promise<Task>;
  onSaving: (value: boolean) => void; refresh: () => void; reportError: (error: unknown) => void;
}) {
  const [saving, setSaving] = useState(false);
  const busy = ['running', 'waiting_input', 'building', 'uncertain', 'queued', 'deleting'].includes(task.status);
  if (task.mode === 'review') return null;
  return <span title={busy ? t('Pause the task before changing permissions.') : undefined}><PermissionPicker runtime={runtime} value={task.permissions || 'workspace'} disabled={disabled || busy || saving}
    onChange={async permissions => {
      setSaving(true); onSaving(true);
      try { await save(permissions); }
      catch (error) { reportError(error); }
      finally { refresh(); setSaving(false); onSaving(false); }
    }}/></span>;
}
