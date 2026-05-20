// Phase 22 — macOS ad-hoc signing hook.
//
// We don't have an Apple Developer ID ($99/year) yet, so the .app
// bundle ships unsigned. macOS Gatekeeper rejects unsigned apps with
// a generic "app is damaged" error on first launch — even though
// nothing is damaged. Workaround: ad-hoc-sign the app with the
// built-in `codesign -s -` (identity "-" means ad-hoc). This produces
// a signature with no certificate authority chain, which Gatekeeper
// still warns about on first launch (right-click → Open works), but
// at least the app doesn't get quarantine-killed outright.
//
// On platforms other than macOS this hook is a no-op. On macOS, if
// the user has set CSC_LINK (proper Developer ID), electron-builder
// already signed it for real — we just no-op then too.

const { execSync } = require('child_process');
const path = require('path');

module.exports = async function adHocSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  // If CSC_LINK is set, electron-builder did proper signing already.
  // Don't double-sign — would invalidate the real cert chain.
  if (process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD) {
    console.log('[mac-sign] CSC_LINK present — skipping ad-hoc (already signed)');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  console.log(`[mac-sign] Ad-hoc signing ${appPath}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('[mac-sign] Ad-hoc signature applied. First-launch Gatekeeper warning still expected; right-click → Open bypasses.');
  } catch (e) {
    console.warn('[mac-sign] codesign failed (non-fatal): ' + e.message);
  }
};
