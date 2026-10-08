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
      .catch((e) => !cancelled && toast('获取手机访问链接失败', (e as Error).message, 'error'));
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
      toast('切换失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={<Smartphone size={18} />} title="手机访问">
      <div className="setting-row">
        <div>
          <div className="sr-title">允许手机访问</div>
          <div className="hint">
            开启后需要重启 Crew。手机和电脑在同一局域网时用局域网链接；装了 Tailscale 的话，手机在外面也能用 Tailscale 链接访问（只有你 Tailscale 里的设备连得上）。链接里带有访问令牌，不要分享给别人。
          </div>
        </div>
        <Toggle on={enabled} disabled={busy} onChange={toggle} />
      </div>
      {enabled && (
        <div className="lan-box">
          {!lan ? (
            <div className="row muted">
              <span className="spinner" /> 正在生成二维码…
            </div>
          ) : lan.url || lan.tailscaleUrl ? (
            <>
              {lan.url && <AccessLink title="局域网：用手机相机扫码打开" url={lan.url} qr={lan.qr} />}
              {lan.tailscaleUrl && <AccessLink title="Tailscale：在外面也能打开" url={lan.tailscaleUrl} qr={lan.tailscaleQr} hint="手机上也要装 Tailscale，并登录同一个账号。" />}
            </>
          ) : (
            <div className="hint">没有检测到局域网或 Tailscale 地址。请确认电脑已连接网络（或 Tailscale 已连上），然后重启 Crew。</div>
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
            title="复制链接"
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
        <div className="hint">{hint ?? ''}打开后可以在手机浏览器里「添加到主屏幕」，像 App 一样使用。</div>
      </div>
    </div>
  );
}
