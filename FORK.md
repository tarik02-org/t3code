# T3 Code fork

This repository is the `tarik02-org/t3code` fork of `pingdotgg/t3code`.

`main` is the canonical fork history. It is linear and based on a pinned snapshot of the protected `upstream/main` mirror.
The mirror is updated by `Sync upstream main`. Actualization PRs target immutable `upstream/main-<old-main-sha>` snapshots and are promoted into `main` by `/promote`.

Read [MAINTENANCE.md](./MAINTENANCE.md) before actualizing, backporting, delivering fork changes, or releasing.

## Ownership

| Area                                                  | Owner    | Rule                                                                         |
| ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `.github/workflows/`                                  | fork     | Port useful upstream automation deliberately. Do not import it mechanically. |
| `AGENTS.md`, `FORK.md`, `MAINTENANCE.md`, `README.md` | fork     | Keep the agent contract and fork workflow current.                           |
| `.github/nix/`, `flake.nix`, `nix/`                   | fork     | Keep packaging and offline dependency inputs buildable.                      |
| `docs/`                                               | upstream | Do not spend fork maintenance on upstream documentation.                     |
| Application and shared code                           | shared   | Keep the fork delta narrow and upstream-compatible.                          |

## Compatibility

- Upstream clients can use the fork server without fork-specific assumptions.
- Existing upstream RPC contracts remain compatible.
- Fork-only RPCs are optional and advertised before clients use them.
- Fork-only durable data lives in sidecar storage.
- Thread history uses upstream bounded snapshots and turn-window APIs.

## Fork-owned behavior

- Incremental thread-shell projections and bounded command-output reads.
- Thread goals stored in a sidecar database.
- Frontmatter rendering in web and mobile previews.
- Desktop backendless mode, unsigned macOS updates, and fork packaging.
- Thread-scoped launch environment identity for providers and terminals.
