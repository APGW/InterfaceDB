# PQM – Live-Monitoring für Power Quality

Angular-Anwendung zur Live-Darstellung bereits berechneter Power-Quality-Messwerte. Die Oberfläche zeigt Spannungsverläufe, PQ-Ereignisse, Spannungs-THDS, Frequenz und weitere Netzqualitätskennzahlen sowie Spannungsunsymmetrie als Zeitreihe und Zeigerdiagramm.

Die Anwendung ist bewusst auf die Livedarstellung begrenzt. Datenbankansichten und die Berechnung fachlicher Messgrößen gehören nicht zu diesem Frontend.

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

## Bedienung

Das Live-Dashboard bietet folgende Zeitbereiche:

- Live
- letzte 15 Minuten
- letzte Stunde
- letzte 24 Stunden

Die Messgeräteauswahl bleibt in der Kopfzeile. Pollingrate, API-Ziel, REST-Pfade, Zeitüberschreitung, Abruflimit, Zeitreihen-Buckets und optionale Bearer-Authentifizierung werden im Panel **API-Konfiguration** gepflegt. Der Bearer-Token wird nur im Arbeitsspeicher gehalten und nicht im Browser gespeichert.

## REST-Schnittstelle

Der Client verwendet bevorzugt REST mit Cursor-basiertem Polling. Die Standardkonfiguration erwartet:

- `GET /api/v1/live/snapshot`
- `GET /api/v1/live/updates`
- `GET /api/v1/live/last-seen` für Verbindungstest und leichtgewichtige Erreichbarkeitsprüfung

Der Snapshot liefert den gewählten Zeitraum. Danach ruft der Client alle neuen Datensätze über den vom Server gelieferten Cursor ab. Eine Pollingrate von zwei Sekunden begrenzt daher nicht die Datenvollständigkeit: Der Cursor bezeichnet die letzte vollständig empfangene Position, und erkannte Sequenzlücken lösen einen neuen Snapshot aus.

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
```
