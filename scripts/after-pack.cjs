'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

/**
 * Remove default Electron branding leftovers and asset-catalog icon keys that confuse Finder.
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;

  const appOutDir = context.appOutDir;
  if (!appOutDir || !fs.existsSync(appOutDir)) return;

  const bundles = fs.readdirSync(appOutDir).filter((n) => n.endsWith('.app'));
  for (const name of bundles) {
    const contents = path.join(appOutDir, name, 'Contents');
    const electronIcns = path.join(contents, 'Resources', 'electron.icns');
    if (fs.existsSync(electronIcns)) {
      fs.unlinkSync(electronIcns);
    }

    const plistPath = path.join(contents, 'Info.plist');
    if (fs.existsSync(plistPath)) {
      try {
        execSync(`/usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' ${JSON.stringify(plistPath)}`, {
          stdio: 'ignore'
        });
      } catch {
        /* key absent */
      }
      try {
        const iconFile = execSync(`/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' ${JSON.stringify(plistPath)}`, {
          encoding: 'utf8'
        }).trim();
        if (iconFile.endsWith('.icns')) {
          const base = iconFile.slice(0, -'.icns'.length);
          execSync(`/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile ${base}' ${JSON.stringify(plistPath)}`);
        }
      } catch {
        /* unset */
      }
    }
  }
};
