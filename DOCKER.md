# WCO-DL Docker Setup

This guide covers running WCO-DL with Docker Compose, which includes:
- **WCO-DL app** (NestJS + Python downloader)
- **Byparr** (Cloudflare bypass service)

## Features

- **Modern Web UI**: Browse and download from any content type (Dubbed, Subbed, Cartoons, Movies, OVAs)
- **Dark/Light Theme**: Toggle between themes, preference saved locally
- **Download Tracking**: Monitor download progress and status
- **Search**: Real-time search with highlighting
- **Responsive Design**: Works on desktop and mobile
- **Sonarr Integration**: Automatic library imports after download

## Prerequisites

- Docker and Docker Compose installed
- At least 2GB RAM available for Byparr's browser
- (Optional) Sonarr for automatic library imports

## Quick Start

1. **Say where downloads go.** Next to `docker-compose.yml`, make a file called `.env` (or copy `.env.example`)
   and set a folder on this machine that Sonarr can also see:
   ```bash
   DOWNLOADS_DIR=/path/to/downloads/wco-dl
   ```

2. **Start the services.** This fetches the ready-made image `ghcr.io/ozzymousprime/wco-dl:latest`:
   ```bash
   docker compose up -d
   ```

3. **Open http://localhost:3000/map.html.** The first visit shows the setup page. Paste Sonarr's address and API
   key there: it tests the connection, checks that Sonarr can see the download folder (by writing a small file
   and asking Sonarr to find it), and checks the Cloudflare helper. The same page is Settings afterwards.
   - Without Sonarr, the original downloader page at http://localhost:3000 still works
   - Swagger API docs: http://localhost:3000/api

To build from source instead of using the image, replace the `image:` line under `app:` in `docker-compose.yml`
with `build: .` and run `docker compose up -d --build`.

## Environment Variables

### Required

None. Sonarr's address and key, and where Sonarr sees the download folder, are set on the Settings page, and what
is saved there wins over `.env`. They are kept in `connections.json` in the config volume.

### Folders

- `DOWNLOADS_DIR`: The folder on this machine where downloads are saved (Docker Compose only; default: a Docker volume)
- `OUTPUT_BASE`: The same folder as the container sees it (default: `/data/downloads`). Rarely needs changing
- `ADMIN_PASSWORD`: Locks the Settings page (default: unset; can also be set on the page)

### Optional

**Application:**
- `NODE_ENV`: `production` or `development` (default: `production`)
- `SERVER_PORT`: Web interface port (default: `3000`)
- `BYPARR_PORT`: Byparr external port (default: `8191`)
- `CORS_ORIGIN`: Allowed origin for CORS (default: `http://localhost:3000`)

**File Permissions (Production):**
- `PUID`: User ID for downloaded files (default: `1000`)
- `PGID`: Group ID for downloaded files (default: `1000`)

**Sonarr Integration:**
- `SONARR_URL`: Sonarr URL (e.g., `http://sonarr:8989`)
- `SONARR_API_KEY`: Your Sonarr API key

**Byparr Proxy (Optional):**
- `PROXY_SERVER`: Proxy URL (e.g., `http://proxy:8080`)
- `PROXY_USERNAME`: Proxy username
- `PROXY_PASSWORD`: Proxy password
- `BROWSER_LOCALE`: Browser locale (default: `en-US`)
- `BROWSER_TIMEZONE`: Browser timezone (default: `UTC`)

**Advanced:**
- `PYTHON_BIN`: Python binary path (default: `python`)
- `BYPARR_MAX_TIMEOUT_MS`: Byparr request timeout (default: `60000`)
- `DOWNLOAD_IDLE_TIMEOUT_MS`: Download idle timeout (default: `210000`)
- `MAX_PARALLEL_DOWNLOADS`: Browse-page downloads that run at once; the rest wait (default: `3`, at most `20`)

**Webhooks:**
- `WEBHOOK_URLS`: Comma-separated webhook URLs registered at startup
- `WEBHOOK_ALLOW_INTERNAL`: Set to `true` to allow webhooks to loopback, link-local and private LAN addresses, which are blocked by default (default: `false`)

## Usage Examples

### Basic Setup (No Sonarr)

```bash
# .env
NODE_ENV=production
OUTPUT_BASE=/mnt/media/downloads
```

### With Sonarr Integration

```bash
# .env
NODE_ENV=production
OUTPUT_BASE=/mnt/media/downloads
SONARR_URL=http://192.168.1.100:8989
SONARR_API_KEY=your-sonarr-api-key
```

### With Proxy

```bash
# .env
NODE_ENV=production
OUTPUT_BASE=/mnt/media/downloads
PROXY_SERVER=http://proxy.example.com:8080
PROXY_USERNAME=user
PROXY_PASSWORD=pass
BROWSER_LOCALE=en-US
BROWSER_TIMEZONE=America/New_York
```

## Accessing the Services

Once running:

- **Web Interface:** http://localhost:3000
- **API Docs (Swagger):** http://localhost:3000/api
- **Byparr API:** http://localhost:8191

### Web Interface Features

- **Content Type Tabs**: Switch between Dubbed Anime, Subbed Anime, Cartoons, Movies, and OVAs
- **Search**: Type to filter results in real-time with match highlighting
- **Download Options**:
  - Download all episodes
  - Download latest episode only
  - Download specific season/episode range
- **Dark/Light Theme**: Click the moon/sun icon to toggle
- **Responsive Design**: Works on desktop, tablet, and mobile

## Managing the Services

```bash
# View logs
docker-compose logs -f app
docker-compose logs -f byparr

# Restart services
docker-compose restart

# Stop services
docker-compose down

# Update to latest images
docker-compose pull
docker-compose up -d --build

# View running containers
docker-compose ps
```

## Volume Mounts

- `downloads`: Downloaded anime/cartoon files
- `config`: Settings and database files
- `byparr_cache`: Byparr browser cache (for performance)

## API Endpoints

### Content Lists
- `GET /get-all-dubbed-anime-names` - List all dubbed anime
- `GET /get-all-subbed-anime-names` - List all subbed anime
- `GET /get-all-cartoon-names` - List all cartoons
- `GET /get-all-movie-names` - List all movies
- `GET /get-all-ova-names` - List all OVAs

### Downloads
- `POST /download-anime` - Start downloading a show
  ```json
  {
    "name": "anime-slug",
    "season": 1,
    "episode": "1-10",
    "newest": false
  }
  ```
- `POST /download-single-episode` - Download a single episode
  ```json
  {
    "name": "anime-slug-episode-1-english-dubbed"
  }
  ```
- `POST /process-anime` - Trigger Sonarr import
  ```json
  {
    "name": "anime-slug"
  }
  ```

### Download Tracking
- `GET /downloads` - List all download jobs
- `GET /downloads/:id` - Get status of a specific download

## Troubleshooting

### Byparr fails to start

Byparr needs at least 1GB of shared memory. If you see errors:

```yaml
# In docker-compose.yml, under byparr:
shm_size: "1gb"
```

### Downloads not appearing in Sonarr

1. Open Settings (the cog in the header) and press "Test again": it tests Sonarr and whether Sonarr can see the download folder
2. If the folder line fails, `DOWNLOADS_DIR` must be a folder Sonarr can reach too; then say on that page where Sonarr sees it
3. Check app logs: `docker-compose logs app`

### Can't access web interface

1. Verify the container is running: `docker-compose ps`
2. Check logs: `docker-compose logs app`
3. Ensure port 3000 isn't in use by another service

### Byparr getting blocked by Cloudflare

Some sites aggressively block datacenter IPs. Consider:

1. Using a residential proxy (set `PROXY_SERVER` in `.env`)
2. Adjusting `BROWSER_LOCALE` and `BROWSER_TIMEZONE` to match your location

### Download timeouts

If downloads are timing out:

1. Increase `DOWNLOAD_IDLE_TIMEOUT_MS` in `.env`
2. Check network connectivity to the download servers
3. Verify Byparr is working correctly

## Development Setup

To run in development mode with hot reloading:

```bash
# Clone and setup
git clone <repo-url>
cd wco-dl

# Install dependencies
cd server && yarn install && cd ..
pip install -r requirements.txt

# Copy env and edit
cp .env.example .env

# Run with Docker Compose in dev mode
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Note: The dev compose file mounts source code as volumes for live editing.

## Updating

When new versions are available:

```bash
# Pull latest images
docker-compose pull

# Rebuild and restart
docker-compose up -d --build
```

## Architecture

```
┌─────────────────┐
│   Web Browser   │
└────────┬────────┘
         │ HTTP
         ▼
┌─────────────────┐      ┌─────────────┐
│  NestJS Server  │──────│  Byparr     │
│  (Node.js)      │      │  (CF Bypass)│
└────────┬────────┘      └─────────────┘
         │ spawns
         ▼
┌─────────────────┐
│  Python Script  │
│  (Downloader)   │
└────────┬────────┘
         │ downloads
         ▼
┌─────────────────┐
│  wcostream.tv   │
└─────────────────┘
```

## Support

- GitHub Issues: https://github.com/Maximillion195/wco-dl/issues
- Byparr Issues: https://github.com/ThePhaseless/Byparr/issues
