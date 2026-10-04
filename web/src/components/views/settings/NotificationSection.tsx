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
    granted: { cls: 'green', text: '已允许' },
    denied: { cls: 'red', text: '已拒绝' },
    default: { cls: '', text: '未设置' },
    unsupported: { cls: '', text: '浏览器不支持' },
  };

  const ask = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch (e) {
      toast('请求通知权限失败', (e as Error).message, 'error');
    }
  };

  const test = () => {
    try {
      new Notification('Crew', { body: '桌面通知已开启：机器人完成任务或需要你确认时会提醒你。', icon: '/icon.svg' });
    } catch {
      toast('无法显示通知', '这个浏览器只允许在后台时显示通知', 'warn');
    }
  };

  return (
    <Section icon={<Bell size={18} />} title="通知">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            桌面通知 <span className={cx('badge', info[perm].cls)}>{info[perm].text}</span>
          </div>
          <div className="hint">{perm === 'denied' ? '通知被浏览器拦截了，请在地址栏左侧的网站设置里重新允许。' : '页面在后台时，机器人完成任务或等待你确认会弹出通知。'}</div>
        </div>
        {perm === 'granted' ? (
          <button className="btn sm" onClick={test}>
            发送测试通知
          </button>
        ) : (
          <button className="btn sm primary" disabled={perm !== 'default'} onClick={ask}>
            允许桌面通知
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
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await api.testPush();
      toast('测试推送已发出', '看一下手机', 'success');
    } catch (e) {
      toast('推送失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field span-all">
      <label>
        手机推送（Bark） <span className={cx('badge', push.configured && 'green')}>{push.configured ? '已设置' : '未设置'}</span>
      </label>
      <div className="hint">机器人等你确认超过设定的时间还没人处理，就推送到 iPhone。推送里只有谁在等、在做什么，不含命令内容。在 Bark App 里复制形如 https://api.day.app/你的key 的地址填到这里。</div>
      <div className="row wrap">
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder={push.configured ? '已保存（填新地址可替换）' : 'https://api.day.app/你的key'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn sm primary" disabled={busy || !url.trim()} onClick={() => save({ barkUrl: url.trim() }, 'Bark 地址已保存')}>
          保存
        </button>
      </div>
      <div className="row wrap">
        <label className="hint">
          等待超过 <input className="input sm" type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 1)} style={{ width: 70 }} /> 分钟推送
        </label>
        <button className="btn sm" disabled={busy || minutes === push.afterMinutes} onClick={() => save({ afterMinutes: minutes }, '已保存')}>
          保存时间
        </button>
        <button className="btn sm" disabled={busy || !push.configured} onClick={test}>
          发送测试推送
        </button>
        <button className="btn sm" disabled={busy || !push.configured} onClick={() => save({ barkUrl: '' }, '已关闭手机推送')}>
          关闭
        </button>
      </div>
    </div>
  );
}
