#!/usr/bin/env python3
"""
CableBox full setup — run this after installing the OS and copying
CableBox files to ~/cablebox/.

Usage: python3 ~/cablebox/setup/setup.py
"""
import os, re, sys, subprocess, time, shutil
from pathlib import Path

# ── colours ───────────────────────────────────────────────────────────
G = "\033[92m"; Y = "\033[93m"; R = "\033[91m"; C = "\033[96m"
BOLD = "\033[1m"; RESET = "\033[0m"

def ok(msg):    print(f"  {G}✓{RESET} {msg}")
def info(msg):  print(f"  {C}·{RESET} {msg}")
def warn(msg):  print(f"  {Y}⚠{RESET} {msg}")
def fatal(msg): print(f"\n  {R}✗ {msg}{RESET}"); sys.exit(1)

def header(n, title):
    print(f"\n{BOLD}{'━'*58}{RESET}")
    print(f"{BOLD}  Step {n}: {title}{RESET}")
    print(f"{BOLD}{'━'*58}{RESET}")

def pause(msg):
    print(f"\n  {Y}{'─'*54}{RESET}")
    print(f"  {Y}{BOLD}ACTION REQUIRED:{RESET}")
    for line in msg.strip().split('\n'):
        print(f"  {line}")
    try:
        input(f"\n  {BOLD}Press Enter when done › {RESET}")
    except (EOFError, KeyboardInterrupt):
        print(); sys.exit(0)
    print(f"  {Y}{'─'*54}{RESET}")

def ask(q, default='y'):
    yn = f"{BOLD}Y{RESET}/n" if default == 'y' else f"y/{BOLD}N{RESET}"
    try:
        ans = input(f"\n  {BOLD}{q}{RESET} [{yn}] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print(); sys.exit(0)
    return (ans or default)[0] == 'y'

def prompt(q, default=''):
    suf = f" [{default}]" if default else ""
    try:
        return input(f"  {q}{suf}: ").strip() or default
    except (EOFError, KeyboardInterrupt):
        print(); sys.exit(0)

# ── command helpers ───────────────────────────────────────────────────
def run(cmd, check=True, capture=False, quiet=False):
    kw = dict(shell=True)
    if capture:
        kw.update(capture_output=True, text=True)
    elif quiet:
        kw.update(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = subprocess.run(cmd, **kw)
    if check and r.returncode != 0:
        fatal(f"Command failed (exit {r.returncode}):\n    {cmd}")
    return r

def ok_run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True).returncode == 0

def sudo(cmd, **kw):
    return run(f"sudo {cmd}", **kw)

def sudo_write(path, content):
    tmp = f"/tmp/_cablebox_setup_{os.getpid()}.tmp"
    Path(tmp).write_text(content)
    sudo(f"cp {tmp} {path}")
    sudo(f"chmod 644 {path}")
    Path(tmp).unlink(missing_ok=True)

# ── environment ───────────────────────────────────────────────────────
REPO_URL = 'https://github.com/Chromecore/Cablebox.git'

USER = os.environ.get('USER') or run('whoami', capture=True).stdout.strip()
HOME = Path.home()
CBOX = HOME / 'cablebox'
COMP = str(CBOX / 'setup/standalone-compose.yml')

def get_dm():
    if Path('/etc/gdm3/custom.conf').exists():        return 'gdm3'
    if ok_run('systemctl is-active --quiet gdm'):     return 'gdm3'
    if Path('/etc/lightdm/lightdm.conf').exists():    return 'lightdm'
    if ok_run('systemctl is-active --quiet lightdm'): return 'lightdm'
    return None

def get_de():
    de = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
    if 'cinnamon' in de: return 'cinnamon'
    if 'gnome' in de:    return 'gnome'
    if ok_run('which cinnamon-session'): return 'cinnamon'
    return 'gnome'

# ═══════════════════════════════════════════════════════════════════════
# STEPS
# ═══════════════════════════════════════════════════════════════════════

def s0_clone():
    header(0, "Get CableBox")
    if (CBOX / '.git').exists():
        info("CableBox already cloned — pulling latest...")
        run(f"git -C {CBOX} pull")
        ok("Up to date")
    elif CBOX.exists():
        warn(f"{CBOX} exists but is not a git repo — skipping clone")
    else:
        info(f"Cloning from {REPO_URL}...")
        run(f"git clone {REPO_URL} {CBOX}")
        ok(f"Cloned to {CBOX}")


def s1_packages():
    header(1, "Install packages")
    info("Updating and upgrading packages...")
    sudo("apt-get update -qq")
    sudo("DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq")
    sudo("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git firefox xterm")
    ok("curl, git, firefox installed")


def s2_autologin(dm):
    header(2, "Configure auto-login")
    if dm == 'gdm3':
        conf = Path('/etc/gdm3/custom.conf')
        text = sudo(f"cat {conf}", capture=True).stdout
        if 'AutomaticLoginEnable=true' in text:
            ok("GDM3 auto-login already configured"); return
        if '[daemon]' in text:
            text = re.sub(r'\[daemon\]',
                f'[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin={USER}',
                text, count=1)
        else:
            text += f'\n[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin={USER}\n'
        sudo_write(str(conf), text)
        ok(f"GDM3 auto-login set for {USER}")
    elif dm == 'lightdm':
        conf = Path('/etc/lightdm/lightdm.conf')
        text = sudo(f"cat {conf}", capture=True, check=False).stdout or ''
        if f'autologin-user={USER}' in text:
            ok("LightDM auto-login already configured"); return
        if '[SeatDefaults]' in text:
            text = re.sub(r'(\[SeatDefaults\]\s*\n)',
                fr'\1autologin-user={USER}\nautologin-user-timeout=0\n',
                text, count=1)
        else:
            text += f'\n[SeatDefaults]\nautologin-user={USER}\nautologin-user-timeout=0\n'
        sudo_write(str(conf), text)
        ok(f"LightDM auto-login set for {USER}")
    else:
        warn("Unknown display manager — configure auto-login manually (see SETUP.md Step 1)")


def s3_docker():
    header(3, "Install Docker")
    if ok_run('sudo docker info'):
        ok("Docker already installed")
    else:
        info("Downloading and installing Docker...")
        run("curl -fsSL https://get.docker.com | sh")
        ok("Docker installed")

    if 'docker' in run('groups', capture=True).stdout:
        ok("User already in docker group")
    else:
        sudo(f"usermod -aG docker {USER}")
        ok("Added user to docker group")
        warn("Group change takes effect after logout — using 'sudo docker' for this session")


def s4_build():
    header(4, "Build Docker image")
    if ok_run('sudo docker image inspect cablebox:latest') \
            and not ask("Image cablebox:latest already exists. Rebuild?", default='n'):
        ok("Using existing image"); return
    info("Building image (2–5 minutes on first run)...")
    run(f"sudo docker build -t cablebox:latest {CBOX}")
    ok("Image built: cablebox:latest")


def s5_media():
    header(5, "Mount media drive")
    info("Current block devices:")
    run("lsblk")
    drive_mounted = False
    if not ask("Set up media drive auto-mount now?"):
        mount = str(HOME / 'media')
    else:
        device = prompt("Device path (e.g. /dev/sdb1)")
        if not device:
            mount = str(HOME / 'media')
        else:
            mount = prompt("Mount point", default="/media")
            sudo(f"mkdir -p {mount}")
            r = sudo(f"mount {device} {mount}", check=False)
            if r.returncode != 0:
                warn("Mount failed — falling back to home directory")
                mount = str(HOME / 'media')
            else:
                drive_mounted = True
                r = run(f"sudo blkid -s UUID -o value {device}", capture=True, check=False)
                uuid = r.stdout.strip()
                if uuid:
                    fstab = Path('/etc/fstab').read_text()
                    if uuid not in fstab:
                        sudo(f"bash -c \"echo 'UUID={uuid} {mount} auto defaults,nofail 0 2' >> /etc/fstab\"")
                        ok(f"Added UUID={uuid} to /etc/fstab")
                    else:
                        ok("Drive already in /etc/fstab")
                else:
                    warn("Could not get UUID — add the mount to /etc/fstab manually")

    for folder in ['Movies', 'Shows', 'Videos']:
        path = Path(mount) / folder
        path.mkdir(parents=True, exist_ok=True)
        ok(f"{'Created' if not path.exists() else 'Using'} {path}")

    # Update compose file to point to the actual media location
    compose = Path(COMP)
    compose_text = compose.read_text()
    compose_text = re.sub(r'- .+:/media:ro', f'- {mount}:/media:ro', compose_text)
    compose.write_text(compose_text)
    ok(f"Compose media path set to {mount}")


def _wait_for(url, label, timeout=60):
    info(f"Waiting for {label}...")
    for _ in range(timeout):
        if ok_run(f"curl -sf {url}"):
            print(); return True
        print(".", end="", flush=True)
        time.sleep(1)
    print(); return False


def s6_jellyfin():
    header(6, "Start Jellyfin")
    (HOME / 'jellyfin/config').mkdir(parents=True, exist_ok=True)
    (HOME / 'jellyfin/cache').mkdir(parents=True, exist_ok=True)
    sudo(f"env HOME={HOME} docker compose -f {COMP} up -d jellyfin")

    if _wait_for("http://localhost:8096/health", "Jellyfin", timeout=60):
        ok("Jellyfin is up at http://localhost:8096")
    else:
        warn("Jellyfin hasn't responded yet — it may still be initialising")

    pause(
        "Open http://localhost:8096 in your browser and complete the setup wizard:\n\n"
        "1. Click Get Started\n"
        "2. Create an admin account (remember the password)\n"
        "3. Add your media libraries:\n"
        "     Content type: TV Shows or Movies\n"
        "     Folder: /media/Shows  or  /media/Movies\n"
        "4. Finish the wizard and log in\n"
        "5. Dashboard → API Keys → + → name it CableBox → copy the key\n\n"
        "Come back here with the API key."
    )


def s7_cablebox():
    header(7, "Start and configure CableBox")
    (CBOX / 'data').mkdir(parents=True, exist_ok=True)
    sudo(f"env HOME={HOME} docker compose -f {COMP} up -d cablebox")

    ready = _wait_for("http://localhost:8080/api/health", "CableBox", timeout=60)
    if ready:
        ok("CableBox is up at http://localhost:8080")
    else:
        warn("CableBox hasn't responded yet — it may still be starting")
        warn("Check container logs with: sudo docker logs cablebox")

    pause(
        "Open http://localhost:8080 in your browser.\n"
        "If you see a blank page, wait 10 seconds and refresh.\n\n"
        "1. Server URL:  http://localhost:8096\n"
        "2. Public URL:  (leave blank)\n"
        "3. API Key:     paste the key you copied from Jellyfin\n"
        "4. Click Test Connection — should say Connected!\n"
        "5. Click Save & Launch CableBox"
    )


def s8_kiosk():
    header(8, "Kiosk autostart")
    dst = HOME / '.config/autostart'
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copy(CBOX / 'setup/cablebox.desktop', dst / 'cablebox.desktop')
    ok(f"Copied cablebox.desktop → {dst}")


def s9_openbox():
    header(9, "Openbox (fast-boot window manager)")
    if not ask("Install Openbox for faster boot? (replaces the full Cinnamon/GNOME session)"):
        info("Skipping"); return

    sudo("apt-get install -y -qq openbox")

    ob = HOME / '.config/openbox'
    ob.mkdir(parents=True, exist_ok=True)

    (ob / 'autostart').write_text(
        "xset s off &\n"
        "xset -dpms &\n"
        "until curl -sf http://localhost:8080/api/health > /dev/null 2>&1; do sleep 1; done\n"
        "sleep 2\n"
        "firefox --kiosk http://localhost:8080\n"
    )
    (ob / 'autostart').chmod(0o755)
    ok("Created ~/.config/openbox/autostart")

    switch_cmd = "sudo /usr/local/bin/cablebox-desktop"

    (ob / 'rc.xml').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<openbox_config xmlns="http://openbox.org/3.4/rc">\n'
        '  <keyboard>\n'
        '    <keybind key="A-F4">\n'
        '      <action name="Close"/>\n'
        '    </keybind>\n'
        '    <keybind key="C-A-t">\n'
        '      <action name="Execute">\n'
        '        <command>x-terminal-emulator</command>\n'
        '      </action>\n'
        '    </keybind>\n'
        '    <keybind key="C-A-F2">\n'
        '      <action name="Execute">\n'
        "        <command>bash -c 'chvt 2'</command>\n"
        '      </action>\n'
        '    </keybind>\n'
        '    <keybind key="C-A-d">\n'
        '      <action name="Execute">\n'
        f"        <command>bash -c '{switch_cmd}'</command>\n"
        '      </action>\n'
        '    </keybind>\n'
        '    <keybind key="C-A-s">\n'
        '      <action name="Execute">\n'
        '        <command>systemctl poweroff</command>\n'
        '      </action>\n'
        '    </keybind>\n'
        '  </keyboard>\n'
        '</openbox_config>\n'
    )
    ok("Created ~/.config/openbox/rc.xml")

    sudo("mkdir -p /etc/lightdm/lightdm.conf.d")
    sudo_write("/etc/lightdm/lightdm.conf.d/50-cablebox.conf",
               "[SeatDefaults]\nautologin-session=openbox\n")
    ok("LightDM autologin session set to openbox")

    # Script to switch to Cinnamon desktop from kiosk
    sudo_write("/usr/local/bin/cablebox-desktop",
               "#!/bin/bash\n"
               "touch /run/cablebox-switching\n"
               "sed -i 's/autologin-session=openbox/autologin-session=cinnamon/' "
               "/etc/lightdm/lightdm.conf.d/50-cablebox.conf\n"
               "systemctl restart lightdm\n")
    sudo("chmod +x /usr/local/bin/cablebox-desktop")
    ok("Created /usr/local/bin/cablebox-desktop")

    # Cleanup script — LightDM runs this after every session ends.
    # The flag file tells it whether the session ended because we're switching to desktop
    # (skip restore) or because the user logged out of Cinnamon (restore openbox).
    sudo_write("/usr/local/bin/cablebox-session-cleanup",
               "#!/bin/bash\n"
               "if [ -f /run/cablebox-switching ]; then\n"
               "    rm /run/cablebox-switching\n"
               "    exit 0\n"
               "fi\n"
               "sed -i 's/autologin-session=cinnamon/autologin-session=openbox/' "
               "/etc/lightdm/lightdm.conf.d/50-cablebox.conf\n")
    sudo("chmod +x /usr/local/bin/cablebox-session-cleanup")
    ok("Created /usr/local/bin/cablebox-session-cleanup")

    # Register the cleanup script with LightDM
    sudo_write("/etc/lightdm/lightdm.conf.d/51-cablebox-cleanup.conf",
               "[SeatDefaults]\nsession-cleanup-script=/usr/local/bin/cablebox-session-cleanup\n")
    ok("LightDM session cleanup registered")

    # Update script — triggered by the systemd path unit watching the flag file
    update_script = (
        "#!/bin/bash\n"
        f"cd {HOME}/cablebox\n"
        "git pull\n"
        f"docker build -t cablebox:latest {HOME}/cablebox\n"
        f"env HOME={HOME} docker compose -f {HOME}/cablebox/setup/standalone-compose.yml up -d --force-recreate cablebox\n"
    )
    sudo_write("/usr/local/bin/cablebox-update", update_script)
    sudo("chmod +x /usr/local/bin/cablebox-update")
    ok("Created /usr/local/bin/cablebox-update")

    sudo_write("/etc/systemd/system/cablebox-update.service",
               "[Unit]\nDescription=CableBox Update\n\n"
               "[Service]\nType=oneshot\n"
               f"User={USER}\n"
               f"ExecStartPre=/bin/rm -f {HOME}/cablebox/data/.update_requested\n"
               "ExecStart=/usr/local/bin/cablebox-update\n")

    sudo_write("/etc/systemd/system/cablebox-update.path",
               "[Unit]\nDescription=CableBox Update Trigger\n\n"
               "[Path]\n"
               f"PathExists={HOME}/cablebox/data/.update_requested\n"
               "Unit=cablebox-update.service\n\n"
               "[Install]\nWantedBy=multi-user.target\n")

    sudo("systemctl daemon-reload")
    sudo("systemctl enable --now cablebox-update.path")
    ok("Update watcher enabled (systemd path unit)")

    # Allow running the desktop switch script without a password prompt
    sudoers = f"{USER} ALL=(ALL) NOPASSWD: /usr/local/bin/cablebox-desktop\n"
    sudo_write("/etc/sudoers.d/cablebox", sudoers)
    sudo("chmod 440 /etc/sudoers.d/cablebox")
    ok("Sudoers configured (no password needed for desktop switch)")


def s10_optimise():
    header(10, "Boot optimisations")
    if not ask("Apply boot optimisations? (black background, GRUB timeout, journal to RAM)"):
        info("Skipping"); return

    de = get_de()
    if de == 'cinnamon':
        run("gsettings set org.cinnamon.desktop.background picture-options 'none'", check=False)
        run("gsettings set org.cinnamon.desktop.background primary-color '#000000'", check=False)
    else:
        run("gsettings set org.gnome.desktop.background picture-uri ''", check=False)
        run("gsettings set org.gnome.desktop.background primary-color '#000000'", check=False)
    ok("Desktop background set to black")

    sudo("sed -i 's/GRUB_TIMEOUT=.*/GRUB_TIMEOUT=1/' /etc/default/grub")
    sudo("update-grub")
    ok("GRUB timeout → 1 second")

    sudo("mkdir -p /etc/systemd/journald.conf.d")
    sudo("bash -c \"printf '[Journal]\\nStorage=volatile\\n' > /etc/systemd/journald.conf.d/volatile.conf\"")
    ok("System journal moved to RAM")


# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

def main():
    print(f"\n{BOLD}CableBox Setup{RESET}\n")
    print(f"  User:         {USER}")
    print(f"  Home:         {HOME}")
    print(f"  CableBox dir: {CBOX}")

    if os.geteuid() == 0:
        fatal("Run as your normal user, not root. The script calls sudo internally.")

    dm = get_dm()
    print(f"  Display mgr:  {dm or 'unknown'}")

    run("sudo -v")

    if not ask("\nBegin setup?"):
        print("  Aborted."); sys.exit(0)

    s0_clone()
    s1_packages()
    s2_autologin(dm)
    s3_docker()
    s4_build()
    s5_media()
    s6_jellyfin()
    s7_cablebox()
    s8_kiosk()
    s9_openbox()
    s10_optimise()

    de = get_de()
    print(f"\n{BOLD}{'━'*58}{RESET}")
    print(f"{BOLD}  Setup complete!{RESET}")
    print(f"{BOLD}{'━'*58}{RESET}")
    print(f"""
  {G}{BOLD}All done.{RESET} Reboot to apply all changes:
    sudo reboot

  After reboot the PC boots straight into the CableBox TV viewer.

  Keyboard shortcuts (in kiosk):
    Alt+F4        close Firefox / exit kiosk
    Ctrl+Alt+D    switch to {de.title()} desktop
    Ctrl+Alt+T    open terminal
    Ctrl+Alt+F2   text console fallback
""")
    if ask("Reboot now?"):
        run("sudo reboot")


if __name__ == '__main__':
    main()
