#!/usr/bin/env bash
# Power-Quality-Datenbank: PostgreSQL 16 + TimescaleDB in Podman
# Startet den Container, wartet auf PostgreSQL und spielt das SQL-Schema ein.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/powerquality_schema.sql"
ENV_FILE="${SCRIPT_DIR}/.env"

CONTAINER_NAME="${CONTAINER_NAME:-pq-timescaledb}"
VOLUME_NAME="${VOLUME_NAME:-pq-timescaledb-data}"
IMAGE="${IMAGE:-timescale/timescaledb:2.31.0-pg16}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-5432}"

log() { printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

[[ -f "$SCHEMA_FILE" ]] || die "SQL-Datei fehlt: $SCHEMA_FILE"
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
ENVVARS
    chmod 600 "$ENV_FILE"
    log "Zugangsdaten erzeugt: ${ENV_FILE} (Dateirechte 600)"
fi

read_env() {
    local key="$1"
    sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1 | tr -d '\r'
}

POSTGRES_DB="$(read_env POSTGRES_DB)"
POSTGRES_USER="$(read_env POSTGRES_USER)"
POSTGRES_PASSWORD="$(read_env POSTGRES_PASSWORD)"

[[ -n "$POSTGRES_DB" ]] || die "POSTGRES_DB fehlt in ${ENV_FILE}"
[[ -n "$POSTGRES_USER" ]] || die "POSTGRES_USER fehlt in ${ENV_FILE}"
[[ -n "$POSTGRES_PASSWORD" ]] || die "POSTGRES_PASSWORD fehlt in ${ENV_FILE}"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_DB muss ein gültiger, einfacher SQL-Bezeichner sein."
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "POSTGRES_USER muss ein gültiger, einfacher SQL-Bezeichner sein."

log "Container-Konfiguration"
printf '  Image:       %s\n  Container:   %s\n  Volume:      %s\n  Datenbank:   %s\n  DB-Benutzer: %s\n  Bind-Adresse:%s\n  Host-Port:   %s\n' \
    "$IMAGE" "$CONTAINER_NAME" "$VOLUME_NAME" "$POSTGRES_DB" "$POSTGRES_USER" "$HOST_BIND" "$HOST_PORT"

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

log "Installation erfolgreich"
printf '\nDatenbank:   %s\nDB-Benutzer: %s\nContainer:   %s\nHost-Port:   %s\n' \
    "$POSTGRES_DB" "$POSTGRES_USER" "$CONTAINER_NAME" "$HOST_PORT"
printf 'Passwortdatei: %s\n' "$ENV_FILE"
printf '\nNützliche Befehle:\n'
printf '  Status:       podman ps --filter name=%s\n' "$CONTAINER_NAME"
printf '  Logs:         podman logs -f %s\n' "$CONTAINER_NAME"
printf '  psql:         podman exec -it %s psql -U %s -d %s\n' "$CONTAINER_NAME" "$POSTGRES_USER" "$POSTGRES_DB"
printf '  Stoppen:      podman stop %s\n' "$CONTAINER_NAME"
printf '  Starten:      podman start %s\n' "$CONTAINER_NAME"
printf '\nHinweis: Das Datenvolume bleibt beim Stoppen oder Entfernen des Containers erhalten.\n'
printf 'Das Volume nur nach einem separaten Backup und bewusstem Löschen entfernen.\n'
