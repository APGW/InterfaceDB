# PQM – Power Quality Monitoring

Interaktive React-/TypeScript-Oberfläche für das in `powerquality_schema.sql` definierte PostgreSQL-/TimescaleDB-Datenmodell.

## Start

```bash
npm install
copy .env.example .env
npm run dev
```

`VITE_DEMO_MODE=true` aktiviert den ausdrücklich gekennzeichneten Mock-Service. Mit `VITE_DEMO_MODE=false` werden ausschließlich Antworten der unter `VITE_API_BASE_URL` konfigurierten REST-API verwendet. Ein API-Ausfall führt zu einer sichtbaren Fehlermeldung; es gibt keinen stillen Fallback auf Demo-Daten.

## Prüfung

```bash
npm run typecheck
npm run build
```

Die Anwendung verarbeitet Zeitpunkte intern als ISO-Zeitpunkte und zeigt sie in der Oberfläche in `Europe/Berlin` an. Schreibvorgänge werden im Demo-Modus bewusst nicht als erfolgreich simuliert.

## Live-Dashboard

Das Dashboard fragt im Live-Modus alle zwei Sekunden inkrementelle Daten über
`GET /dashboard/live` ab. Erwartete Parameter sind `meter_id`, `from`, `to`,
`after`, `bucket_seconds` und `limit`. Die Antwort enthält:

- `server_time`, `last_measurement_timestamp`, `status` und `cursor`
- phasenausgerichtete Spannungswerte mit `min_voltage`, `max_voltage` und `avg_voltage`
- `voltage_thds_percent` für L1, L2 und L3
- einmalig gezählte PQ-Ereignisse
- historisch gültige Udin-, Dip- und Swell-Grenzsegmente
- getrennte Zeitreihen für Frequenz, Pst, Plt, Langzeit-RMS und
  Spannungsunsymmetrie
- eigenständige Ereignistypen für RVC und Spannungstransienten
- Zeigerdiagramme für dreiphasige Unsymmetrie sowie den Vorher-/Nachher-Zustand
  eines RVC-Ereignisses

`voltage_thds_percent` ist ausschließlich Spannungs-THDS in Prozent und wird vom
Messgerät beziehungsweise DSP geliefert. `null` bedeutet „nicht verfügbar“.
Der Browser begrenzt jede Datenreihe über einen Ringpuffer; eine Pause stoppt nur
die Darstellung, nicht die Datenerfassung.

## Datenbankgrenze

Die Datenbank berechnet keine Mess-, Aggregat- oder Ereigniswerte. RMS-Werte,
THDS, Flicker, Unsymmetrie, RVC-/Transienten-Kennwerte und Flags
müssen vollständig durch Messgerät, DSP oder Anwendungsdienst übergeben werden.
Das Schema übernimmt Speicherung, Beziehungen und Plausibilitätsprüfungen.
Auch die für Zeigerdiagramme benötigten Beträge und Winkel werden extern
ermittelt und vollständig übergeben.

