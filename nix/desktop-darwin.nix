{
  electron_44-bin,
  imagemagick,
  lib,
  makeWrapper,
  python3,
  runtime,
  src,
  stdenvNoCC,
}:

stdenvNoCC.mkDerivation {
  pname = "t3code-desktop";
  inherit (runtime) version;
  dontUnpack = true;
  dontStrip = true;

  passthru.electron = electron_44-bin;

  nativeBuildInputs = [
    makeWrapper
    python3
  ];

  installPhase = ''
    runHook preInstall

    app="$out/Applications/T3 Code.app"
    mkdir -p "$out/Applications" "$out/bin"
    cp -R ${electron_44-bin}/Applications/Electron.app "$app"
    chmod -R u+w "$app"
    rm -f "$app/Contents/Resources/default_app.asar"
    cp -R ${runtime}/libexec/t3code "$app/Contents/Resources/app"
    cp -R ${runtime}/libexec/t3code/apps/desktop/prod-resources/. "$app/Contents/Resources/"

    mkdir icon.iconset
    for size in 16 32 128 256 512; do
      ${lib.getExe imagemagick} ${src}/assets/prod/black-macos-1024.png \
        -resize "''${size}x''${size}" "icon.iconset/icon_''${size}x''${size}.png"
      doubled=$((size * 2))
      ${lib.getExe imagemagick} ${src}/assets/prod/black-macos-1024.png \
        -resize "''${doubled}x''${doubled}" "icon.iconset/icon_''${size}x''${size}@2x.png"
    done
    /usr/bin/iconutil -c icns icon.iconset -o "$app/Contents/Resources/icon.icns"

    python3 - "$app/Contents/Info.plist" '${runtime.version}' <<'PY'
    import plistlib
    import sys

    path, version = sys.argv[1:]
    with open(path, "rb") as file:
        info = plistlib.load(file)
    info.update({
        "CFBundleIdentifier": "com.t3tools.T3Code",
        "CFBundleName": "T3 Code",
        "CFBundleDisplayName": "T3 Code",
        "CFBundleExecutable": "Electron",
        "CFBundleIconFile": "icon.icns",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "LSEnvironment": {"T3CODE_DISABLE_AUTO_UPDATE": "1"},
        "NSScreenCaptureUsageDescription": "T3 Code captures the active window when you use the snapshot shortcut.",
        "NSDocumentsFolderUsageDescription": "T3 Code reads project files you open in the desktop app.",
        "CFBundleURLTypes": [{
            "CFBundleURLName": "T3 Code",
            "CFBundleURLSchemes": ["t3code", "t3code-dev"],
        }],
    })
    with open(path, "wb") as file:
        plistlib.dump(info, file)
    PY

    makeWrapper "$app/Contents/MacOS/Electron" "$out/bin/t3code" \
      --set T3CODE_DISABLE_AUTO_UPDATE 1 \
      --run 'export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/''${USER:-$(id -un)}/bin:$PATH"'
    runHook postInstall
  '';

  # Fixup rewrites executable script shebangs inside the sealed resources.
  postFixup = ''
    /usr/bin/codesign \
      --force \
      --deep \
      --options runtime \
      --entitlements ${./desktop-darwin-entitlements.plist} \
      --sign - \
      "$out/Applications/T3 Code.app"
  '';

  meta = {
    description = "T3 Code Electron desktop application";
    homepage = "https://github.com/tarik02-org/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3code";
    platforms = [ "aarch64-darwin" ];
  };
}
