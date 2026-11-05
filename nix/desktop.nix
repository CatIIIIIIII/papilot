{ lib, stdenv, makeWrapper, makeDesktopItem, copyDesktopItems, electron_45, nodejs_24, papilot }:
assert lib.versions.major electron_45.version == lib.versions.major (lib.importJSON ../package.json).devDependencies.electron;
stdenv.mkDerivation {
  pname = "papilot-desktop";
  inherit (papilot) version;
  dontUnpack = true;
  nativeBuildInputs = [ makeWrapper copyDesktopItems ];
  desktopItems = [ (makeDesktopItem {
    name = "papilot";
    desktopName = "Papilot";
    comment = "Write and review LaTeX papers";
    exec = "papilot-desktop";
    icon = "papilot";
    categories = [ "Office" "Education" ];
  }) ];
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/share/icons/hicolor/512x512/apps"
    cp ${../desktop/assets/icon.png} "$out/share/icons/hicolor/512x512/apps/papilot.png"
    makeWrapper ${electron_45}/bin/electron "$out/bin/papilot-desktop" \
      --add-flags ${papilot}/lib/node_modules/papilot/.desktop/app \
      --set PAPILOT_INSTALL_METHOD nix \
      --set PAPILOT_DESKTOP_ROOT ${papilot}/lib/node_modules/papilot \
      --set PAPILOT_DESKTOP_NODE ${nodejs_24}/bin/node \
      --prefix PATH : ${papilot.runtimePath}
    runHook postInstall
  '';
  meta = papilot.meta // { platforms = lib.platforms.linux; mainProgram = "papilot-desktop"; };
}
