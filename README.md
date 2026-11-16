# PQM – Live-Monitoring für Power Quality

Angular-Anwendung zur Live-Darstellung bereits berechneter Power-Quality-Messwerte. Die Oberfläche zeigt Spannungsverläufe, PQ-Ereignisse, Spannungs-THDS, Frequenz und weitere Netzqualitätskennzahlen sowie Spannungsunsymmetrie als Zeitreihe und Zeigerdiagramm.

Die Anwendung ist bewusst auf die Livedarstellung begrenzt. Datenbankansichten und die Berechnung fachlicher Messgrößen gehören nicht zu diesem Frontend. Ein C++17-Backend auf Basis von Drogon stellt die REST-Schnittstelle bereit und liest bereits berechnete Werte aus PostgreSQL/TimescaleDB.

## Voraussetzungen

- Node.js 20.19 oder neuer
- npm

## Lokal starten

```powershell
npm install
npm run dev
```

Die Oberfläche ist anschließend standardmäßig unter `http://localhost:4200` erreichbar. Beim ersten Start ist die integrierte Demoquelle aktiv, sodass keine API benötigt wird.

## Prüfung und Produktions-Build

```powershell
npm run typecheck
npm run build
```

Der Produktions-Build wird unter `dist/pqm-live/browser` erzeugt.

## Debian-/Podman-Livesystem

Auf dem vorgesehenen Debian-Host startet ein Skript TimescaleDB und die Drogon-API in einem gemeinsamen internen Podman-Netz:

```bash
chmod +x setup_pq_podman.sh
./setup_pq_podman.sh
```

Danach ist die API standardmäßig unter `http://127.0.0.1:8080/api/v1/live` erreichbar. Details zu Ports, VPN-Bindung, Betrieb und Backup stehen in `README_pq_podman.txt`; der Backend-Code ist in `backend/` dokumentiert.

## Bedienung

Das Live-Dashboard bietet folgende Zeitbereiche:

- Live
- letzte 15 Minuten
- letzte Stunde
- letzte 24 Stunden

Die Messgeräteauswahl bleibt in der Kopfzeile. Das Panel **API-Konfiguration** enthält:

- API-Ziel, Messgerät und REST-Pfade
- Pollingrate, Zeitüberschreitung, Abruflimit und Zeitreihen-Buckets
- Bearer- oder OAuth-2.0-/Keycloak-Konfiguration
- Retry mit exponentiellem Backoff
- parametrierbarer Alarm nach aufeinanderfolgenden unbeantworteten Pollingabrufen
- Datenstillstand-Alarm nach fünf Pollingintervallen ohne neue Sequenz oder Nutzdaten
- begrenzte Cursor-Catch-up-Abrufe und periodische Snapshot-Erneuerung
- wählbares Verhalten bei einer Sequenzlücke und eine Startansicht

Zugriffstoken werden ausschließlich im Arbeitsspeicher gehalten und nicht im Browser gespeichert. Das dedizierte VPN wird außerhalb des Browsers auf Betriebssystem- oder Gateway-Ebene aufgebaut.

## REST-Schnittstelle

Der Client verwendet REST mit Cursor-basiertem Polling. Die Standardkonfiguration erwartet die lokale Drogon-API unter `http://127.0.0.1:8080/api/v1/live` und folgende Pfade:

- `GET /api/v1/live/snapshot`
- `GET /api/v1/live/updates`
- `GET /api/v1/live/last-seen` für Verbindungstest und leichtgewichtige Erreichbarkeitsprüfung

Der Snapshot liefert den gewählten Zeitraum. Danach ruft der Client alle neuen Datensätze über den vom Server gelieferten opaken Cursor ab. Eine Pollingrate von zwei Sekunden begrenzt daher nicht die Datenvollständigkeit: Drogon führt getrennte Cursorpositionen für Grundmesswerte, Ereignisse, Unsymmetrie sowie 10-Minuten- und 2-Stunden-Werte. `hasMore=true` löst unmittelbare Catch-up-Abrufe aus; `cursorGapDetected=true` aktiviert die konfigurierte Wiederherstellung.

Die Live-Diagnose unterscheidet zwei Fehlerbilder. Eine erfolgreiche, aber leere API-Antwort setzt den Serverausfallzähler zurück, nicht jedoch den Zeitstempel der letzten neuen Daten. Bleiben Cursor und Nutzdaten für `Pollingrate × 5` unverändert, erscheint der Datenstillstand-Dialog. Antwortet die API auch nach Timeout und den konfigurierten Retries nicht, zählt dies als ein unbeantworteter Pollingabruf; nach der parametrierten Anzahl erscheint ein eigener Serverfehler-Dialog. Beide Störungen werden bis zur Wiederherstellung nur einmal gemeldet.

Wichtige Abfrageparameter sind:

- `meter_id`
- `window_minutes` und `bucket_seconds` beim Snapshot
- `after_cursor` bei inkrementellen Updates
- `limit`

Die Antworten enthalten unter anderem `serverTime`, `cursor`, Sequenzinformationen, Grenzwerte sowie Arrays für Spannung, Ereignisse, Unsymmetrie und Qualitätskennzahlen. Die Typdefinitionen stehen in `src/app/core/live.models.ts`.

## Fachliche Grenze

Messgerät, DSP oder Anwendungsdienst übergeben alle fachlich berechneten Werte vollständig an die API. Das Frontend visualisiert diese Werte und berechnet keine PQ-Messgrößen. Dies betrifft insbesondere:

- RMS-Minimum, -Maximum und -Mittelwert
- Spannungs-THDS
- Frequenz
- Pst und Plt
- Unsymmetrie und Zeigerwerte
- RVC- und Transienten-Kennwerte
- Ereignisse, Grenzwerte und Flags

Das Datenbankschema `powerquality_schema.sql` dient der Speicherung und enthält keine fachliche Messwertberechnung. Hinweise zur optionalen lokalen Datenbankumgebung stehen in `README_pq_podman.txt`.

## Projektstruktur

```text
src/
  app/
    core/       REST-Vertrag, Konfiguration, Modelle und Live-State
    shared/     ECharts- und Zeigerdiagramm-Komponenten
    app.*       Dashboard und API-Konfigurationsoberfläche
  main.ts       Angular-Einstiegspunkt
  styles.css    globale Gestaltung
backend/
  src/          Drogon-Anwendung
  sql/          parametrisierte Snapshot- und Cursor-Abfragen
  Containerfile Debian-12-Multi-Stage-Build
```
