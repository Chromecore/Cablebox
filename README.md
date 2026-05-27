# CableBox

A custom cable TV experience built on top of Jellyfin. Schedule TV shows across any number of channels and watch them as live TV — tune in late and you're already mid-episode, just like a real cable box.

## Features

- **Live TV simulation** — content plays at the correct position based on when it was scheduled, not from the beginning
- **Dynamic channels** — add, delete, and reorder channels; starts with 50 pre-populated on first run
- **Drag-and-drop scheduler** — drag shows, seasons, or individual episodes from the Jellyfin library onto a channel × time grid; resize and move blocks by dragging
- **Two play modes** — shuffle (FNV-seeded deterministic order) or in-order (sequential from episode 1)
- **Season-level scheduling** — drag an entire season as its own shuffle or in-order block
- **Recurring blocks** — mark a block to repeat on selected days of the week
- **TV Guide overlay** — full EPG grid with live-now highlights, episode thumbnails, and keyboard navigation
- **Cable ↔ Streaming toggle** — press `S` to jump to the Jellyfin web interface; browser Back returns to the cable view
- **Skipped-episode warnings** — hover the ⚠ icon on a block to see which episodes are too long to fit the slot
- **PIN-protected admin** — viewer mode is locked; admin is accessed via a configurable PIN
- **Kiosk-ready** — designed for keyboard/remote operation with no mouse required

---

## Keyboard Shortcuts

### Viewer Mode

| Key | Action |
|-----|--------|
| `↑` | Channel up |
| `↓` | Channel down |
| `0`–`9` | Direct channel entry — type one digit and wait 1.5 s, or type two digits to tune immediately |
| `G` or `F1` | Open TV Guide |
| `S` | Open Streaming prompt → navigate to Jellyfin |
| `*` | Open PIN entry → Admin mode |
| `Esc` / `Backspace` | Clear pending input / close overlays |

> **First launch:** if the browser hasn't interacted with the page before, video autoplay may be blocked. A "Press any key to start" prompt appears at the bottom of the screen — pressing any key or clicking will begin playback.

### TV Guide Overlay

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus up/down through channels |
| `←` / `→` | Scroll the time window backward/forward (30-min increments) |
| `Enter` | Tune to the focused channel and close guide |
| `Esc` / `Backspace` / `G` / `F1` | Close guide |

- The purple vertical line marks the current time.
- Blocks airing right now have a green tint and a **LIVE** badge.
- Episode thumbnails, season/episode numbers, and duration are shown on each block.

### Admin Mode

Access by pressing `*` in viewer mode and entering the PIN (default: `1234`).

| Tab | Description |
|-----|-------------|
| **Scheduler** | Drag blocks onto the channel × time grid. Drag the body to move (including cross-channel). Drag either edge to resize in 10-min snaps. Hover a block for a delete button, or click it to edit recurrence. |
| **Library** | Browse Jellyfin shows → seasons → episodes. Each show and season row has two drag chips: 🔀 **Shuffle** and ↕ **In order**. Individual episodes can also be dragged directly. |
| **Channels** | Add, delete, and reorder channels with ↕ arrows. Edit name and upload a logo image for each channel. |
| **Settings** | Update Jellyfin connection details and change the admin PIN. |

---

## Architecture

```
Browser → Traefik → CableBox (Go + React)
                          ↓
                    Jellyfin (media API + streaming)
                          ↓
                    SQLite (schedule, channels, config)
```

- **Backend**: Go + chi, SQLite via modernc/sqlite
- **Frontend**: React + Vite + Tailwind CSS
- **Media**: Jellyfin HTTP API — shows/episodes metadata, PlaybackInfo API for stream URLs with `StartTimeTicks`
- **Auth**: Traefik ForwardAuth (`/_auth/exchange` for cookie handoff from the auth service)

### Live Position Calculation

When you tune to a channel, the backend:

1. Queries the schedule to find which block is airing now
2. Calls Jellyfin's `POST /Items/{id}/PlaybackInfo` with a device profile that forces transcoding — this creates a session that honours `StartTimeTicks`
3. Returns the `TranscodingUrl` with `StartTimeTicks = (now − block.startTime) × 10 000 000`

The stream URL is refreshed every 30 seconds so position drift stays under 30 s.

### Play Modes

| Type | Behaviour |
|------|-----------|
| `episode` | A single specific episode, plays from `StartTimeTicks` |
| `random` | FNV-seeded deterministic shuffle over the show (or a single season). Seed is `blockId + date`, so the same block plays the same episodes each day |
| `sequential` | Episodes played in list order starting from episode 1, cycling continuously |
| `empty` | No video — shows a static image or animated noise |

### Two Jellyfin URLs

| Variable | Purpose |
|----------|---------|
| `JELLYFIN_URL` | Internal Docker hostname (`http://jellyfin:8096`) — server→Jellyfin API calls |
| `JELLYFIN_PUBLIC_URL` | Browser-accessible URL (`https://jellyfin.internal`) — image thumbnails and stream URLs sent to the browser |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen address |
| `DATA_DIR` | `/app/data` | SQLite database and uploaded logo images |
| `FRONTEND_DIR` | `/app/frontend/dist` | Built frontend static files |
| `JELLYFIN_URL` | — | Internal Jellyfin URL for API calls |
| `JELLYFIN_PUBLIC_URL` | `https://jellyfin.internal` | Public Jellyfin URL for browser resources |
| `JELLYFIN_API_KEY` | — | Jellyfin API key |

---

## Deployment (Home Server)

### Build

```bash
docker build -t cablebox:latest /opt/cablebox
```

### Deploy

Portainer → Stacks → `cablebox` → Recreate

### Infrastructure

- **DNS**: `cablebox.internal` → server IP (Pi-hole `dns.hosts`)
- **Traefik**: `/opt/traefik/dynamic/cablebox.yml` → `http://cablebox:8080`
- **TLS**: Covered by `*.internal` wildcard cert (SAN `cablebox.internal` in `wildcard.conf`)
- **Auth**: Traefik ForwardAuth middleware (`auth-forward`)

### First Run

On startup the server:
1. Creates `/app/data/cablebox.db` if it doesn't exist
2. Pre-populates channels 1–50
3. Sets the default admin PIN to `1234` (SHA256 stored in DB)
4. Seeds Jellyfin connection details from environment variables

---

## Standalone Setup (separate PC / TV box)

For a PC connected to a TV via HDMI running Ubuntu Desktop:

### Jellyfin

```yaml
# ~/jellyfin/docker-compose.yml
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: always
    network_mode: host
    volumes:
      - ~/jellyfin/config:/config
      - ~/jellyfin/cache:/cache
      - /media:/media:ro
```

Access at `http://localhost:8096` for initial setup and to generate an API key.

### CableBox

```yaml
# ~/cablebox/docker-compose.yml
services:
  cablebox:
    image: cablebox:latest
    restart: always
    network_mode: host
    volumes:
      - ~/cablebox/data:/app/data
    environment:
      - PORT=8080
      - JELLYFIN_URL=http://localhost:8096
      - JELLYFIN_PUBLIC_URL=http://localhost:8096
      - JELLYFIN_API_KEY=your_api_key_here
```

### Kiosk Auto-Start (Ubuntu Desktop)

```ini
# ~/.config/autostart/cablebox.desktop
[Desktop Entry]
Type=Application
Name=Cable Box
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --app=http://localhost:8080
X-GNOME-Autostart-enabled=true
```

On first boot in kiosk mode, press any key or click anywhere once to unlock browser autoplay — this only happens the very first time.

### Remote Control Options

| Option | Notes |
|--------|-------|
| **Flirc USB dongle** (~$22) | Maps any IR remote to keyboard keys — recommended |
| **USB wireless keyboard remote** | Plug-and-play, no setup required |
| **Android phone** | "USB Keyboard" app over USB cable |

---

## Changing the Admin PIN

Admin → Settings → enter new PIN → Save. The PIN is stored as a SHA256 hash and never transmitted in plain text.

Default PIN: `1234`
