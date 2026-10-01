import { PageHead } from './BotsView';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DefaultsSection } from './settings/DefaultsSection';
import { DesktopSection } from './settings/DesktopSection';
import { LanSection } from './settings/LanSection';
import { NotificationSection } from './settings/NotificationSection';
import { SandboxSection } from './settings/SandboxSection';

export function SettingsView() {
  return (
    <div className="page">
      <div className="page-inner settings-inner">
        <PageHead title="设置" sub="连接 Claude、默认值、沙盒、手机访问和外观" />
        <ConnectionSection />
        <DefaultsSection />
        <SandboxSection />
        <LanSection />
        <AppearanceSection />
        <NotificationSection />
        <DesktopSection />
        <AboutSection />
      </div>
    </div>
  );
}
