# T3 Code fork

This repository is the `tarik02-org/t3code` fork of `pingdotgg/t3code`. This file records the parts the fork owns, the compatibility rules it keeps, and the behavior that intentionally differs from upstream.

## Ownership boundaries

| Path                                                      | Status                         | Maintenance rule                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`                                                   | Out of scope                   | The directory comes from upstream and may not describe the fork correctly. Fork changes do not require updates there.                                 |
| `.github/workflows/`                                      | Fully replaced                 | The fork owns every workflow. Do not merge upstream workflow changes mechanically. Port useful changes into the fork pipelines when they still apply. |
| `README.md`, `FORK.md`, `.github/nix/`, `flake.*`, `nix/` | Fork-owned                     | These files describe and distribute the fork. Maintain them against the fork rather than upstream.                                                    |
| Application and shared package code                       | Upstream-compatible fork delta | Keep changes narrow enough to make upstream merges reviewable. Preserve client, protocol, and data compatibility where the rules below require it.    |

`README.md` and this file are the maintained entry points for fork users and maintainers.

## Maintenance

- Update this file when fork ownership, compatibility rules, or user-visible fork behavior changes.
- Prepare fork PR branches from `origin/main` and target `tarik02-org/t3code:main`.
- Squash fork feature PRs. Upstream actualization PRs may preserve upstream commits when that makes later syncs easier to audit.
- Treat `.github/workflows/` as fork code during upstream merges. Review upstream automation for useful ideas, but keep the fork implementation.
- Do not spend fork work on `docs/`. Avoid linking users to it as fork documentation.
- Only the automated stable release PR commits release version bumps. Nightly and canary versions are generated during their builds.
- Recheck Electron updater channels and artifact names when changing versions, release metadata, or desktop packaging.
- Staged formatting tolerates chunks that contain only ignored files so large upstream merges can pass the pre-commit hook.

## Compatibility contract

### Clients and RPC

- Upstream clients must be able to use a fork server without fork-specific assumptions or protocol failures.
- Existing upstream RPC methods keep their upstream request, response, and behavior contracts.
- Fork protocol extensions use separate RPC methods and optional advertised capabilities.
- Fork clients call an extension only when the server advertises it. They keep the upstream path as a fallback.
- Fork servers keep the upstream handler beside each extension.

### Persistence

- Upstream builds must still be able to open and use the main database after it has been used by the fork.
- Fork-only durable data belongs in a sidecar database. Thread goals use `state-tarik02.sqlite`.
- Bounded thread snapshots use fork-namespaced cache keys, so upstream clients ignore them and the fork does not decode old unbounded snapshot entries.

## Fork features

### Thread synchronization and history

- Fork servers advertise `threadDeltaSubscription` and expose `orchestration.subscribeThread.withDelta` beside the upstream thread subscription.
- Delta subscriptions replay gaps of up to 1,000 orchestration events. Larger or invalid gaps receive a fresh snapshot. A deleted thread produces `not-found`, which lets clients clear stale state.
- Upstream `threadSnapshotPagination` remains the default bounded-history protocol with its original endpoint and cursor behavior.
- The beta advanced-history client uses the independent `threadMessagePagination` capability. It adds a bounded initial snapshot, bidirectional message pages, and a thread-history outline through fork-only endpoints.
- Progressive thread history is a client setting and defaults to off.
- The web client keeps normalized history pages in an IndexedDB sidecar cache. The mobile client uses a bounded in-memory LRU for the current session.
- The web timeline keeps a bounded live tail and loads historical windows at user-turn boundaries. Its minimap indexes the whole conversation and loads the selected segment on demand.
- Paginated history uses the same client-facing activity projection as regular snapshots. The server removes omitted command output before schema decoding without changing persisted activity.

### Thread goals

- Providers that support goals can report goal state and receive goal commands.
- The web client renders goal activity, exposes `/goal`, and adds a right-side goal panel.
- Plans remain timeline entries and do not share the goal panel.

### Desktop behavior

- Packaged desktop builds serve the bundled web client directly from Electron. Development builds keep using Vite.
- The persisted **Local backend** setting lives under **Settings** then **Connections** and defaults to enabled. Changing it restarts the app.
- When the local backend is enabled, Electron opens the client while backend authentication finishes in the background.
- When it is disabled, Electron skips the managed local and WSL backends and loads saved direct and SSH environments. Local data stays on disk and returns when the setting is enabled again.
- Stable, nightly, and canary builds use separate `latest`, `nightly`, and `canary` updater feeds.
- Canary builds keep server and client state under `~/.t3/canary` and Electron data under `t3code-canary`. Desktop settings stay shared across channels.
- macOS updates are unsigned. A detached helper replaces the installed app bundle instead of using the Squirrel.Mac installer.
- Desktop context-menu style is configurable. Legacy sidebar threads support middle-click archive, and terminal selections have a copy action.

### Runtime and remote access

- Provider sessions use one shared launch-environment pipeline.
- Default-mode Codex instructions allow `request_user_input` when the runtime exposes it.
- Codex threads can inherit, allow, or reject Default-mode questions through the model options
  menu. Changing the option recreates that thread's Codex session before its next turn.
- Served web assets support a base path, and clients normalize remote URLs consistently.

## CI and releases

### CI

- All jobs use GitHub-hosted runners and Vite+ dependency caching.
- JavaScript tests run as server, web, mobile, desktop, and library shards. Server tests split into two Vitest shards. Rust resource-monitor tests run separately.
- Pull requests also run checks, typechecks, the desktop build, mobile native static analysis, release smoke coverage, and the Nix dependency hash check.
- Thread-transfer results from the server shards feed the separate transfer-budget report workflow.

### Releases

- The stable release workflow maintains a release PR from `release/stable` to `main`. It refreshes after relevant main changes, after a stable publish, on a daily schedule, and on manual dispatch.
- Merging a stable release PR commits the next date-based `YYYY.M.DDSS` version. The stable build workflow packages that commit without sharing cancellation state with prerelease builds.
- Other main pushes publish immutable nightly versions. Canary branch pushes publish immutable `X.Y.Z-canary.YYYYMMDD.RUN` versions. A newer branch push cancels the older prerelease build at the workflow level.
- Stable and prerelease entry workflows share the same reusable packaging workflow, so channel routing does not duplicate build steps.
- Stable release notes include every commit since the previous stable tag, including commits introduced by upstream merges.
- Shared server and desktop build output is produced once with Nix and reused by the macOS, Linux, and Windows packaging jobs. GitHub Actions caches the Nix store paths.
- Releases contain unsigned macOS DMGs, a Linux AppImage, a Windows NSIS installer, updater metadata, and a hosted-static web archive.
- Release reruns update an existing GitHub Release and replace its assets, so a partially published release can be recovered.
- The workflows contain no signing or notarization path.

### Nix packages

- The flake exports `t3code-headless`, `t3code-desktop`, and the shared `t3code-runtime` for `x86_64-linux`. `t3code` and `default` point to the headless package.
- Package versions follow the server manifest for stable builds and accept generated nightly or canary versions during release builds.
- Pull requests verify the pnpm dependency hash and keep one comment with the exact `nix/package.nix` fix when it drifts.
- Main, master, and canary pushes open or update a repair PR against the affected branch when the hash drifts, then fail the source workflow.
