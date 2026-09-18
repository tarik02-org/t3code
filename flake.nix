{
  description = "T3 Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  nixConfig = {
    extra-substituters = [ "https://tarik02-t3code.cachix.org" ];
    extra-trusted-public-keys = [
      "tarik02-t3code.cachix.org-1:1dYWmf4BhYdWlxABQA5hK/ykj2zLlyRYXG6nMTb/jac="
    ];
  };

  outputs =
    { nixpkgs, self }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtime = pkgs.callPackage ./nix/package.nix { src = self; };
        in
        rec {
          t3code-runtime = runtime;
          t3code-headless = pkgs.callPackage ./nix/headless.nix { inherit runtime; };
          t3code-desktop =
            pkgs.callPackage
              (if pkgs.stdenv.hostPlatform.isDarwin then ./nix/desktop-darwin.nix else ./nix/desktop.nix)
              {
                inherit runtime;
                src = self;
              };

          t3code = t3code-headless;
          default = t3code;
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
