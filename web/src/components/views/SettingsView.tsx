import { PageHead } from './BotsView';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DefaultsSection } from './settings/DefaultsSection';
import { DesktopSection } from './settings/DesktopSection';
import { LanSection } from './settings/LanSection';
import { NotificationSection } from './settings/NotificationSection';
import { RoutingSection } from './settings/RoutingSection';
import { SandboxSection } from './settings/SandboxSection';

export function SettingsView() {
  return (
    <div className="page">
      <div className="page-inner settings-inner">
        <PageHead title="Settings" sub="Claude connection, defaults, sandbox, phone access and appearance" />
        <ConnectionSection />
        <DefaultsSection />
        <SandboxSection />
        <RoutingSection />
        <LanSection />
        <AppearanceSection />
        <NotificationSection />
        <DesktopSection />
        <AboutSection />
      </div>
    </div>
  );
}
