# Mythra Release Process

Mythra release downloads are published with the public `m17h/Mythra` source repository so the code, release notes, signed installers, and update metadata live together.

## Release Assets Folder

When creating release assets, use the root folder:

```text
Release Assets/
```

Create one subfolder per version using this format:

```text
Release Assets/v 0.3.0/
```

Use the actual version number for the release. Examples:

```text
Release Assets/v 0.2.0/
Release Assets/v 0.3.0/
Release Assets/v 1.0.0/
```

## Required Order

1. Build the latest app for the target version.
2. Sign the macOS `.app`.
3. Notarize the macOS `.app`.
4. Staple and verify the notarization ticket.
5. Create macOS release assets only from that final signed, notarized, stapled `.app`.
6. Build/create the Windows release asset for the same version.
7. Place all release assets in the matching `Release Assets/v X.Y.Z/` folder.
8. Upload those assets to the matching release at `https://github.com/m17h/Mythra/releases`.

Do not create macOS release assets from an unsigned, unnotarized, or pre-stapled app bundle.

## Typical Assets

For a normal release, prepare:

```text
Mythra <version>.dmg
Mythra-<version>-arm64-notarized.zip
latest-mac.yml
Mythra-Setup-<version>.exe
Mythra-Setup-<version>.exe.blockmap
latest.yml
```

The `.dmg` is for direct user downloads. The `.zip` plus `latest-mac.yml` are required for the in-app macOS updater. The `.exe`, `.exe.blockmap`, and `latest.yml` are required for the in-app Windows updater.

## Update System Notes

Mythra checks the public release repo for updates and release notes:

```text
https://github.com/m17h/Mythra/releases
```

Release notes shown in the app come from GitHub Releases in the main repository. Editing release notes on GitHub does not require rebuilding Mythra.

The in-app updater uses Electron updater metadata from the same main repository. Do not upload only the `.dmg` or only the `.exe`; without the matching `latest-mac.yml` / `latest.yml` metadata and updater asset files, Mythra can detect that a version exists but cannot show download progress, restart, and install it automatically.
