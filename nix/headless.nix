{
  lib,
  makeBinaryWrapper,
  nodejs_24,
  runtime,
  stdenvNoCC,
}:

stdenvNoCC.mkDerivation {
  pname = "t3code-headless";
  inherit (runtime) version;
  dontUnpack = true;

  nativeBuildInputs = [ makeBinaryWrapper ];

  installPhase = ''
    runHook preInstall
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/t3" \
      --add-flags "${runtime}/libexec/t3code/apps/server/dist/bin.mjs"
    runHook postInstall
  '';

  meta = {
    description = "Headless T3 Code CLI and server";
    homepage = "https://github.com/tarik02-org/t3code";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = [ "x86_64-linux" ];
  };
}
