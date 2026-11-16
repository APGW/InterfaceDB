# PQM Drogon Live API

Die C++17-Anwendung stellt die REST-Schnittstelle des Angular-Live-Dashboards bereit. Sie verwendet Drogons asynchronen PostgreSQL-Client und greift ausschließlich lesend auf bereits berechnete PQ-Daten zu. Das Podman-Setup erzeugt dafür einen getrennten PostgreSQL-Benutzer mit ausschließlich `CONNECT`, `USAGE` und `SELECT`.

## Endpunkte

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/healthz` | API- und Datenbankbereitschaft |
| `GET` | `/api/v1/live/snapshot` | Startzeitraum für Live, 15 min, 1 h oder 24 h |
| `GET` | `/api/v1/live/updates` | Cursor-basierte inkrementelle Aktualisierung |
| `GET` | `/api/v1/live/last-seen` | Leichter Erreichbarkeitstest |

Der Cursor ist absichtlich opak. Clients dürfen ihn weder numerisch interpretieren noch verändern.

## Umgebungsvariablen

| Variable | Standard |
| --- | --- |
| `DB_HOST` | `127.0.0.1` |
| `DB_PORT` | `5432` |
| `POSTGRES_DB` | `powerquality` |
| `POSTGRES_USER` | `pq_admin` |
| `POSTGRES_PASSWORD` | leer |
| `DB_CONNECTIONS` | `4` |
| `API_BIND_ADDRESS` | `0.0.0.0` |
| `API_PORT` | `8080` |
| `API_THREADS` | `2` |
| `API_CORS_ORIGIN` | `http://localhost:4200` |
| `PQM_SQL_DIR` | `./sql` |

## Lokaler Linux-Build

Drogon muss mit PostgreSQL-Unterstützung installiert sein.

```bash
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build --parallel
PQM_SQL_DIR=backend/sql backend/build/pqm-live-api
```

Für den vorgesehenen Debian-Podman-Betrieb wird stattdessen `setup_pq_podman.sh` verwendet. Das Containerfile baut die festgelegte Drogon-Version selbst und benötigt auf dem Host keine C++-Werkzeugkette.

## Datenverarbeitung

Die SQL-Abfragen verwenden keine `AVG`, `MIN` oder `MAX`-Berechnung zur Erzeugung fachlicher Messwerte. `MAX(timestamp)` wird ausschließlich als technischer Cursor beziehungsweise Last-Seen-Metadatum genutzt. Zeit-Buckets wählen vorhandene Datensätze aus; sie berechnen keine Ersatzmesswerte.
