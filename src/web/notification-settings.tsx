import { useState } from 'react';
import { ChipSelect } from './chip-select.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import { nativeNotifications, nativeNotificationSound, setNotificationEvent, setNotificationSound, setNotifications, testNotification, useNotifications, type NotificationEvent } from './notifications.ts';

export function NotificationSettings() {
  const events: { event: NotificationEvent; label: string; detail: string }[] = [
    { event: 'input', label: t('Input needed'), detail: t('Notify me when an agent asks me a question.') },
    { event: 'approval', label: t('Approval requests'), detail: t('Notify me when an agent needs my approval to continue.') },
    { event: 'review', label: t('Review ready'), detail: t('Notify me when changes are ready for review.') },
    { event: 'finished', label: t('Task finished'), detail: t('Notify me when an agent finishes without changes to review.') },
    { event: 'error', label: t('Task errors'), detail: t('Notify me when a task fails or stops unexpectedly.') },
  ];
  const notifications = useNotifications();
  const [asking, setAsking] = useState(false), [test, setTest] = useState<'' | 'sent' | 'failed'>('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const on = notifications.on && notifications.permission === 'granted';
  const blocked = notifications.permission === 'unsupported' ? t('This browser cannot show notifications.')
    : notifications.permission === 'insecure' ? t('Browsers show notifications only on HTTPS or localhost. Open Papilot at a secure address to use them.')
    : notifications.permission === 'denied' ? t('Notifications are blocked for this site. Allow them in the browser’s site settings, then turn them on here.') : '';
  async function toggle(value: boolean) {
    setAsking(true); setTest(''); setError('');
    try { await setNotifications(value); }
    catch { setError(t('This browser could not enable notifications.')); }
    finally { setAsking(false); }
  }
  async function sendTest() {
    setTesting(true); setTest('');
    try { setTest(await testNotification() ? 'sent' : 'failed'); }
    finally { setTesting(false); }
  }
  return <div className="settings-page">
    <section className="settings-card">
      <div className="settings-row settings-notifications">
        <div className="settings-text">
          <label className="settings-name" htmlFor="settings-notify">{t('Notifications')}</label>
          <p id="settings-notify-detail">{blocked || t('Show desktop notifications while Papilot is in the background.')}</p>
        </div>
        <input id="settings-notify" type="checkbox" role="switch" className="switch" aria-describedby="settings-notify-detail" checked={on} disabled={asking || (Boolean(blocked) && !on)} onChange={event => void toggle(event.target.checked)}/>
      </div>
      {nativeNotificationSound && <div className="settings-row">
        <div className="settings-text">
          <label className="settings-name" htmlFor="settings-notify-sound">{t('Play a sound')}</label>
          <p id="settings-notify-sound-detail">{t('Play the system notification sound.')}</p>
        </div>
        <input id="settings-notify-sound" type="checkbox" role="switch" className="switch" aria-describedby="settings-notify-sound-detail" checked={notifications.sound} disabled={!on} onChange={event => { setNotificationSound(event.target.checked); setTest(''); }}/>
      </div>}
      {nativeNotifications && !nativeNotificationSound && <div className="settings-row">
        <div className="settings-text">
          <span className="settings-name">{t('Notification sound')}</span>
          <p>{t('Notification sounds are managed by your system settings.')}</p>
        </div>
      </div>}
      {error && <p role="alert" className="settings-test">{error}</p>}
      {on && <div className="settings-test">
        <button type="button" className="button secondary compact" disabled={testing} onClick={() => void sendTest()}><Icon name="bell" size={14}/>{t('Send a test notification')}</button>
        {test && <span role="status">{nativeNotifications
          ? test === 'sent' ? t('Sent. If nothing appeared, allow notifications and sounds for Papilot in your system settings.') : t('Papilot could not show the notification. Check your system notification settings.')
          : test === 'sent' ? t('Sent. If nothing appeared, allow notifications for this browser in your system settings.') : t('This browser could not show the notification.')}</span>}
      </div>}
    </section>
    <section aria-labelledby="settings-notify-events">
      <h3 id="settings-notify-events" className="settings-section-title">{t('Notify me about')}</h3>
      <div className="settings-card">
        {events.map(({ event, label, detail }) => <div key={event} className="settings-row settings-notification-event">
          <div className="settings-text"><span className="settings-name">{label}</span><p>{detail}</p></div>
          <ChipSelect label={label} value={notifications.events[event] ? 'push' : 'off'} options={[{ value: 'push', label: t('Push') }, { value: 'off', label: t('Off') }]} onChange={value => setNotificationEvent(event, value === 'push')}/>
        </div>)}
      </div>
    </section>
  </div>;
}
