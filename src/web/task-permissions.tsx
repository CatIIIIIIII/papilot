import { useState } from 'react';
import { supportsFullTaskAccess, type AgentId, type Task, type TaskPermissions } from '../shared.ts';
import { ChipSelect } from './chip-select.tsx';
import { t } from './i18n.ts';

export function PermissionPicker({ agent, value, disabled, onChange }: { agent: AgentId; value: TaskPermissions; disabled?: boolean; onChange: (value: TaskPermissions) => void }) {
  if (!supportsFullTaskAccess(agent)) return null;
  return <ChipSelect label={t('Task permissions')} value={value} disabled={disabled} onChange={value => onChange(value as TaskPermissions)} options={[
    { value: 'workspace', label: t('Workspace access'), detail: t('Edit the task workspace with network access; other actions may need approval.') },
    { value: 'full', label: t('Full access'), detail: t('Access files, use the network, and run commands without individual approval.') },
  ]}/>;
}

export function TaskPermissionPicker({ task, disabled, save, onSaving, refresh, reportError }: {
  task: Task; disabled: boolean; save: (permissions: TaskPermissions) => Promise<Task>;
  onSaving: (value: boolean) => void; refresh: () => void; reportError: (error: unknown) => void;
}) {
  const [saving, setSaving] = useState(false);
  const busy = ['running', 'waiting_input', 'building', 'uncertain', 'queued', 'deleting'].includes(task.status);
  if (task.mode === 'review') return null;
  return <span title={busy ? t('Pause the task before changing permissions.') : undefined}><PermissionPicker agent={task.agent || 'codex'} value={task.permissions || 'workspace'} disabled={disabled || busy || saving}
    onChange={async permissions => {
      setSaving(true); onSaving(true);
      try { await save(permissions); }
      catch (error) { reportError(error); }
      finally { refresh(); setSaving(false); onSaving(false); }
    }}/></span>;
}
