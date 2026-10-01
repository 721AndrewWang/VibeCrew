import { PageHead } from './BotsView';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DefaultsSection } from './settings/DefaultsSection';
import { DesktopSection } from './settings/DesktopSection';
import { LanSection } from './settings/LanSection';
import { NotificationSection } from './settings/NotificationSection';

export function SettingsView() {
  return (
    <div className="page">
      <div className="page-inner settings-inner">
        <PageHead title="设置" sub="连接 Claude、默认值、手机访问和外观" />
        <ConnectionSection />
        <DefaultsSection />
        <LanSection />
        <AppearanceSection />
        <NotificationSection />
        <DesktopSection />
        <AboutSection />
      </div>
    </div>
  );
}
