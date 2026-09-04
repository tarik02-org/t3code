# T3 Code

T3 Code is a local GUI for Codex, Claude Code, Cursor, Grok Build, OpenCode, and Antigravity. It runs provider agents on your machine and lets web, desktop, and mobile clients control them.

This repository is the `tarik02-org` fork of [T3 Code](https://github.com/pingdotgg/t3code). It stays compatible with upstream clients and data while carrying a small set of product changes and its own release pipeline. See [FORK.md](./FORK.md) for the maintained behavior and ownership rules.

## Fork goals

- Keep long conversations fast without transferring or rendering the whole thread on every update.
- Prefer small, self-contained changes that can be replayed on current upstream code.
- Base stable releases on explicit upstream stable commits.
- Publish first-party Nix, desktop, and web artifacts.

## Compatibility

- Upstream clients can use the fork server, and fork clients can use upstream servers.
- Existing upstream RPC contracts remain compatible.
- Fork-only RPCs are optional and advertised before clients use them.
- Fork-only durable data uses separate sidecar storage.

## Maintained changes

- Incremental thread-shell projections and bounded command-output reads.
- Provider-backed thread goals stored in a sidecar database.
- Frontmatter rendering in web and mobile previews.
- Desktop backendless mode and unsigned macOS updates.
- Thread-scoped launch environment identity for providers and terminals.
- Nix packaging and stable, nightly, and manually managed canary releases.

## Installation

Install and authenticate at least one supported provider before starting T3 Code.

### Release artifacts

Desktop builds for macOS, Linux, and Windows, plus hosted web archives, are available from [GitHub Releases](https://github.com/tarik02-org/t3code/releases). Desktop builds are unsigned, so the operating system may ask you to approve them on first launch.

### Nix

The Nix flake currently supports `x86_64-linux` and exposes `t3code-desktop` and `t3code-headless` packages.

## Development

Install [Vite+](https://viteplus.dev/guide/), then install the workspace dependencies:

```console
vp i
```

Read [MAINTENANCE.md](./MAINTENANCE.md) before changing fork history or release state. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or pull request.
