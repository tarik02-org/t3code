# T3 Code

T3 Code is a local GUI for Codex, Claude Code, Cursor, Grok Build, and OpenCode. It runs provider CLIs on your machine and lets web, desktop, and mobile clients control them.

This repository is the `tarik02-org` fork of [T3 Code](https://github.com/pingdotgg/t3code). It stays compatible with upstream clients and data where practical, while carrying its own product changes and delivery pipelines. See [FORK.md](./FORK.md) for the maintained compatibility and ownership rules.

## Fork goals

- Performance: long conversations should not kill the orchestration or client performance.
- Self-contained features - small features that are not hard to maintain and keep compatible.

## Fork compatibility

Fork remains fully compatible with upstream t3code:

- Protocol: upstream client can work with fork server and vice versa.
- Storage separation: switching between upstream and fork works flawlessly - fork has separate database for fork-only features.

## Fork highlights

- Progressive thread history with bounded snapshots, on-demand history pages, and a conversation minimap.
- Provider-backed thread goals with timeline activity and a dedicated goal panel.
- A desktop mode that can skip the bundled local backend and connect only to saved remote environments.

## Installation

Install and authenticate at least one supported provider CLI before starting T3 Code.

### Desktop releases

Desktop builds for macOS, Linux, and Windows are available from [GitHub Releases](https://github.com/tarik02-org/t3code/releases). These builds are unsigned, so the operating system may ask you to approve them on first launch.

### Nix

The Nix flake currently supports only `x86_64-linux`.

Run the desktop app with:

```console
nix run github:tarik02-org/t3code#t3code-desktop
```

Run the headless server with:

```console
nix run github:tarik02-org/t3code#t3code-headless
```

## Development

Install [Vite+](https://viteplus.dev/guide/), then install the workspace dependencies:

```console
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or pull request.
