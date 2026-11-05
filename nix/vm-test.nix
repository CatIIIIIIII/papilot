{ pkgs, papilot }:
pkgs.testers.runNixOSTest {
  name = "papilot-desktop";
  nodes.machine = { ... }: {
    services.xserver.enable = true;
    services.xserver.desktopManager.xfce.enable = true;
    services.displayManager.autoLogin = { enable = true; user = "alice"; };
    users.users.alice = { isNormalUser = true; password = ""; };
    environment.systemPackages = [ papilot pkgs.xdotool pkgs.curl pkgs.sqlite pkgs.python3 ];
    virtualisation = { memorySize = 4096; cores = 2; diskSize = 16384; };
    system.stateVersion = "26.05";
  };
  testScript = ''
    import json
    machine.wait_for_x()
    machine.wait_for_unit("graphical.target")
    machine.succeed("su - alice -c 'env -i HOME=/home/alice DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/1000 PATH=/empty PAPILOT_UPDATE_PROBE=1 PAPILOT_DESKTOP_DATA=/home/alice/papilot ${papilot}/bin/papilot-desktop > /home/alice/desktop.log 2>&1 &' ")
    machine.wait_until_succeeds("su - alice -c 'DISPLAY=:0 xdotool search --onlyvisible --name Papilot'")
    machine.wait_for_file("/home/alice/papilot/desktop-port.json")
    port = json.loads(machine.succeed("cat /home/alice/papilot/desktop-port.json"))
    machine.wait_until_succeeds(f"curl --fail http://127.0.0.1:{port}/api/health")
    status = json.loads(machine.succeed(f"curl -s http://127.0.0.1:{port}/api/updates"))
    assert status["packageManager"] == "nix" and status["canUpdate"] is False
    machine.succeed("su - alice -c 'sqlite3 /home/alice/papilot/papilot.sqlite \"PRAGMA integrity_check;\"' | grep -x ok")
    machine.succeed("su - alice -c 'test -w /home/alice/papilot/example-paper/main.tex'")
    machine.fail("su - alice -c 'touch ${papilot}/forbidden'")
    # Compile real source, not the bundled preview; latexmk also creates SyncTeX.
    machine.succeed("su - alice -c 'cd /home/alice/papilot/example-paper && ${pkgs.texliveFull}/bin/latexmk -pdf -interaction=nonstopmode -halt-on-error -synctex=1 main.tex'", timeout=180)
    machine.succeed("test -s /home/alice/papilot/example-paper/main.pdf && test -s /home/alice/papilot/example-paper/main.synctex.gz")
    machine.succeed("su - alice -c 'env -i HOME=/home/alice PATH=/empty ${papilot}/bin/papilot --version'")
    machine.screenshot("papilot-desktop")
  '';
}
