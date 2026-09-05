{
  cacert,
  fetchPnpmDeps,
  lib,
  libsecret,
  node-gyp,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  pkg-config,
  python3,
  rustPlatform,
  src,
  stdenv,
  version ? null,
  writableTmpDirAsHomeHook,
}:

let
  nodejs = nodejs_24;
  pnpm = pnpm_11;
  sourceVersion = (builtins.fromJSON (builtins.readFile "${src}/apps/server/package.json")).version;
  resourceMonitor = rustPlatform.buildRustPackage {
    pname = "t3-resource-monitor";
    version =
      (builtins.fromTOML (builtins.readFile "${src}/native/resource-monitor/Cargo.toml")).package.version;
    src = "${src}/native/resource-monitor";
    cargoLock.lockFile = "${src}/native/resource-monitor/Cargo.lock";
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "t3code-runtime";
  version = if version == null then sourceVersion else version;
  inherit src;
  strictDeps = true;

  pnpmWorkspaces = [
    "@t3tools/monorepo"
    "@t3tools/desktop..."
    "@t3tools/scripts..."
    "t3..."
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-mgRMeBpJmiTat38APyE4guNJ+6RiQhenphP7tRcmc+k=";
  };

  postPatch = lib.optionalString (finalAttrs.version != sourceVersion) ''
    substituteInPlace \
      apps/desktop/package.json \
      apps/server/package.json \
      apps/web/package.json \
      packages/contracts/package.json \
      --replace-fail '"version": "${sourceVersion}"' \
      '"version": "${finalAttrs.version}"'
  '';

  nativeBuildInputs = [
    node-gyp
    nodejs
    pnpm
    pnpmConfigHook
    pkg-config
    python3
    writableTmpDirAsHomeHook
  ];

  buildInputs = [ libsecret ];

  dontPatchELF = true;
  noAuditTmpdir = true;
  SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";

  preBuild = ''
    export npm_config_nodedir=${nodejs}
    export ELECTRON_SKIP_BINARY_DOWNLOAD=1
    pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'
  '';

  buildPhase = ''
    runHook preBuild
    pnpm run build:desktop
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    app="$out/libexec/t3code"
    mkdir -p "$app/apps/desktop" "$app/apps/server"

    cp --recursive --no-preserve=mode node_modules packages "$app"
    cp --recursive --no-preserve=mode \
      apps/desktop/node_modules \
      apps/desktop/dist-electron \
      apps/desktop/resources \
      "$app/apps/desktop"
    cp --recursive --no-preserve=mode apps/desktop/resources \
      "$app/apps/desktop/prod-resources"
    cp --recursive --no-preserve=mode \
      apps/server/node_modules \
      apps/server/dist \
      "$app/apps/server"

    ${lib.getExe nodejs} -e '
      const fs = require("node:fs");
      const desktop = JSON.parse(fs.readFileSync("apps/desktop/package.json", "utf8"));
      fs.writeFileSync(process.argv[1], JSON.stringify({
        name: "t3code",
        version: desktop.version,
        productName: desktop.productName,
        main: "apps/desktop/dist-electron/main.cjs",
        type: "module"
      }, null, 2) + "\n");
    ' "$app/package.json"

    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor \
      "$app/apps/server/dist/resource-monitor/linux-x64/t3-resource-monitor"
    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor \
      "$app/apps/desktop/prod-resources/resource-monitor/t3-resource-monitor"

    find "$app" -xtype l -delete

    runHook postInstall
  '';

  meta = {
    description = "Shared runtime for T3 Code server and desktop packages";
    homepage = "https://github.com/tarik02-org/t3code";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
  };
})
