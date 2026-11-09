Power-Quality-Datenbank mit Podman
==================================

Inhalt
------
setup_pq_podman.sh    Erstellt/startet den Podman-Container und installiert das Schema.
powerquality_schema.sql
                      Das vom Benutzer bereitgestellte SQL-Schema.

Voraussetzungen
---------------
- Linux mit Podman
- openssl
- Internetverbindung für den ersten Image-Pull

Installation
------------
1. Alle Dateien in dasselbe Verzeichnis entpacken.
2. In dieses Verzeichnis wechseln.
3. Ausführen:

   chmod +x setup_pq_podman.sh
   ./setup_pq_podman.sh

Beim ersten Lauf wird eine .env-Datei mit einem zufälligen Passwort angelegt.
Diese Datei enthält Zugangsdaten und hat Dateirechte 600. Nicht veröffentlichen
oder in Git einchecken.

Standardwerte
-------------
Image:       timescale/timescaledb:2.31.0-pg16
Datenbank:   powerquality
DB-Benutzer: pq_admin
Container:   pq-timescaledb
Podman-Volume: pq-timescaledb-data
Host-Bind:   127.0.0.1
Host-Port:   5432

Der Port ist standardmäßig nur lokal auf dem Linux-Host erreichbar.
Für einen anderen Port kann das Skript so gestartet werden:

   HOST_PORT=5433 ./setup_pq_podman.sh

Für Remote-Zugriff die Bind-Adresse bewusst setzen, z.B. auf die Tailscale-IP
des Linux-Hosts. Nicht unbedacht 0.0.0.0 verwenden; Firewall-Regeln setzen.

Verwaltung
----------
Containerstatus:
   podman ps -a --filter name=pq-timescaledb

Logs:
   podman logs -f pq-timescaledb

Datenbank-Shell:
   podman exec -it pq-timescaledb psql -U pq_admin -d powerquality

Stoppen / Starten:
   podman stop pq-timescaledb
   podman start pq-timescaledb

Backup (Custom-Format):
   podman exec pq-timescaledb pg_dump -U pq_admin -d powerquality -Fc > powerquality.dump

Wichtig
-------
- Datenbankdateien liegen im benannten Podman-Volume pq-timescaledb-data.
- Container-Neuerstellung oder Container-Entfernung löscht das benannte Volume
  nicht automatisch. Niemals podman volume rm ausführen, wenn Daten erhalten
  bleiben sollen.
- Das Setup-Skript spielt das Schema bei jedem Aufruf erneut ein. Das SQL-Skript
  ist auf wiederholte Ausführung ausgelegt; vor Produktivmigrationen trotzdem
  ein Backup erstellen.
- PostgreSQL 16 ist im Image-Tag festgelegt, passend zum SQL-Kommentar.
