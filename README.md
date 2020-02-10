# Devker

CLI to help manage docker-compose database containers for local development.

## Commands

```bash
devker help
devker env init
devker up
devker postgres restore
devker postgres dump
devker down
devker destroy
... etc
```

## Examples

### docker-compose.yml
```yaml
version: "3.7"
services:
  postgres:
    image: "postgres:12"
    container_name: "${COMPOSE_PROJECT_NAME:?}_postgres"
    ports:
      - "${APP_PSQL_PORT:-5432}:5432"
    environment:
      POSTGRES_DB: "${APP_PSQL_DB:-postgres}"
      POSTGRES_USER: "${APP_PSQL_USER:-postgres}"
      POSTGRES_PASSWORD: "${APP_PSQL_PASSWORD:-mypassword654321789}"
      # The following variables make it easier to use the psql cli inside the container
      PGHOST: "localhost"
      PGDATABASE: "${APP_PSQL_DB:-postgres}"
      PGUSER: "${APP_PSQL_USER:-postgres}"
      PGPASSWORD: "${APP_PSQL_PASSWORD:-mypassword654321789}"
    volumes:
      - type: "volume"
        source: "my-postgres-data"
        target: "/var/lib/postgresql/data"
      - type: "bind"
        source: "../db-dumps"
        target: "/root/db-dumps"

  redis:
    image: "redis:5"
    container_name: "${COMPOSE_PROJECT_NAME:?}_redis"
    ports:
      - "${APP_REDIS_PORT:-6379}:6379"

volumes:
  my-postgres-data:
```

### package.json
```json
{
  "private": true,
  "name": "my-devker",
  "version": "1.0.0",
  "dependencies": {
    "devker": "^0.3.0"
  },
  "scripts": {
    "cli": "devker",
    "up": "devker up",
    "down": "devker down",
    "destroy": "devker destroy",
    "postgres": "devker postgres"
  }
}
```
