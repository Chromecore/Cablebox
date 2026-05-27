# CableBox — Standalone PC Setup Guide

A dedicated TV computer running CableBox + Jellyfin. When the PC turns on it boots straight into the cable box app — no login screen, no desktop.

---

## What You Need

- A PC connected to your TV via HDMI
- An external or internal drive with your media files
- Internet connection

---

## 1. Install the OS

This guide works on **Ubuntu** or **Linux Mint** — pick either.

- Ubuntu 22.04 / 24.04 LTS — ubuntu.com
- Linux Mint 21 / 22 — linuxmint.com

During install: choose **minimal installation** and create a user account (e.g. `tv`).

After install, open a terminal and run:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git
```

---

## 2. Run the Setup Script

Download and run the setup script — it will clone CableBox and walk through the full setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Chromecore/CableBox/main/setup/setup.py -o ~/cablebox_setup.py
python3 ~/cablebox_setup.py
```

The script handles everything — packages, Docker, auto-login, Jellyfin, CableBox, kiosk, and optional Openbox fast-boot. It pauses twice for browser steps detailed below.

---

## 3. Jellyfin Setup Wizard

When the script pauses, open **http://localhost:8096** in a browser.

1. Click **Get Started**
2. Create an admin account — remember this password
3. Add your media libraries — for each one:
   - Content type: **TV Shows** or **Movies**
   - Folder: `/media/Shows` or `/media/Movies` (wherever your drive is mounted)
   - Click the green checkmark, then **OK**
4. Click through the remaining wizard steps and **Finish**
5. Log in with the account you just created
6. Go to **Dashboard → API Keys → +**, name it `CableBox`, click **OK**, and **copy the key**

> **Media file naming:** Jellyfin expects standard naming:
> ```
> /media/Shows/Breaking Bad/Season 01/Breaking Bad S01E01.mkv
> /media/Movies/The Godfather (1972)/The Godfather.mkv
> ```

> **Transcoding:** Go to Dashboard → Playback → Transcoding. The FFmpeg path should be auto-detected. If you have an Intel/AMD/NVIDIA GPU you can enable hardware acceleration — otherwise leave it as None.

---

## 4. CableBox First-Run Config

When the script pauses, open **http://localhost:8080** in a browser.

1. **Server URL**: `http://localhost:8096`
2. **Public URL**: leave blank
3. **API Key**: paste the key from Jellyfin
4. Click **Test Connection** — should say "Connected!"
5. Click **Save & Launch CableBox**

---

## 5. Remote Control

You need a way to control the app without a keyboard and mouse at the TV.

**Option A — Flirc USB Dongle ($22) — Recommended**

Maps your existing TV remote to keyboard keys. Plug in the dongle, use the Flirc app to set these mappings:

| Remote Button | Map to Key |
|--------------|-----------|
| Up | ↑ Arrow |
| Down | ↓ Arrow |
| Left | ← Arrow |
| Right | → Arrow |
| OK / Select | Enter |
| Back | Escape |
| Guide / Menu | G |
| Number keys | 0–9 |
| Info / Color | * (admin) |

Download: https://flirc.tv/downloads

**Option B — USB Wireless Keyboard Remote**

Any wireless keyboard with a USB dongle works plug-and-play. Many options under $25 on Amazon.

**Option C — Xbox / PS Controller**

```bash
sudo apt install antimicrox
```

Use antimicrox to map controller buttons to keyboard keys.

---

## Controls Reference

| Key | Action |
|-----|--------|
| ↑ / ↓ | Channel up / down |
| 0–9 | Direct channel number entry |
| G or F1 | Open TV Guide overlay |
| Arrow keys (in guide) | Navigate |
| Enter | Select / watch |
| Esc | Close overlay / go back |
| * | Open admin PIN entry |
| Alt+F4 | Exit kiosk |
| Ctrl+Alt+D | Switch to full desktop |
| Ctrl+Alt+T | Open terminal |
| Ctrl+Alt+F2 | Text console fallback |

---

## Scheduling Shows

1. Press `*` to open admin mode (default PIN: **1234**)
2. Go to **Scheduler** tab
3. Browse shows on the right — expand to see seasons and episodes
4. Drag episodes onto the schedule grid
5. Click a block to edit start time, duration, or set it to repeat weekly
6. Go to **Channels** tab to rename channels and add logos

---

## Updating CableBox

```bash
cd ~/cablebox && git pull
docker build -t cablebox:latest ~/cablebox
docker compose -f ~/cablebox/setup/standalone-compose.yml up -d --force-recreate cablebox
```

Jellyfin does not need to be restarted.

---

## Troubleshooting

**"pull access denied for cablebox" when running docker compose**
The image hasn't been built yet. Run `docker build -t cablebox:latest ~/cablebox` first.

**Blank screen or "connection refused" after kiosk launches**
The containers may still be starting. Wait 15 seconds and refresh. Check with `docker ps`.

**"Connection refused" on the CableBox first-run page**
Jellyfin takes 15–30 seconds to fully start. Wait and try again.

**Screen goes black after a while**
The `xset` commands in the autostart handle this. If it still happens:
```bash
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout 0
```

**How to exit kiosk and get back to the desktop**
- `Ctrl+Alt+D` — switches to the full Cinnamon/GNOME desktop
- `Alt+F4` — closes Firefox and returns to the bare Openbox desktop
- `Ctrl+Alt+T` — opens a terminal without closing Firefox
- `Ctrl+Alt+F2` — switch to a text console, then `pkill firefox` and `Ctrl+Alt+F7` to return

**Media not showing in Jellyfin**
Dashboard → Libraries → three dots on your library → Scan. Wait for it to finish.
