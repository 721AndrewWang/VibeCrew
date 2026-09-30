// Builds release/VibeCrew-<version>.AppImage. Run through `npm run desktop:pack`.
import { build, Platform } from 'electron-builder';
import { ensureElectron } from './electron-bin.mjs';

// electron-builder copies Electron from node_modules (build.electronDist), so it must be downloaded.
ensureElectron();
// The AppImage tooling is fetched on first use; the mirror is much faster here than GitHub.
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const files = await build({ targets: Platform.LINUX.createTarget('AppImage'), publish: 'never' });
for (const f of files) console.log(`\n✅ ${f}`);
