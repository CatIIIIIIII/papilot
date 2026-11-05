import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { desktopNotifications, type DesktopAlert } from '../desktop/notifications.ts';

const alert: DesktopAlert = { taskId: 'task-1', title: 'Review ready', body: 'Revise the abstract', sound: true };
class FakeNotification extends EventEmitter {
  closed = 0;
  outcome: 'show' | 'failed' | 'throw' | 'pending' = 'show';
  show() { if (this.outcome === 'throw') throw new Error('Unavailable'); if (this.outcome !== 'pending') this.emit(this.outcome); }
  close() { this.closed++; this.emit('close'); }
}
function fixture() {
  const created: { options: { title: string; body: string; silent: boolean }; notification: FakeNotification }[] = [];
  const opened: (string | null)[] = [];
  let supported = true;
  let outcome: FakeNotification['outcome'] = 'show';
  const service = desktopNotifications({ supported: () => supported, open: id => { opened.push(id); }, create: options => {
    const notification = new FakeNotification(); notification.outcome = outcome;
    created.push({ options, notification }); return notification;
  } });
  return { service, created, opened, unsupported: () => { supported = false; }, outcome: (value: typeof outcome) => { outcome = value; } };
}

test('native notifications carry sound preferences and activate their task', async () => {
  const { service, created, opened } = fixture();
  assert.equal(await service.show(alert), true);
  assert.deepEqual(created[0].options, { title: alert.title, body: alert.body, silent: false });
  created[0].notification.emit('click');
  assert.deepEqual(opened, ['task-1']);
  assert.equal(created[0].notification.closed, 1);
  assert.equal(await service.show({ ...alert, sound: false, taskId: null }), true);
  assert.equal(created[1].options.silent, true);
  created[1].notification.emit('click');
  assert.deepEqual(opened, ['task-1', null]);
  service.close();
});

test('replacing an alert survives a delayed close from the old notification', async () => {
  const { service, created } = fixture();
  await service.show(alert);
  await service.show(alert);
  assert.equal(created[0].notification.closed, 1);
  created[0].notification.emit('close');
  await service.show(alert);
  assert.equal(created[1].notification.closed, 1);
  service.close();
  assert.equal(created[2].notification.closed, 1);
});

test('unsupported systems, invalid IPC and OS failures report failure', async () => {
  const f = fixture();
  for (const invalid of [null, {}, { ...alert, sound: 'yes' }, { ...alert, taskId: '' }, { ...alert, title: ' ' }, { ...alert, title: 'a'.repeat(257) }, { ...alert, body: 'a'.repeat(2001) }]) {
    assert.equal(await f.service.show(invalid), false);
  }
  assert.equal(f.created.length, 0);
  f.outcome('failed'); assert.equal(await f.service.show(alert), false);
  f.outcome('throw'); assert.equal(await f.service.show(alert), false);
  f.unsupported(); assert.equal(await f.service.show(alert), false);
  assert.equal(f.created.length, 2);
  f.service.close();
});

test('an unresponsive OS times out and closes its pending notification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.outcome('pending');
  const sent = f.service.show(alert);
  t.mock.timers.tick(10000);
  assert.equal(await sent, false);
  assert.equal(f.created[0].notification.closed, 1);
});

test('pending sends settle on shutdown and retained notifications are bounded', async () => {
  const f = fixture(); f.outcome('pending');
  const sent = f.service.show(alert); f.service.close();
  assert.equal(await sent, false);
  f.outcome('show');
  for (let i = 0; i < 51; i++) await f.service.show({ ...alert, taskId: String(i) });
  assert.equal(f.created[1].notification.closed, 1);
  f.service.close();
  assert.ok(f.created.every(item => item.notification.closed === 1));
});
