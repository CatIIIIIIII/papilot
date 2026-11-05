import { useSyncExternalStore } from 'react';
import { AGENT_NAMES, type Snapshot, type Task } from '../shared.ts';
import { browserStorage } from './storage.ts';
import { t, tn } from './i18n.ts';

// Notifications tell the author when a task needs them while Papilot is
// in the background: an agent asks a question or for approval, a review is
// ready, or a task stops on an error. They are off until the author turns
// them on, and the browser's permission is asked for at that moment.
const key = 'papilot:notifications';
export const NOTIFICATION_EVENTS = ['input', 'approval', 'review', 'finished', 'error'] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];
export type NotificationEvents = Record<NotificationEvent, boolean>;
const defaultEvents: NotificationEvents = { input: true, approval: true, review: true, finished: true, error: true };
export const nativeNotifications = typeof window !== 'undefined' && Boolean(window.papilotDesktop?.notify);
// Electron's Linux libnotify backend does not implement the silent option.
export const nativeNotificationSound = nativeNotifications && ['darwin', 'win32'].includes(window.papilotDesktop!.platform);
export type NotificationState = { on: boolean; sound: boolean; events: NotificationEvents; permission: NotificationPermission | 'unsupported' | 'insecure' };
function read(): NotificationState {
  const on = browserStorage.getItem(key) === 'on';
  const sound = browserStorage.getItem(`${key}:sound`) !== 'off';
  // Missing event preferences preserve the existing all-events behavior.
  const events = { ...defaultEvents };
  for (const event of NOTIFICATION_EVENTS) events[event] = browserStorage.getItem(`${key}:${event}`) !== 'off';
  // Native delivery uses the OS's app permission, independent of Chromium's
  // site permission (which remains denied in the desktop shell).
  if (nativeNotifications) return { on, sound, events, permission: 'granted' };
  if (typeof window === 'undefined' || !('Notification' in window)) return { on, sound, events, permission: 'unsupported' };
  // Browsers only offer notifications on HTTPS and localhost.
  if (!window.isSecureContext) return { on, sound, events, permission: 'insecure' };
  return { on, sound, events, permission: Notification.permission };
}
let state = read();
const listeners = new Set<() => void>();
function refresh() {
  const next = read();
  if (next.on !== state.on || next.sound !== state.sound || next.permission !== state.permission || NOTIFICATION_EVENTS.some(event => next.events[event] !== state.events[event])) { state = next; listeners.forEach(listener => listener()); }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => { if (event.key === key || event.key?.startsWith(`${key}:`) || event.key === null) refresh(); });
  // The permission can change in the browser's site settings while the page is open.
  window.addEventListener('focus', refresh);
}
export const notificationState = () => state;
export const notifying = () => state.on && state.permission === 'granted' && NOTIFICATION_EVENTS.some(event => state.events[event]);
export function subscribeNotifications(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useNotifications() { return useSyncExternalStore(subscribeNotifications, notificationState); }

export async function setNotifications(on: boolean) {
  if (on && state.permission === 'default') await Notification.requestPermission();
  if (on) browserStorage.setItem(key, 'on'); else browserStorage.removeItem(key);
  refresh();
}

export function setNotificationEvent(event: NotificationEvent, on: boolean) {
  if (on) browserStorage.removeItem(`${key}:${event}`); else browserStorage.setItem(`${key}:${event}`, 'off');
  refresh();
}

export function setNotificationSound(on: boolean) {
  if (on) browserStorage.removeItem(`${key}:sound`); else browserStorage.setItem(`${key}:sound`, 'off');
  refresh();
}

export interface TaskAlert { taskId: string; event: NotificationEvent; title: string; body: string }
// What changed since the last snapshot that the author should hear about.
// Each task gives at most one alert per change of state.
export function taskAlerts(previous: Snapshot, next: Snapshot, events: NotificationEvents = defaultEvents): TaskAlert[] {
  const alerts: TaskAlert[] = [];
  for (const task of next.tasks) {
    const before = previous.tasks.find(t => t.id === task.id);
    if (!before) continue;
    const agent = AGENT_NAMES[task.agent || 'codex'] || 'Codex';
    const asked = next.requests.filter(r => r.taskId === task.id && !previous.requests.some(p => p.id === r.id) && events[r.method.endsWith('requestUserInput') ? 'input' : 'approval']);
    if (asked.length) {
      const question = asked.some(r => r.method.endsWith('requestUserInput'));
      alerts.push({ taskId: task.id, event: question ? 'input' : 'approval', title: question ? t('{agent} needs your input', { agent }) : t('{agent} is waiting for your approval', { agent }), body: task.title });
    } else if (before.status !== 'reviewing' && task.status === 'reviewing' && !before.pendingReview) {
      const pending = task.review?.counts?.pending || 0;
      alerts.push({ taskId: task.id, event: pending ? 'review' : 'finished', title: pending ? tn(pending, 'Review ready · {n} change to decide', 'Review ready · {n} changes to decide') : t('{agent} finished', { agent }), body: task.title });
    } else if (task.status !== before.status && (task.status === 'failed' || task.status === 'uncertain' || (task.status === 'interrupted' && task.error))) {
      alerts.push({ taskId: task.id, event: 'error', title: t('A task needs attention'), body: firstLine(task, task.title) });
    }
  }
  return alerts.filter(alert => events[alert.event]);
}
function firstLine(task: Task, title: string) {
  const error = task.error?.split('\n').find(line => line.trim())?.trim();
  return error ? `${title}\n${error.slice(0, 160)}` : title;
}

// One notification per task: a newer one replaces the last and alerts again.
export async function notify(alert: TaskAlert, open: (taskId: string) => void) {
  if (!notifying() || !state.events[alert.event]) return;
  try {
    if (nativeNotifications) return await window.papilotDesktop!.notify!({ taskId: alert.taskId, title: alert.title, body: alert.body, sound: !nativeNotificationSound || state.sound });
    const notification = new Notification(alert.title, { body: alert.body, tag: 'papilot:' + alert.taskId, renotify: true, icon: '/favicon.png' } as NotificationOptions);
    notification.onclick = () => { window.focus(); open(alert.taskId); notification.close(); };
  } catch { /* Some browsers only allow notifications from a service worker. */ }
}

export async function testNotification() {
  if (!state.on || state.permission !== 'granted') return false;
  try {
    const title = t('Notifications are on'), body = t('Papilot will tell you here when a task needs you.');
    if (nativeNotifications) return await window.papilotDesktop!.notify!({ taskId: null, title, body, sound: !nativeNotificationSound || state.sound });
    new Notification(title, { body, tag: 'papilot:test', icon: '/favicon.png' }); return true;
  }
  catch { return false; }
}
