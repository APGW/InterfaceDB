Power-Quality-Livesystem mit Podman
==================================

Inhalt
------
setup_pq_podman.sh
    Erstellt das interne Podman-Netz, startet TimescaleDB und baut/startet die
    Drogon-REST-API.

powerquality_schema.sql
    PostgreSQL-/TimescaleDB-Schema. Messwerte, Aggregate, Ereignisse, Flags,
    THDS und Unsymmetrie werden fertig berechnet übergeben. Die Datenbank
    berechnet keine fachlichen PQ-Werte.

backend/
    C++17-Drogon-API, Containerfile und parametrisierte SQL-Abfragen.

Voraussetzungen
---------------
- Debian oder ein vergleichbares Linux-System mit Podman
- openssl
- Internetverbindung beim ersten Image-Build
- ausreichend freier Speicher für das temporäre Drogon-Build-Image

Installation
------------
1. Das komplette Repository auf den Debian-Host übertragen.
2. In das Repository wechseln.
3. Ausführen:

   chmod +x setup_pq_podman.sh
   ./setup_pq_podman.sh

Beim ersten Lauf wird eine lokale .env-Datei mit einem zufälligen
PostgreSQL-Passwort erzeugt. Die Datei hat Dateirechte 600 und darf nicht in
Git eingecheckt werden. Zusätzlich wird ein separates zufälliges Passwort für
den Read-only-Benutzer pq_live_api erzeugt. Nur dieser Benutzer wird dem
Drogon-Container übergeben.

Gestartete Komponenten
----------------------
- pq-timescaledb: PostgreSQL 16 mit TimescaleDB und persistentem Volume
- pq-drogon-api: zustandslose Drogon-REST-API
- pq-monitoring: internes Podman-Netz zwischen API und Datenbank

Standardports
-------------
- PostgreSQL: 127.0.0.1:5432
- Drogon API: 127.0.0.1:8080
- API-Basis-URL: http://127.0.0.1:8080/api/v1/live
- Healthcheck: http://127.0.0.1:8080/healthz

Die Datenbank und API sind standardmäßig nicht auf allen Netzwerkschnittstellen
erreichbar. Das Angular-Dashboard kann lokal mit der Standard-API-URL arbeiten.
Die API besitzt in PostgreSQL ausschließlich CONNECT-, USAGE- und SELECT-Rechte.
Der API-Container läuft als UID 10001 ohne Linux-Capabilities, mit schreibgeschütztem
Root-Dateisystem und einem kleinen temporären `/tmp`-Dateisystem.

Dediziertes VPN
---------------
Das VPN selbst wird auf Betriebssystem- oder Gateway-Ebene aufgebaut. Die
Container konfigurieren kein VPN. Soll die API über eine dedizierte VPN-Adresse
erreichbar sein, wird genau diese Adresse gebunden. Läuft das Frontend über
HTTPS, muss ein TLS-Reverse-Proxy vor der internen HTTP-API stehen:

   API_HOST_BIND=10.20.30.40 \
   API_CORS_ORIGIN=https://pqm-frontend.intern \
   ./setup_pq_podman.sh

Nicht unbedacht 0.0.0.0 verwenden. Firewall und VPN-Routing müssen den Zugriff
auf den vorgesehenen Frontend-Host begrenzen. PostgreSQL muss für das Dashboard
nicht über das VPN veröffentlicht werden; die API erreicht es im internen
Podman-Netz.

Optionale Anpassungen
---------------------
   HOST_PORT=5433 API_HOST_PORT=8081 ./setup_pq_podman.sh

Weitere Variablen:
- CONTAINER_NAME, VOLUME_NAME, IMAGE
- NETWORK_NAME
- API_CONTAINER_NAME, API_IMAGE
- HOST_BIND, HOST_PORT
- API_HOST_BIND, API_HOST_PORT, API_CORS_ORIGIN

REST-Endpunkte
--------------
GET /healthz
    Prüft API und PostgreSQL-Verbindung.

GET /api/v1/live/snapshot
    Parameter: meter_id, window_minutes, bucket_seconds, limit
    Liefert den Startzeitraum. bucket_seconds wählt bereits gespeicherte
    Datensätze zeitlich aus; es werden keine PQ-Werte in PostgreSQL berechnet.

GET /api/v1/live/updates
    Parameter: meter_id, after_cursor, limit
    Liefert alle noch nicht übertragenen Daten pro Datenstrom. Der Cursor ist
    opak und muss unverändert zurückgesendet werden.

GET /api/v1/live/last-seen
    Parameter: meter_id
    Leichter Verbindungstest ohne Dashboard-Statusanzeige.

Cursor und Datenvollständigkeit
------------------------------
Der Cursor enthält getrennte Positionen für Grundmesswerte, PQ-Ereignisse,
Unsymmetrie, 10-Minuten- und 2-Stunden-Werte. Hat eine Antwort hasMore=true,
ruft das Angular-Frontend sofort weitere Seiten ab. Ein technischer
cursorGapDetected-Hinweis löst je nach Frontend-Konfiguration einen neuen
Snapshot oder eine sichtbare Fehlermeldung aus.

Die API berechnet keine RMS-, THDS-, Flicker-, Unsymmetrie- oder Ereigniswerte.
Sie führt ausschließlich Auswahl, Cursor-Paginierung, JSON-Serialisierung und
Einheitenanpassung für die Übertragung aus.

Verwaltung
----------
   podman ps -a --filter name=pq-
   podman logs -f pq-timescaledb
   podman logs -f pq-drogon-api
   curl http://127.0.0.1:8080/healthz
   podman exec -it pq-timescaledb psql -U pq_admin -d powerquality

Backup
------
   podman exec pq-timescaledb \
     pg_dump -U pq_admin -d powerquality -Fc > powerquality.dump

Wichtig
-------
- Das benannte Datenvolume pq-timescaledb-data wird niemals automatisch
  gelöscht oder ersetzt.
- Der zustandslose API-Container wird bei jedem Setup neu gebaut und ersetzt,
  damit Quellcode- und Konfigurationsänderungen wirksam werden.
- Das Schema wird bei jedem Lauf idempotent angewendet. Vor produktiven
  Migrationen trotzdem ein Datenbank-Backup erstellen.
- Drogon ist im Containerfile auf v1.9.13 festgelegt.
