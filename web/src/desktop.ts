/** Bridge exposed by the desktop app's preload script (absent in a normal browser). */
export interface DesktopBridge {
  isDesktop: true;
  show(): void;
  retry(): void;
  openLogs(): void;
  info(): Promise<{ version: string; autostart: boolean; attached: boolean; sandboxed: boolean; logFile: string; packaged: boolean } | null>;
  setAutostart(on: boolean): Promise<boolean | null>;
}

export const desktop: DesktopBridge | undefined = (window as unknown as { vibecrewDesktop?: DesktopBridge }).vibecrewDesktop;
