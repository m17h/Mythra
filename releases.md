# Mythra Release Process

Mythra is free but closed-source, so release downloads are published manually in the public `m17h/Mythra-Releases` repo instead of the private source repo.

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
8. The user manually uploads those assets to `https://github.com/m17h/Mythra-Releases`.

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
https://github.com/m17h/Mythra-Releases
```

Release notes shown in the app come from GitHub Release notes in that public repo. Editing release notes on GitHub does not require rebuilding Mythra.

The in-app updater uses Electron updater metadata from the same public release repo. Do not upload only the `.dmg` or only the `.exe`; without the matching `latest-mac.yml` / `latest.yml` metadata and updater asset files, Mythra can detect that a version exists but cannot show download progress, restart, and install it automatically.
