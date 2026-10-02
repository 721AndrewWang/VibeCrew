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
    <Section icon={<AppWindow size={18} />} title="桌面应用">
      <div className="setting-row">
        <div>
          <div className="sr-title">开机自动启动</div>
          <div className="hint">登录后在后台启动 Crew（只显示托盘图标），定时任务到点就能运行。</div>
        </div>
        <Toggle on={info.autostart} onChange={(v) => void toggle(v)} />
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">关闭窗口时</div>
          <div className="hint">
            {info.attached ? '当前连接的是另一个进程启动的服务（例如终端里的 npm start），关闭窗口或退出应用都不会停止它。' : '窗口会隐藏到托盘，机器人继续工作。要彻底退出，请用托盘菜单或 Ctrl+Q。'}
          </div>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">
            运行信息 <span className={cx('badge', info.sandboxed ? 'green' : '')}>{info.sandboxed ? '沙盒已开启' : '未开启沙盒'}</span>
          </div>
          <div className="hint">
            桌面版 {info.version}
            {info.sandboxed ? '' : ' · 运行 sudo desktop/install-system.sh 可以开启 Chromium 沙盒（见 README）'}
          </div>
        </div>
        <button className="btn sm" onClick={() => desktop!.openLogs()}>
          查看服务日志
        </button>
      </div>
    </Section>
  );
}
