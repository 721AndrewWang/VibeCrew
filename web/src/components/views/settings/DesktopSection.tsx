import { AppWindow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { desktop } from '../../../desktop';
import { cx } from '../../../utils';
import { Toggle } from '../../ui';
import { Section } from './Section';

export function DesktopSection() {
  const [info, setInfo] = useState<Awaited<ReturnType<NonNullable<typeof desktop>['info']>>>(null);
  useEffect(() => {
    void desktop?.info().then(setInfo);
  }, []);
  if (!desktop || !info) return null;
  const toggle = async (on: boolean) => {
    const now = await desktop!.setAutostart(on);
    setInfo({ ...info, autostart: !!now });
  };
  return (
    <Section icon={<AppWindow size={18} />} title="Desktop app">
      <div className="setting-row">
        <div>
          <div className="sr-title">Launch at login</div>
          <div className="hint">Starts Crew in the background after you log in (tray icon only), so routines run on time.</div>
        </div>
        <Toggle on={info.autostart} onChange={(v) => void toggle(v)} />
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">When closing the window</div>
          <div className="hint">
            {info.attached
              ? "Connected to a server started by another process (e.g. npm start in a terminal). Closing the window or quitting the app won't stop it."
              : 'The window hides to the tray and bots keep working. To quit fully, use the tray menu or Ctrl+Q.'}
          </div>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">
            Runtime info <span className={cx('badge', info.sandboxed ? 'green' : '')}>{info.sandboxed ? 'Sandbox on' : 'Sandbox off'}</span>
          </div>
          <div className="hint">
            Desktop {info.version}
            {info.sandboxed ? '' : ' · Run sudo desktop/install-system.sh to enable the Chromium sandbox (see README)'}
          </div>
        </div>
        <button className="btn sm" onClick={() => desktop!.openLogs()}>
          View server logs
        </button>
      </div>
    </Section>
  );
}
