#!/usr/bin/env bash
# Power-Quality-Livesystem: PostgreSQL 16 + TimescaleDB + Drogon-REST-API.
# Startet beide Container, installiert das Schema und prüft die API-Verbindung.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/powerquality_schema.sql"
ENV_FILE="${SCRIPT_DIR}/.env"
API_CONTAINERFILE="${SCRIPT_DIR}/backend/Containerfile"

CONTAINER_NAME="${CONTAINER_NAME:-pq-timescaledb}"
VOLUME_NAME="${VOLUME_NAME:-pq-timescaledb-data}"
IMAGE="${IMAGE:-timescale/timescaledb:2.31.0-pg16}"
NETWORK_NAME="${NETWORK_NAME:-pq-monitoring}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-5432}"
API_CONTAINER_NAME="${API_CONTAINER_NAME:-pq-drogon-api}"
API_IMAGE="${API_IMAGE:-localhost/pqm-drogon-api:1.0}"
API_HOST_BIND="${API_HOST_BIND:-127.0.0.1}"
API_HOST_PORT="${API_HOST_PORT:-8080}"
API_CORS_ORIGIN="${API_CORS_ORIGIN:-http://localhost:4200}"

log() { printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

[[ -f "$SCHEMA_FILE" ]] || die "SQL-Datei fehlt: $SCHEMA_FILE"
[[ -f "$API_CONTAINERFILE" ]] || die "Drogon-Containerfile fehlt: $API_CONTAINERFILE"
[[ -f "${SCRIPT_DIR}/backend/sql/snapshot.sql" ]] || die "Snapshot-SQL fehlt."
[[ -f "${SCRIPT_DIR}/backend/sql/updates.sql" ]] || die "Update-SQL fehlt."
command -v podman >/dev/null 2>&1 || die "Podman ist nicht installiert oder nicht im PATH."
command -v openssl >/dev/null 2>&1 || die "openssl wird zum Erzeugen eines Datenbankpassworts benötigt."

# Zugangsdaten beim ersten Start erzeugen und anschließend lokal behalten.
if [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    DB_PASSWORD="$(openssl rand -hex 32)"
    cat > "$ENV_FILE" <<ENVVARS
POSTGRES_DB=powerquality
POSTGRES_USER=pq_admin
POSTGRES_PASSWORD=${DB_PASSWORD}
PQM_API_DB_USER=pq_live_api
PQM_API_DB_PASSWORD=$(openssl rand -hex 32)
ENVVARS
    chmod 600 "$ENV_FILE"
    log "Zugangsdaten erzeugt: ${ENV_FILE} (Dateirechte 600)"
fi

# Bestehende Installationen erhalten beim ersten Lauf mit API einen eigenen
# Read-only-Zugang, ohne das vorhandene Administratorpasswort zu verändern.
if ! grep -q '^PQM_API_DB_PASSWORD=' "$ENV_FILE"; then
    umask 077
    {
        printf 'PQM_API_DB_USER=pq_live_api\n'
        printf 'PQM_API_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    } >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "Read-only-Zugang für die Drogon-API ergänzt"
fi

read_env() {
    local key="$1"
    sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1 | tr -d '\r'
}

POSTGRES_DB="$(read_env POSTGRES_DB)"
POSTGRES_USER="$(read_env POSTGRES_USER)"
POSTGRES_PASSWORD="$(read_env POSTGRES_PASSWORD)"
PQM_API_DB_USER="$(read_env PQM_API_DB_USER)"
PQM_API_DB_PASSWORD="$(read_env PQM_API_DB_PASSWORD)"

[[ -n "$POSTGRES_DB" ]] || die "POSTGRES_DB fehlt in ${ENV_FILE}"
[[ -n "$POSTGRES_USER" ]] || die "POSTGRES_USER fehlt in ${ENV_FILE}"
[[ -n "$POSTGRES_PASSWORD" ]] || die "POSTGRES_PASSWORD fehlt in ${ENV_FILE}"
[[ -n "$PQM_API_DB_USER" ]] || die "PQM_API_DB_USER fehlt in ${ENV_FILE}"
[[ -n "$PQM_API_DB_PASSWORD" ]] || die "PQM_API_DB_PASSWORD fehlt in ${ENV_FILE}"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_DB muss ein gültiger, einfacher SQL-Bezeichner sein."
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_USER muss ein gültiger, einfacher SQL-Bezeichner sein."
[[ "$PQM_API_DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "PQM_API_DB_USER muss ein gültiger, einfacher SQL-Bezeichner sein."
[[ "$PQM_API_DB_PASSWORD" =~ ^[A-Fa-f0-9]{64}$ ]] || die "PQM_API_DB_PASSWORD muss ein 64-stelliges Hex-Passwort sein."

log "Container-Konfiguration"
printf '  Image:       %s\n  Container:   %s\n  Volume:      %s\n  Datenbank:   %s\n  DB-Benutzer: %s\n  Bind-Adresse:%s\n  Host-Port:   %s\n' \
    "$IMAGE" "$CONTAINER_NAME" "$VOLUME_NAME" "$POSTGRES_DB" "$POSTGRES_USER" "$HOST_BIND" "$HOST_PORT"
printf '  Netzwerk:    %s\n  API-Image:    %s\n  API-Container:%s\n  API-Bind:     %s\n  API-Port:     %s\n  CORS-Origin:  %s\n' \
    "$NETWORK_NAME" "$API_IMAGE" "$API_CONTAINER_NAME" "$API_HOST_BIND" "$API_HOST_PORT" "$API_CORS_ORIGIN"

if ! podman network exists "$NETWORK_NAME"; then
    log "Internes Podman-Netzwerk anlegen: ${NETWORK_NAME}"
    podman network create "$NETWORK_NAME" >/dev/null
fi

# Ein benanntes Podman-Volume hält Daten unabhängig vom Container-Lebenszyklus.
if ! podman volume exists "$VOLUME_NAME"; then
    log "Persistentes Datenvolume anlegen"
    podman volume create "$VOLUME_NAME" >/dev/null
fi

# Bestehenden Container weiterverwenden; keine Daten oder Container automatisch löschen.
if podman container exists "$CONTAINER_NAME"; then
    log "Vorhandenen Container ${CONTAINER_NAME} verwenden"
    RUNNING="$(podman inspect --format '{{.State.Running}}' "$CONTAINER_NAME")"
    if [[ "$RUNNING" != "true" ]]; then
        podman start "$CONTAINER_NAME" >/dev/null
    fi
else
    log "Container-Image herunterladen: ${IMAGE}"
    podman pull "$IMAGE"

    log "PostgreSQL-/TimescaleDB-Container erstellen und starten"
    podman run --detach \
        --name "$CONTAINER_NAME" \
        --hostname "$CONTAINER_NAME" \
        --restart=unless-stopped \
        --network "$NETWORK_NAME" \
        --env-file "$ENV_FILE" \
        --publish "${HOST_BIND}:${HOST_PORT}:5432" \
        --volume "${VOLUME_NAME}:/var/lib/postgresql/data" \
        --shm-size=256m \
        --health-cmd="pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}" \
        --health-interval=10s \
        --health-timeout=5s \
        --health-retries=10 \
        --health-start-period=30s \
        "$IMAGE" >/dev/null
fi

# Ein bereits vorhandener Datenbankcontainer wird ohne Neuerstellung an das
# interne Netz gehängt. Das persistente Datenvolume bleibt dabei unberührt.
if ! podman inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$CONTAINER_NAME" \
    | grep -Fxq "$NETWORK_NAME"; then
    log "Datenbankcontainer mit ${NETWORK_NAME} verbinden"
    podman network connect "$NETWORK_NAME" "$CONTAINER_NAME"
fi

log "Warte auf PostgreSQL"
READY=0
for _ in $(seq 1 60); do
    if podman exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 2
done

if [[ "$READY" -ne 1 ]]; then
    podman logs --tail 100 "$CONTAINER_NAME" >&2 || true
    die "PostgreSQL wurde innerhalb von 120 Sekunden nicht bereit. Siehe Container-Logs oben."
fi

log "Power-Quality-Schema einspielen"
# Das SQL-Skript enthält BEGIN/COMMIT und ist laut Dateikommentar für eine
# erneute Ausführung auf dem vorhandenen Schema vorgesehen.
podman exec -i "$CONTAINER_NAME" \
    psql -X --set ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" < "$SCHEMA_FILE"

log "Read-only-Datenbankrolle für die Drogon-API einrichten"
podman exec -i "$CONTAINER_NAME" \
    psql -X --set ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set "api_user=${PQM_API_DB_USER}" \
    --set "api_password=${PQM_API_DB_PASSWORD}" \
    --set "db_name=${POSTGRES_DB}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'api_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_user')
\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'api_user', :'api_password')
\gexec
ALTER ROLE :"api_user" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE :"db_name" TO :"api_user";
REVOKE CREATE ON SCHEMA public FROM :"api_user";
GRANT USAGE ON SCHEMA public TO :"api_user";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"api_user";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"api_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM :"api_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"api_user";
SQL

log "Drogon-API-Image bauen"
podman build \
    --file "$API_CONTAINERFILE" \
    --tag "$API_IMAGE" \
    "$SCRIPT_DIR"

# Die API ist zustandslos. Sie wird bei jedem Setup kontrolliert ersetzt,
# damit Quellcode-, Image- und Umgebungsänderungen sicher übernommen werden.
if podman container exists "$API_CONTAINER_NAME"; then
    log "Vorhandenen, zustandslosen API-Container ersetzen"
    podman rm --force "$API_CONTAINER_NAME" >/dev/null
fi

log "Drogon-API-Container starten"
podman run --detach \
    --name "$API_CONTAINER_NAME" \
    --hostname "$API_CONTAINER_NAME" \
    --restart=unless-stopped \
    --network "$NETWORK_NAME" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --cap-drop=all \
    --security-opt=no-new-privileges \
    --env "POSTGRES_DB=${POSTGRES_DB}" \
    --env "POSTGRES_USER=${PQM_API_DB_USER}" \
    --env "POSTGRES_PASSWORD=${PQM_API_DB_PASSWORD}" \
    --env "DB_HOST=${CONTAINER_NAME}" \
    --env "DB_PORT=5432" \
    --env "DB_CONNECTIONS=4" \
    --env "API_BIND_ADDRESS=0.0.0.0" \
    --env "API_PORT=8080" \
    --env "API_CORS_ORIGIN=${API_CORS_ORIGIN}" \
    --publish "${API_HOST_BIND}:${API_HOST_PORT}:8080" \
    "$API_IMAGE" >/dev/null

log "Warte auf Drogon-API und PostgreSQL-Verbindung"
API_READY=0
for _ in $(seq 1 60); do
    if podman exec "$API_CONTAINER_NAME" \
        curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
        API_READY=1
        break
    fi
    sleep 2
done

if [[ "$API_READY" -ne 1 ]]; then
    podman logs --tail 150 "$API_CONTAINER_NAME" >&2 || true
    die "Drogon-API wurde innerhalb von 120 Sekunden nicht bereit."
fi

log "Installation erfolgreich"
printf '\nDatenbank:   %s\nDB-Benutzer: %s\nDB-Container:%s\nDB-Host-Port:%s\n' \
    "$POSTGRES_DB" "$POSTGRES_USER" "$CONTAINER_NAME" "$HOST_PORT"
printf 'API-Container:%s\nAPI-Basis-URL:http://%s:%s/api/v1/live\n' \
    "$API_CONTAINER_NAME" "$API_HOST_BIND" "$API_HOST_PORT"
printf 'Passwortdatei: %s\n' "$ENV_FILE"
printf '\nNützliche Befehle:\n'
printf '  Status:       podman ps --filter name=%s\n' "$CONTAINER_NAME"
printf '  Logs:         podman logs -f %s\n' "$CONTAINER_NAME"
printf '  API-Logs:     podman logs -f %s\n' "$API_CONTAINER_NAME"
printf '  API-Health:   curl http://%s:%s/healthz\n' "$API_HOST_BIND" "$API_HOST_PORT"
printf '  psql:         podman exec -it %s psql -U %s -d %s\n' "$CONTAINER_NAME" "$POSTGRES_USER" "$POSTGRES_DB"
printf '  Stoppen:      podman stop %s\n' "$CONTAINER_NAME"
printf '                podman stop %s\n' "$API_CONTAINER_NAME"
printf '  Starten:      podman start %s\n' "$CONTAINER_NAME"
printf '                podman start %s\n' "$API_CONTAINER_NAME"
printf '\nHinweis: Das Datenvolume bleibt beim Stoppen oder Entfernen des Containers erhalten.\n'
printf 'Das Volume nur nach einem separaten Backup und bewusstem Löschen entfernen.\n'
