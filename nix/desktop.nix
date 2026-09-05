{
  coreutils,
  electron_41,
  imagemagick,
  lib,
  runtime,
  src,
  stdenvNoCC,
  xdg-utils,
}:

stdenvNoCC.mkDerivation {
  pname = "t3code-desktop";
  inherit (runtime) version;
  dontUnpack = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/share/applications" "$out/share/icons/hicolor/512x512/apps"

    cat > "$out/share/applications/t3code-url-handler.desktop" <<EOF
    [Desktop Entry]
    Name=T3 Code URL Handler
    Exec=$out/bin/t3code %U
    Terminal=false
    Type=Application
    NoDisplay=true
    StartupNotify=false
    MimeType=x-scheme-handler/t3code;x-scheme-handler/t3code-dev;
    EOF

    cat > "$out/bin/t3code" <<'EOF'
    #!/bin/sh
    applications_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    handler_name=t3code-url-handler.desktop
    handler_source=${placeholder "out"}/share/applications/$handler_name
    handler_target="$applications_dir/$handler_name"

    if ${lib.getExe' coreutils "mkdir"} -p "$applications_dir" &&
       ${lib.getExe' coreutils "install"} -m 0644 "$handler_source" "$handler_target"; then
      ${lib.getExe' xdg-utils "xdg-mime"} default "$handler_name" x-scheme-handler/t3code \
        >/dev/null 2>&1 || true
      ${lib.getExe' xdg-utils "xdg-mime"} default "$handler_name" x-scheme-handler/t3code-dev \
        >/dev/null 2>&1 || true
    fi

    profile_user="''${USER:-$(${lib.getExe' coreutils "id"} -un)}"
    export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$profile_user/bin:$PATH"
    export T3CODE_DISABLE_AUTO_UPDATE=1
    exec ${lib.getExe electron_41} \
      --ozone-platform-hint=auto \
      --enable-features=WaylandWindowDecorations \
      ${runtime}/libexec/t3code \
      "$@"
    EOF
    chmod 755 "$out/bin/t3code"

    ${imagemagick}/bin/magick \
      ${src}/assets/prod/black-universal-1024.png \
      -resize 512x512 \
      "$out/share/icons/hicolor/512x512/apps/t3code.png"

    cat > "$out/share/applications/t3code.desktop" <<EOF
    [Desktop Entry]
    Name=T3 Code
    Comment=Run coding agents from a desktop application
    Exec=$out/bin/t3code %U
    Icon=t3code
    Terminal=false
    Type=Application
    Categories=Development;
    StartupWMClass=t3code
    MimeType=x-scheme-handler/t3code;x-scheme-handler/t3code-dev;
    EOF

    runHook postInstall
  '';

  meta = {
    description = "T3 Code Electron desktop application";
    homepage = "https://github.com/tarik02-org/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3code";
    platforms = [ "x86_64-linux" ];
  };
}
