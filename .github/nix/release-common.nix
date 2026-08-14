{ repo, version }:

let
  flake = builtins.getFlake repo;
  pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; };
  runtime = pkgs.callPackage (flake.outPath + "/nix/package.nix") {
    src = flake.outPath;
    inherit version;
  };
in
runtime.overrideAttrs {
  CI = "true";

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/apps/desktop" "$out/apps/server" "$out/wsl-prebuild"
    cp -R apps/desktop/dist-electron "$out/apps/desktop/"
    cp -R apps/desktop/resources "$out/apps/desktop/"
    cp -R apps/server/dist "$out/apps/server/"
    cp apps/server/node_modules/node-pty/build/Release/pty.node "$out/wsl-prebuild/"

    runHook postInstall
  '';
}
