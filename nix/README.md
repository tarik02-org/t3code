# Nix

The flake exports headless and desktop T3 Code packages for `x86_64-linux` and
`aarch64-darwin`:

- `t3code-headless` provides the `t3` CLI and server.
- `t3code-desktop` provides the Electron desktop application.
- `t3code` and `default` remain aliases for `t3code-headless`.

Build the desktop application with:

```console
nix build github:tarik02-org/t3code#t3code-desktop
```

On macOS, the desktop package includes `Applications/T3 Code.app`. Add it to
`environment.systemPackages` in nix-darwin to expose the application. Updates are
managed by Nix, not the desktop updater.

## Prebuilt packages

Trusted `main` builds publish both packages to the public `tarik02-t3code` Cachix
cache. Pull requests build without cache write credentials. Packages are built
from the flake directly, without release version overrides or release-asset hashes.
Pin the flake revision in your lockfile to select a version.

The flake offers the cache configuration when used directly. For NixOS or
nix-darwin configurations that consume it as an input, configure the cache explicitly:

```nix
nix.settings = {
  extra-substituters = [ "https://tarik02-t3code.cachix.org" ];
  extra-trusted-public-keys = [
    "tarik02-t3code.cachix.org-1:1dYWmf4BhYdWlxABQA5hK/ykj2zLlyRYXG6nMTb/jac="
  ];
};
```

Cache entries may be evicted when storage fills. Nix builds from source when a
matching prebuilt package is unavailable.

## NixOS user service

Add T3 Code to your flake inputs:

```nix
inputs.t3code.url = "github:tarik02-org/t3code";
```

Then add the package and user service to your NixOS configuration:

```nix
{ inputs, pkgs, ... }:

let
  t3code = inputs.t3code.packages.${pkgs.stdenv.hostPlatform.system}.t3code-headless;
in
{
  environment.systemPackages = [ t3code ];

  systemd.user.services.t3code = {
    description = "T3 Code server";
    wantedBy = [ "default.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];

    serviceConfig = {
      Type = "simple";
      ExecStart = "${t3code}/bin/t3 serve --host 0.0.0.0 --port 3773";
      WorkingDirectory = "%h";
      Environment = [ "T3CODE_NO_BROWSER=1" ];
      Restart = "on-failure";
      RestartSec = "5s";
      OOMPolicy = "continue";
    };
  };
}
```
