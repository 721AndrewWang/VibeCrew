import { Bell } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../../../store';
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
    </Section>
  );
}
