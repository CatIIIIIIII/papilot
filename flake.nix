{
  description = "Papilot: a local workspace for revising LaTeX papers with AI";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          papilot-cli = pkgs.callPackage ./nix/package.nix { };
          papilot-desktop = pkgs.callPackage ./nix/desktop.nix { papilot = papilot-cli; };
          papilot = if pkgs.stdenv.hostPlatform.isLinux then pkgs.symlinkJoin {
            name = "papilot-${papilot-cli.version}";
            paths = [ papilot-cli papilot-desktop ];
            meta = papilot-cli.meta;
          } else papilot-cli;
        in
        {
          inherit papilot papilot-cli;
          default = papilot;
        } // (pkgsFor system).lib.optionalAttrs (pkgsFor system).stdenv.hostPlatform.isLinux { inherit papilot-desktop; }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              git
              which
              texliveFull
              nixfmt
            ];

            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

            # Vite's native npm modules need libstdc++ on NixOS.
            shellHook = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export LD_LIBRARY_PATH="${
                pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
              }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            '';
          };
        }
      );

      checks = forAllSystems (system: {
        package = self.packages.${system}.papilot;
      });

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
