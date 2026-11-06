export interface DesktopAlert { taskId: string | null; title: string; body: string; sound: boolean }
interface NativeNotification {
  on(event: 'show' | 'failed' | 'click' | 'close', listener: () => void): unknown;
  show(): void;
  close(): void;
}

// IPC data is untrusted, even when it comes from the app's own renderer.
function validAlert(value: unknown): value is DesktopAlert {
  if (!value || typeof value !== 'object') return false;
  const alert = value as DesktopAlert;
  return (alert.taskId === null || (typeof alert.taskId === 'string' && alert.taskId.length > 0 && alert.taskId.length <= 200))
    && typeof alert.title === 'string' && alert.title.trim().length > 0 && alert.title.length <= 256
    && typeof alert.body === 'string' && alert.body.length <= 2000 && typeof alert.sound === 'boolean';
}

export function desktopNotifications(options: {
  supported(): boolean;
  create(options: { title: string; body: string; silent: boolean }): NativeNotification;
  open(taskId: string | null): void;
}) {
  // Hold native objects until dismissal, and replace older alerts for a task.
  const active = new Map<string | null, NativeNotification>();
  return {
    async show(value: unknown): Promise<boolean> {
      if (!validAlert(value) || !options.supported()) return false;
      const alert = value;
      try {
        active.get(alert.taskId)?.close();
        // Bound memory even if the OS never reports dismissals.
        if (active.size >= 50) {
          const [key, oldest] = active.entries().next().value!;
          active.delete(key); oldest.close();
        }
        const notification = options.create({ title: alert.title, body: alert.body, silent: !alert.sound });
        active.set(alert.taskId, notification);
        return await new Promise<boolean>(resolve => {
          const finish = (sent: boolean) => { clearTimeout(timer); resolve(sent); };
          const release = () => { if (active.get(alert.taskId) === notification) active.delete(alert.taskId); };
          const timer = setTimeout(() => { release(); notification.close(); finish(false); }, 10000);
          notification.on('show', () => finish(true));
          notification.on('failed', () => { release(); finish(false); });
          notification.on('close', () => { release(); finish(false); });
          notification.on('click', () => { options.open(alert.taskId); release(); notification.close(); finish(true); });
          try { notification.show(); }
          catch { release(); finish(false); }
        });
      } catch { return false; }
    },
    close() { for (const notification of active.values()) notification.close(); active.clear(); },
  };
}
