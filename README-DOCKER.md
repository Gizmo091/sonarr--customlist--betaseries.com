# Docker Installation

## Quick Start

1. **Download the docker-compose.yml file**:
   ```bash
   curl -O https://raw.githubusercontent.com/Gizmo091/sonarr--customlist--betaseries.com/main/docker-compose.yml
   ```

2. **Create environment file**:
   ```bash
   curl -O https://raw.githubusercontent.com/Gizmo091/sonarr--customlist--betaseries.com/main/.env.docker
   cp .env.docker .env
   ```

3. **Edit the .env file** with your BetaSeries API key:
   ```bash
   nano .env
   ```
   
   Fill in:
   - `BETASERIES_API_KEY`: Get yours from [BetaSeries API](https://www.betaseries.com/api/)
   - `SESSION_SECRET`: Generate with `openssl rand -base64 32`

4. **Start the service**:
   ```bash
   docker-compose up -d
   ```

5. **Access the application**:
   - Open your browser to `http://localhost:3000`

## Commands

- **Start**: `docker-compose up -d`
- **Stop**: `docker-compose down`
- **View logs**: `docker-compose logs -f`
- **Update to latest release**: `docker-compose pull && docker-compose up -d`
- **Restart**: `docker-compose restart`

## Data Persistence

Configuration and cache data are stored in the `./data` directory on your host machine and persist between container restarts. This directory will be created automatically when the container starts.

## Updating

The container automatically downloads the latest release from GitHub on startup. To update:

```bash
docker-compose down
docker-compose up -d
```

## Troubleshooting

- **Check logs**: `docker-compose logs -f betaseries-sonarr`
- **Access container**: `docker-compose exec betaseries-sonarr sh`
- **Reset data**: `docker-compose down -v && docker-compose up -d`