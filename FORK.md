# Fork Notes

This repository is a fork of `pingdotgg/t3code`. Keep this file focused on fork behavior that intentionally differs from upstream.

## Changes

### Maintenance

- Squash commits when merging fork PRs.
- Exception: upstream actualization PRs may preserve upstream commit structure when that makes future syncs easier to audit.

### Compatibility

- Fork backend changes must remain compatible with non-fork clients. Upstream clients must be able to use a fork server without fork-specific assumptions or protocol failures.
- Fork database changes and migrations must leave the database usable by regular upstream builds. The upstream backend must still open and use the database, and the upstream frontend must still work through that backend. Prefer sidecar databases for fork-only data.

### Release And CI

- Fork workflows create/update a daily stable release PR while main-branch pushes produce nightly releases.
- Release PR preparation runs after release publication so tag-based version resolution sees the latest release.
- Release build jobs skip relay client tracing config because the relay config job is disabled.
- Release builds publish updater metadata against the fork repository.
- Fork stable release versions are committed through release PRs before release artifacts are built and tagged.
- macOS release signing is separate from Apple notarization.
- Self-signed macOS signing certificates are trusted during release builds.
- macOS passkey entitlements are only enabled when Apple notarization/profile configuration is present.
- Windows releases can sign with the static certificate when Azure Trusted Signing is not configured.
- Fork release jobs use GitHub-hosted runners where upstream private runners are unavailable.
- Web dist release archives are built as hosted static apps and carry the release channel.

### Nix Package

- The fork exposes the server and web bundle as an `x86_64-linux` flake package.
- The package version follows the server manifest by default and supports the generated nightly version override.

### Desktop Updater Channels

- Stable builds use `latest`; nightly builds use `nightly`.
- Nightly detection accepts fork release metadata while preserving the upstream channel split.

### Fork Persistence

- Fork-only goal persistence is stored in a sidecar database named `state-tarik02.sqlite`.
- The web client keeps fetched thread-history rows in an unbounded, normalized sidecar IndexedDB
  cache. Messages, activities, and plans are stored once and reused for covered history ranges.

### Goals UI

- The fork adds thread goal support, goal activity rendering, and goal sidebar/panel UI.

### Provider Launch Environment

- Provider sessions use a shared launch environment pipeline instead of ad hoc environment assembly.

### Base Path And Remote URLs

- The fork includes base-path handling for served web assets and remote URL normalization.

### UX Changes

- Thread detail snapshots keep a bounded live tail. Historical browsing uses bounded,
  bidirectional keyset windows, while the web minimap samples landmarks across the full thread and
  loads the selected segment on demand. The web timeline represents unloaded ranges as virtual
  scroll space and swaps bounded segments in as the user approaches or jumps into them. Historical
  windows retain every message, cap work telemetry per segment, and only display activity for turns
  represented by the active message window. Viewport navigation, minimap jumps, and unloaded spacers
  share one fixed per-message scroll axis and load the nearest landmark window through a trailing
  throttle instead of chaining relative before/after page loads. The content container keeps the
  full-history extent fixed while the trailing spacer absorbs measured segment height. Legend List
  position stabilization is disabled for these threads, and its cached window geometry is refreshed
  when a segment moves without interrupting an active smooth scroll.
  Paginated history responses use the same client-facing activity payload projection as full thread
  snapshots, and failed segment requests release their pending navigation target instead of leaving
  the virtual loader locked. Minimap jumps begin scrolling through virtual history immediately while
  the segment loads, then align the loaded target with a smooth correction instead of teleporting
  the viewport after the response.
- Desktop context-menu style is configurable.
- The sidebar follows the active thread when it appears or when navigation originates elsewhere.
- Sidebar environments can be hidden or shown dynamically from the project toolbar.
- Threads can be archived with middle click.
- Terminal selection has a copy action.
