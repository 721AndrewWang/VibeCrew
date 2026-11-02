import { PageHead } from './BotsView';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DefaultsSection } from './settings/DefaultsSection';
import { DesktopSection } from './settings/DesktopSection';
import { GatewaySection } from './settings/GatewaySection';
import { LanSection } from './settings/LanSection';
import { NotificationSection } from './settings/NotificationSection';
import { RoutingSection } from './settings/RoutingSection';
import { SafetySection } from './settings/SafetySection';
import { SandboxSection } from './settings/SandboxSection';
import { SuperAgentSection } from './settings/SuperAgentSection';

export function SettingsView() {
  return (
    <div className="page">
      <div className="page-inner settings-inner">
        <PageHead title="Settings" sub="Claude connection, defaults, sandbox, safety, phone access and appearance" />
        <ConnectionSection />
        <GatewaySection />
        <DefaultsSection />
        <SandboxSection />
        <SafetySection />
        <RoutingSection />
        <SuperAgentSection />
        <LanSection />
        <AppearanceSection />
        <NotificationSection />
        <DesktopSection />
        <AboutSection />
      </div>
    </div>
  );
}
