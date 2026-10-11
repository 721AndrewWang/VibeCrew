// Builds release/Crew-<version>.AppImage. Run through `npm run desktop:pack`.
import { build, Platform } from 'electron-builder';
import { ensureElectron } from './electron-bin.mjs';

// electron-builder copies Electron from node_modules (build.electronDist), so it must be downloaded.
ensureElectron();
// The AppImage tooling is fetched on first use (set ELECTRON_BUILDER_BINARIES_MIRROR to use a mirror).

const files = await build({ targets: Platform.LINUX.createTarget('AppImage'), publish: 'never' });
for (const f of files) console.log(`\n✅ ${f}`);
