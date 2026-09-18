{
  description = "T3 Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, self }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      packages.${system} =
        let
          runtime = pkgs.callPackage ./nix/package.nix { src = self; };
        in
        rec {
          t3code-runtime = runtime;
          t3code-headless = pkgs.callPackage ./nix/headless.nix { inherit runtime; };
          t3code-desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit runtime;
            src = self;
          };

          t3code = t3code-headless;
          default = t3code;
        };

      formatter.${system} = pkgs.nixfmt;
    };
}
