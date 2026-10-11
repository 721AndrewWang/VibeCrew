import { Bell } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { cx } from '../../../utils';
import { Section } from './Section';

export function NotificationSection() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(supported ? Notification.permission : 'unsupported');
  const info: Record<string, { cls: string; text: string }> = {
    granted: { cls: 'green', text: 'Allowed' },
    denied: { cls: 'red', text: 'Blocked' },
    default: { cls: '', text: 'Not set' },
    unsupported: { cls: '', text: 'Not supported' },
  };

  const ask = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch (e) {
      toast('Could not request notification permission', (e as Error).message, 'error');
    }
  };

  const test = () => {
    try {
      new Notification('Crew', { body: "Desktop notifications are on: you'll be alerted when a bot finishes a task or needs your approval.", icon: '/icon.svg' });
    } catch {
      toast('Could not show notification', 'This browser only shows notifications while in the background', 'warn');
    }
  };

  return (
    <Section icon={<Bell size={18} />} title="Notifications">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            Desktop notifications <span className={cx('badge', info[perm].cls)}>{info[perm].text}</span>
          </div>
          <div className="hint">
            {perm === 'denied'
              ? 'The browser blocked notifications. Allow them again in the site settings left of the address bar.'
              : 'While the page is in the background, you get a notification when a bot finishes a task or waits for your approval.'}
          </div>
        </div>
        {perm === 'granted' ? (
          <button className="btn sm" onClick={test}>
            Send test notification
          </button>
        ) : (
          <button className="btn sm primary" disabled={perm !== 'default'} onClick={ask}>
            Allow desktop notifications
          </button>
        )}
      </div>
      <PhonePush />
    </Section>
  );
}

/** Bark push to an iPhone when a bot has been waiting for approval for a while. */
function PhonePush() {
  const push = useStore((s) => s.settings.push) || { configured: false, afterMinutes: 10 };
  const [url, setUrl] = useState('');
  const [minutes, setMinutes] = useState(push.afterMinutes);
  const [busy, setBusy] = useState(false);

  const save = async (p: { barkUrl?: string; afterMinutes?: number }, done: string) => {
    setBusy(true);
    try {
      const r = await api.updateSettings({ push: p });
      useStore.setState({ settings: r.settings });
      setUrl('');
      toast(done, undefined, 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await api.testPush();
      toast('Test push sent', 'Check your phone', 'success');
    } catch (e) {
      toast('Push failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field span-all">
      <label>
        Phone push (Bark) <span className={cx('badge', push.configured && 'green')}>{push.configured ? 'Set' : 'Not set'}</span>
      </label>
      <div className="hint">
        When a bot has waited for your approval longer than the set time, a push goes to your iPhone. It only says who is waiting and what they're doing, never the command itself. Copy the address
        like https://api.day.app/your-key from the Bark app and paste it here.
      </div>
      <div className="row wrap">
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder={push.configured ? 'Saved (enter a new address to replace)' : 'https://api.day.app/your-key'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn sm primary" disabled={busy || !url.trim()} onClick={() => save({ barkUrl: url.trim() }, 'Bark address saved')}>
          Save
        </button>
      </div>
      <div className="row wrap">
        <label className="hint">
          Push after waiting <input className="input sm" type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 1)} style={{ width: 70 }} /> min
        </label>
        <button className="btn sm" disabled={busy || minutes === push.afterMinutes} onClick={() => save({ afterMinutes: minutes }, 'Saved')}>
          Save time
        </button>
        <button className="btn sm" disabled={busy || !push.configured} onClick={test}>
          Send test push
        </button>
        <button className="btn sm" disabled={busy || !push.configured} onClick={() => save({ barkUrl: '' }, 'Phone push turned off')}>
          Turn off
        </button>
      </div>
    </div>
  );
}
