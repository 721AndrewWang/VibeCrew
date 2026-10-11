import { Check, Copy, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { copyText } from '../../../utils';
import { Toggle } from '../../ui';
import { Section } from './Section';

export function LanSection() {
  const enabled = useStore((s) => s.settings.lanEnabled);
  const [busy, setBusy] = useState(false);
  const [lan, setLan] = useState<{ url?: string; qr: string | null; tailscaleUrl?: string; tailscaleQr: string | null } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLan(null);
      return;
    }
    let cancelled = false;
    api
      .lan()
      .then((r) => !cancelled && setLan(r))
      .catch((e) => !cancelled && toast('Could not get phone access link', (e as Error).message, 'error'));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      const r = await api.updateSettings({ lanEnabled: v });
      useStore.setState({ settings: r.settings, lanUrl: r.lanUrl });
    } catch (e) {
      toast('Could not switch', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={<Smartphone size={18} />} title="Phone access">
      <div className="setting-row">
        <div>
          <div className="sr-title">Allow phone access</div>
          <div className="hint">
            Restart Crew after turning this on. Use the LAN link when the phone and computer are on the same network. With Tailscale installed, the phone can also use the Tailscale link when you're
            out (only devices in your Tailscale can connect). The links contain an access token, so don't share them.
          </div>
        </div>
        <Toggle on={enabled} disabled={busy} onChange={toggle} />
      </div>
      {enabled && (
        <div className="lan-box">
          {!lan ? (
            <div className="row muted">
              <span className="spinner" /> Generating QR code…
            </div>
          ) : lan.url || lan.tailscaleUrl ? (
            <>
              {lan.url && <AccessLink title="LAN: scan with your phone camera" url={lan.url} qr={lan.qr} />}
              {lan.tailscaleUrl && (
                <AccessLink title="Tailscale: works when you're out" url={lan.tailscaleUrl} qr={lan.tailscaleQr} hint="Install Tailscale on the phone too and sign in to the same account. " />
              )}
            </>
          ) : (
            <div className="hint">No LAN or Tailscale address found. Make sure the computer is online (or Tailscale is connected), then restart Crew.</div>
          )}
        </div>
      )}
    </Section>
  );
}

function AccessLink({ title, url, qr, hint }: { title: string; url: string; qr: string | null; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="access-link">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: an SVG the qrcode library made on our own server */}
      {qr && <div className="qr-box" dangerouslySetInnerHTML={{ __html: qr }} />}
      <div className="lan-info">
        <div className="sr-title">{title}</div>
        <div className="code-line">
          <code className="ellipsis">{url}</code>
          <button
            className="icon-btn sm"
            title="Copy link"
            onClick={() =>
              void copyText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="hint">{hint ?? ''}Once open, use "Add to Home Screen" in the phone browser to use it like an app.</div>
      </div>
    </div>
  );
}
