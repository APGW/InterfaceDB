-- ============================================================================
-- Power-Quality-Messsystem (persistentes Datenmodell)
-- PostgreSQL 16 + TimescaleDB 2.x
-- Datenbankschema passend zum bereitgestellten UML-Klassendiagramm
--
-- Zweck:
--   * Stammdaten und Konfiguration je Messgerät
--   * Eingangskanäle und Messwandler
--   * Messwertstufen: ca. 200 ms, ca. 3 s, 10 min und 2 h
--   * Spannungs-THDS in Prozent auf der ca. 200-ms-Grundmesswertstufe
--   * Zeitreihenspeicherung als TimescaleDB-Hypertables
--   * Eventmodell gemäß PQEvent-Vererbung (Zeit-, Sample-Grid- und Störungsereignisse)
--   * Speicherung extern ermittelter Flags und ihrer Fortpflanzungshistorie
--   * GPS-/UTC-Status, Messwerteinheit und Kommunikationskonfiguration
--   * Systemzustand, DSP-Konfiguration und PQDIF-Exportprotokoll
--   * feste Startwerte für Udin, Nennfrequenz, UTC-Unsicherheit und PQ-Schwellen
--   * aktualisierte Tabellenkommentare und FlaggingEvaluator-Terminologie
--
-- Ausführung:
--   1. In einer Datenbank ausführen, in der TimescaleDB installiert ist.
--   2. Das Skript kann auch auf dem bisherigen Schema ausgeführt werden.
--      Fehlende Spalte hysteresis und zusätzliche Constraints/Indizes werden
--      ergänzt. Bestehende Tabellen und Messwerte werden nicht gelöscht.
--   3. Die Umwandlung vorhandener normaler Tabellen in Hypertables kann
--      Daten migrieren und Tabellen sperren. Währenddessen keine Messdaten
--      schreiben lassen.
--
-- Festgelegte Startwerte:
--   Udin                    = 230.0 V
--   f_nominal               = 50.0 Hz
--   dip_threshold           = 0.90 p.u.
--   swell_threshold         = 1.10 p.u.
--   interruption_threshold = 0.10 p.u.
--   hysteresis              = 0.0 (deaktiviert, bis ein Fachwert festgelegt ist)
--   max_uncertainty_ms      = 20.0 ms (Startwert gemäß Zeitgenauigkeit im PDF)
--   Class-A gapless/overlap = TRUE / TRUE (Vorgabe der ClassAAggregationEngine)
--
-- Grenze der Datenbankverantwortung:
--   Dip/Swell/Interruption werden als relative Spannungswerte (p.u.) bezogen
--   auf Udin gespeichert. Messwerte, Aggregate, Flickerwerte, THDS, Ereignisse
--   und Flag-Zustände werden außerhalb der Datenbank berechnet bzw. erkannt und
--   vollständig übergeben. Die Datenbank validiert und speichert diese Werte;
--   sie berechnet keine fachlichen Mess- oder Qualitätswerte.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Erweiterung und ENUM-Typen
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
    CREATE TYPE public.measurement_class AS ENUM ('CLASS_A', 'CLASS_S');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE public.channel_type AS ENUM ('L1', 'L2', 'L3', 'N', 'PE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE public.system_state AS ENUM ('INIT', 'RUNNING', 'MEASURING', 'ERROR', 'MAINTENANCE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE public.pq_event_type AS ENUM (
        'UTC_TEN_MINUTE_TICK',
        'TWO_HOUR_TICK',
        'ONE_SECOND_TICK',
        'TEN_TWELVE_CYCLE_COMPLETED',
        'VOLTAGE_DIP',
        'VOLTAGE_SWELL',
        'VOLTAGE_INTERRUPTION',
        'RAPID_VOLTAGE_CHANGE',
        'VOLTAGE_TRANSIENT'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

-- Ergänzt die eigenständigen Ereignistypen auch in einem vorhandenen Schema.
ALTER TYPE public.pq_event_type ADD VALUE IF NOT EXISTS 'RAPID_VOLTAGE_CHANGE';
ALTER TYPE public.pq_event_type ADD VALUE IF NOT EXISTS 'VOLTAGE_TRANSIENT';

DO $$
BEGIN
    CREATE TYPE public.pq_flag_cause AS ENUM (
        'DIP_THRESHOLD_VIOLATION',
        'SWELL_THRESHOLD_VIOLATION',
        'INTERRUPTION_THRESHOLD_VIOLATION'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    CREATE TYPE public.pq_measurement_level AS ENUM (
        'BASIC',
        'SHORT_TERM',
        'TEN_MINUTE',
        'TWO_HOUR'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Messgeräte-Stammdaten
-- Entspricht PQMeterController.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meters (
    meter_id          VARCHAR(64) PRIMARY KEY,
    firmware_version  VARCHAR(32) NOT NULL,
    active_class      public.measurement_class NOT NULL DEFAULT 'CLASS_A',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2. Systemkonfiguration
-- Entspricht IConfigurationInterface.
-- Mehrere Zeilen je Messgerät ermöglichen eine Konfigurationshistorie.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meter_configurations (
    config_id    BIGSERIAL PRIMARY KEY,
    meter_id     VARCHAR(64) NOT NULL
                 REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    udin         DOUBLE PRECISION NOT NULL DEFAULT 230.0,
    f_nominal    DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    hysteresis   DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    valid_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_meter_configurations_meter_valid_from
        UNIQUE (meter_id, valid_from),
    CONSTRAINT ck_meter_configurations_positive_values
        CHECK (udin > 0 AND f_nominal > 0 AND hysteresis >= 0)
);

-- Ergänzt die Hysterese auch bei einer bereits vorhandenen Tabelle.
ALTER TABLE public.meter_configurations
    ADD COLUMN IF NOT EXISTS hysteresis DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- Weitere im UML dargestellte System-/Zeitkonfigurationswerte.
ALTER TABLE public.meter_configurations
    ADD COLUMN IF NOT EXISTS max_uncertainty_ms DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    ADD COLUMN IF NOT EXISTS class_a_enforces_gapless BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS class_a_handle_overlaps BOOLEAN NOT NULL DEFAULT TRUE;

-- ---------------------------------------------------------------------------
-- 3. Signal-Eingangskanäle
-- Entspricht ISignalInputChannel.
-- Pro Messgerät ist jeder Kanaltyp (L1, L2, L3, N, PE) eindeutig.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.input_channels (
    channel_id          BIGSERIAL PRIMARY KEY,
    meter_id            VARCHAR(64) NOT NULL
                        REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    channel_name        VARCHAR(32) NOT NULL,
    channel_type        public.channel_type NOT NULL,
    calibration_factor  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    CONSTRAINT uq_input_channels_meter_type UNIQUE (meter_id, channel_type),
    CONSTRAINT ck_input_channels_calibration_positive
        CHECK (calibration_factor > 0)
);

-- ---------------------------------------------------------------------------
-- 4. Messwandler-Konfiguration
-- Entspricht MeasurementTransducer.
-- In dieser ersten Version gibt es genau eine aktive Wandlerkonfiguration
-- je Eingangskanal. Die Faktoren müssen positiv sein.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.transducer_configs (
    transducer_id  BIGSERIAL PRIMARY KEY,
    channel_id     BIGINT NOT NULL
                   REFERENCES public.input_channels(channel_id) ON DELETE CASCADE,
    u_ratio        REAL NOT NULL DEFAULT 1.0,
    i_ratio        REAL NOT NULL DEFAULT 1.0,
    CONSTRAINT ck_transducer_configs_ratios_positive
        CHECK (u_ratio > 0 AND i_ratio > 0)
);

-- Stellt die 1:1-Zuordnung Kanal -> Messwandlerkonfiguration sicher.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transducer_configs_channel
    ON public.transducer_configs (channel_id);

-- ---------------------------------------------------------------------------
-- 5. Schwellenwert-Konfiguration (FlaggingEvaluator)
-- Entspricht dem FlaggingManager im bereitgestellten UML-Diagramm.
-- valid_from erlaubt eine nachvollziehbare Änderungshistorie.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.threshold_settings (
    threshold_id             BIGSERIAL PRIMARY KEY,
    meter_id                 VARCHAR(64) NOT NULL
                             REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    dip_threshold            DOUBLE PRECISION NOT NULL DEFAULT 0.90,
    swell_threshold          DOUBLE PRECISION NOT NULL DEFAULT 1.10,
    interruption_threshold  DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    valid_from               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_threshold_settings_meter_valid_from
        UNIQUE (meter_id, valid_from),
    CONSTRAINT ck_threshold_settings_ranges
        CHECK (
            interruption_threshold >= 0
            AND interruption_threshold < dip_threshold
            AND dip_threshold < 1.0
            AND swell_threshold > 1.0
        )
);

-- ---------------------------------------------------------------------------
-- 5a. Messwerteinheit (MeasurementUnit)
-- sample_rate_hz und polyphase_mode sind hardwareabhängig und deshalb ohne
-- erfundene Standardwerte. valid_from bildet spätere Änderungen ab.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.measurement_unit_configurations (
    measurement_unit_config_id BIGSERIAL PRIMARY KEY,
    meter_id                   VARCHAR(64) NOT NULL
                               REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    sample_rate_hz             DOUBLE PRECISION NOT NULL,
    polyphase_mode             BOOLEAN NOT NULL,
    valid_from                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_measurement_unit_config_meter_valid
        UNIQUE (meter_id, valid_from),
    CONSTRAINT ck_measurement_unit_sample_rate_positive
        CHECK (sample_rate_hz > 0)
);

-- ---------------------------------------------------------------------------
-- 5b. Kommunikationskonfiguration (ICommunicationInterface)
-- Port und Protokoll bleiben ohne Default, da das PDF keine Werte vorgibt.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.communication_configurations (
    meter_id       VARCHAR(64) PRIMARY KEY
                   REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    port_number    INTEGER NOT NULL,
    protocol_name  VARCHAR(64) NOT NULL,
    CONSTRAINT ck_communication_port_range
        CHECK (port_number BETWEEN 1 AND 65535),
    CONSTRAINT ck_communication_protocol_not_empty
        CHECK (length(trim(protocol_name)) > 0)
);

-- ---------------------------------------------------------------------------
-- 5c. GPS-/Zeitsynchronisationsstatus (GPSReceiver / ITimeSynchronization)
-- Historie von UTC-Lock, PPS-Signal und Satellitenzahl.
-- max_uncertainty_ms liegt als Konfiguration in meter_configurations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.time_synchronization_status (
    timestamp          TIMESTAMPTZ NOT NULL,
    meter_id           VARCHAR(64) NOT NULL
                       REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    is_locked_to_utc   BOOLEAN NOT NULL,
    pps_signal_active  BOOLEAN NOT NULL,
    sat_count          INTEGER NOT NULL,
    CONSTRAINT pk_time_synchronization_status
        PRIMARY KEY (timestamp, meter_id),
    CONSTRAINT ck_time_sync_sat_count_nonnegative
        CHECK (sat_count >= 0)
);

-- ---------------------------------------------------------------------------
-- 5d. Controller-Zustände, DSP-Konfiguration und Exportprotokoll
-- Diese Tabellen stammen aus dem ergänzenden Systemarchitektur-Entwurf.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.meter_system_states (
    timestamp       TIMESTAMPTZ NOT NULL,
    meter_id        VARCHAR(64) NOT NULL
                    REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    current_state   public.system_state NOT NULL DEFAULT 'INIT',
    uptime_seconds  NUMERIC(20,0) NOT NULL,
    CONSTRAINT pk_meter_system_states PRIMARY KEY (timestamp, meter_id),
    CONSTRAINT ck_meter_system_states_uptime_uint64
        CHECK (uptime_seconds BETWEEN 0 AND 18446744073709551615)
);

CREATE TABLE IF NOT EXISTS public.dsp_configurations (
    config_id       BIGSERIAL PRIMARY KEY,
    meter_id        VARCHAR(64) NOT NULL
                    REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    buffer_size     INTEGER NOT NULL DEFAULT 1024,
    fft_bins        INTEGER NOT NULL DEFAULT 50,
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dsp_configurations_meter_valid UNIQUE (meter_id, valid_from),
    CONSTRAINT ck_dsp_configurations_positive
        CHECK (buffer_size > 0 AND fft_bins > 0)
);

CREATE TABLE IF NOT EXISTS public.pq_export_logs (
    export_id         BIGSERIAL PRIMARY KEY,
    meter_id          VARCHAR(64) NOT NULL
                      REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    export_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    protocol_name     VARCHAR(64) NOT NULL DEFAULT 'PQDIF',
    file_path         TEXT NOT NULL,
    success           BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_pq_export_logs_path_not_empty
        CHECK (length(trim(file_path)) > 0)
);

-- ---------------------------------------------------------------------------
-- 6. Grundmesswerte: BasicMeasurementValue
-- Typisches Grundintervall: ca. 200 ms (10/12 Perioden gemäß Messkonfiguration).
-- Die Harmonischen und Zwischenharmonischen sind optional; falls vorhanden,
-- enthalten die Arrays genau 50 Werte wie im Klassendiagramm vorgesehen.
-- voltage_thds_percent speichert ausschließlich Spannungs-THDS in Prozent.
-- Der Wert wird fertig berechnet vom Messgerät/DSP übergeben; NULL bedeutet
-- nicht verfügbar. Die Datenbank berechnet oder ergänzt ihn nicht.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.basic_measurement_values (
    timestamp       TIMESTAMPTZ NOT NULL,
    channel_id      BIGINT NOT NULL
                    REFERENCES public.input_channels(channel_id) ON DELETE CASCADE,
    is_flagged      BOOLEAN NOT NULL,
    quality_class   public.measurement_class NOT NULL DEFAULT 'CLASS_A',
    rms_voltage     DOUBLE PRECISION NOT NULL,
    rms_current     DOUBLE PRECISION NOT NULL,
    frequency       DOUBLE PRECISION NOT NULL,
    voltage_thds_percent DOUBLE PRECISION,
    harmonics       DOUBLE PRECISION[],
    interharmonics  DOUBLE PRECISION[],
    CONSTRAINT pk_basic_measurement_values PRIMARY KEY (timestamp, channel_id),
    CONSTRAINT ck_basic_measurement_values_ranges
        CHECK (rms_voltage >= 0 AND rms_current >= 0 AND frequency > 0),
    CONSTRAINT ck_basic_measurement_values_voltage_thds_nonnegative
        CHECK (voltage_thds_percent IS NULL OR voltage_thds_percent >= 0),
    CONSTRAINT ck_basic_measurement_values_harmonics_length
        CHECK (harmonics IS NULL OR cardinality(harmonics) = 50),
    CONSTRAINT ck_basic_measurement_values_interharmonics_length
        CHECK (interharmonics IS NULL OR cardinality(interharmonics) = 50)
);

-- Ergänzt Spannungs-THDS auch bei einem bereits vorhandenen Schema.
-- Bestehende Messwerte bleiben NULL und werden nicht nachträglich erfunden.
ALTER TABLE public.basic_measurement_values
    ADD COLUMN IF NOT EXISTS voltage_thds_percent DOUBLE PRECISION;

-- ---------------------------------------------------------------------------
-- 7. Kurzfristig aggregierte Werte: ShortTermAggregatedValue
-- Typisches Aggregationsintervall: ca. 3 s (150/180 Perioden).
-- Das Aggregat und seine Kennzeichnungen werden fertig berechnet übergeben.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.short_term_aggregated_values (
    timestamp        TIMESTAMPTZ NOT NULL,
    channel_id       BIGINT NOT NULL
                     REFERENCES public.input_channels(channel_id) ON DELETE CASCADE,
    is_flagged       BOOLEAN NOT NULL,
    quality_class    public.measurement_class NOT NULL DEFAULT 'CLASS_A',
    aggregated_rms   DOUBLE PRECISION NOT NULL,
    contains_gaps    BOOLEAN NOT NULL,
    CONSTRAINT pk_short_term_aggregated_values PRIMARY KEY (timestamp, channel_id),
    CONSTRAINT ck_short_term_aggregated_rms_nonnegative
        CHECK (aggregated_rms >= 0)
);

-- ---------------------------------------------------------------------------
-- 8. 10-Minuten-Aggregate: TenMinuteAggregatedValue
-- Sämtliche Werte und Kennzeichnungen werden fertig berechnet übergeben.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ten_minute_aggregated_values (
    timestamp        TIMESTAMPTZ NOT NULL,
    channel_id       BIGINT NOT NULL
                     REFERENCES public.input_channels(channel_id) ON DELETE CASCADE,
    is_flagged       BOOLEAN NOT NULL,
    quality_class    public.measurement_class NOT NULL DEFAULT 'CLASS_A',
    aggregated_rms   DOUBLE PRECISION NOT NULL,
    pst_flicker      DOUBLE PRECISION NOT NULL,
    is_utc_aligned   BOOLEAN NOT NULL,
    has_overlap1     BOOLEAN NOT NULL,
    CONSTRAINT pk_ten_minute_aggregated_values PRIMARY KEY (timestamp, channel_id),
    CONSTRAINT ck_ten_minute_aggregated_values_nonnegative
        CHECK (aggregated_rms >= 0 AND pst_flicker >= 0)
);

-- ---------------------------------------------------------------------------
-- 9. 2-Stunden-Aggregate: TwoHourAggregatedValue
-- Sämtliche Werte und Kennzeichnungen werden fertig berechnet übergeben.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.two_hour_aggregated_values (
    timestamp        TIMESTAMPTZ NOT NULL,
    channel_id       BIGINT NOT NULL
                     REFERENCES public.input_channels(channel_id) ON DELETE CASCADE,
    is_flagged       BOOLEAN NOT NULL,
    quality_class    public.measurement_class NOT NULL DEFAULT 'CLASS_A',
    plt_flicker      DOUBLE PRECISION NOT NULL,
    long_term_rms    DOUBLE PRECISION NOT NULL,
    CONSTRAINT pk_two_hour_aggregated_values PRIMARY KEY (timestamp, channel_id),
    CONSTRAINT ck_two_hour_aggregated_values_nonnegative
        CHECK (plt_flicker >= 0 AND long_term_rms >= 0)
);

-- Dreiphasige Spannungsunsymmetrie. Beide Komponenten werden außerhalb der
-- Datenbank bestimmt und als fertige Prozentwerte je Messgerät übergeben.
CREATE TABLE IF NOT EXISTS public.voltage_unbalance_values (
    timestamp                   TIMESTAMPTZ NOT NULL,
    meter_id                    VARCHAR(64) NOT NULL
                                REFERENCES public.meters(meter_id) ON DELETE CASCADE,
    negative_sequence_percent   DOUBLE PRECISION NOT NULL,
    zero_sequence_percent       DOUBLE PRECISION NOT NULL,
    l1_magnitude_v              DOUBLE PRECISION NOT NULL,
    l1_angle_deg                DOUBLE PRECISION NOT NULL,
    l2_magnitude_v              DOUBLE PRECISION NOT NULL,
    l2_angle_deg                DOUBLE PRECISION NOT NULL,
    l3_magnitude_v              DOUBLE PRECISION NOT NULL,
    l3_angle_deg                DOUBLE PRECISION NOT NULL,
    is_flagged                  BOOLEAN NOT NULL,
    quality_class               public.measurement_class NOT NULL,
    CONSTRAINT pk_voltage_unbalance_values PRIMARY KEY (timestamp, meter_id),
    CONSTRAINT ck_voltage_unbalance_values_nonnegative
        CHECK (
            negative_sequence_percent >= 0
            AND zero_sequence_percent >= 0
            AND l1_magnitude_v >= 0
            AND l2_magnitude_v >= 0
            AND l3_magnitude_v >= 0
            AND l1_angle_deg BETWEEN -360 AND 360
            AND l2_angle_deg BETWEEN -360 AND 360
            AND l3_angle_deg BETWEEN -360 AND 360
        )
);

-- Entfernt die verworfene Erweiterung auch aus einem bereits angelegten Schema.
DROP TABLE IF EXISTS public.mcs_voltage_values;

-- Auch bei einem vorhandenen Schema müssen Flag-Zustände explizit von der
-- Anwendung geliefert werden. Es gibt keinen datenbankseitigen Ersatzwert.
ALTER TABLE public.basic_measurement_values
    ALTER COLUMN is_flagged DROP DEFAULT;
ALTER TABLE public.short_term_aggregated_values
    ALTER COLUMN is_flagged DROP DEFAULT;
ALTER TABLE public.ten_minute_aggregated_values
    ALTER COLUMN is_flagged DROP DEFAULT;
ALTER TABLE public.two_hour_aggregated_values
    ALTER COLUMN is_flagged DROP DEFAULT;
ALTER TABLE public.voltage_unbalance_values
    ALTER COLUMN is_flagged DROP DEFAULT;

-- Ergänzt die extern gelieferten Zeigergrößen auch in vorhandenen Tabellen.
-- Die Spalten bleiben bei Altdaten NULL, bis diese durch die Messpipeline
-- nachgeliefert werden; die Datenbank leitet keine Winkel oder Beträge ab.
ALTER TABLE public.voltage_unbalance_values
    ADD COLUMN IF NOT EXISTS l1_magnitude_v DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS l1_angle_deg DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS l2_magnitude_v DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS l2_angle_deg DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS l3_magnitude_v DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS l3_angle_deg DOUBLE PRECISION;

-- ---------------------------------------------------------------------------
-- 10. Zusätzliche Constraints für bereits vorhandene Tabellen
-- CREATE TABLE IF NOT EXISTS ändert vorhandene Tabellen nicht. Dieser Block
-- ergänzt deshalb die neuen Regeln auch dann, wenn das ursprüngliche Schema
-- vorher schon angelegt wurde.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_meter_configurations_positive_values'
          AND conrelid = 'public.meter_configurations'::regclass
    ) THEN
        ALTER TABLE public.meter_configurations
            ADD CONSTRAINT ck_meter_configurations_positive_values
            CHECK (udin > 0 AND f_nominal > 0 AND hysteresis >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_input_channels_calibration_positive'
          AND conrelid = 'public.input_channels'::regclass
    ) THEN
        ALTER TABLE public.input_channels
            ADD CONSTRAINT ck_input_channels_calibration_positive
            CHECK (calibration_factor > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_transducer_configs_ratios_positive'
          AND conrelid = 'public.transducer_configs'::regclass
    ) THEN
        ALTER TABLE public.transducer_configs
            ADD CONSTRAINT ck_transducer_configs_ratios_positive
            CHECK (u_ratio > 0 AND i_ratio > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_threshold_settings_ranges'
          AND conrelid = 'public.threshold_settings'::regclass
    ) THEN
        ALTER TABLE public.threshold_settings
            ADD CONSTRAINT ck_threshold_settings_ranges
            CHECK (
                interruption_threshold >= 0
                AND interruption_threshold < dip_threshold
                AND dip_threshold < 1.0
                AND swell_threshold > 1.0
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_basic_measurement_values_ranges'
          AND conrelid = 'public.basic_measurement_values'::regclass
    ) THEN
        ALTER TABLE public.basic_measurement_values
            ADD CONSTRAINT ck_basic_measurement_values_ranges
            CHECK (rms_voltage >= 0 AND rms_current >= 0 AND frequency > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_basic_measurement_values_voltage_thds_nonnegative'
          AND conrelid = 'public.basic_measurement_values'::regclass
    ) THEN
        ALTER TABLE public.basic_measurement_values
            ADD CONSTRAINT ck_basic_measurement_values_voltage_thds_nonnegative
            CHECK (voltage_thds_percent IS NULL OR voltage_thds_percent >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_basic_measurement_values_harmonics_length'
          AND conrelid = 'public.basic_measurement_values'::regclass
    ) THEN
        ALTER TABLE public.basic_measurement_values
            ADD CONSTRAINT ck_basic_measurement_values_harmonics_length
            CHECK (harmonics IS NULL OR cardinality(harmonics) = 50);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_basic_measurement_values_interharmonics_length'
          AND conrelid = 'public.basic_measurement_values'::regclass
    ) THEN
        ALTER TABLE public.basic_measurement_values
            ADD CONSTRAINT ck_basic_measurement_values_interharmonics_length
            CHECK (interharmonics IS NULL OR cardinality(interharmonics) = 50);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_short_term_aggregated_rms_nonnegative'
          AND conrelid = 'public.short_term_aggregated_values'::regclass
    ) THEN
        ALTER TABLE public.short_term_aggregated_values
            ADD CONSTRAINT ck_short_term_aggregated_rms_nonnegative
            CHECK (aggregated_rms >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_ten_minute_aggregated_values_nonnegative'
          AND conrelid = 'public.ten_minute_aggregated_values'::regclass
    ) THEN
        ALTER TABLE public.ten_minute_aggregated_values
            ADD CONSTRAINT ck_ten_minute_aggregated_values_nonnegative
            CHECK (aggregated_rms >= 0 AND pst_flicker >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_two_hour_aggregated_values_nonnegative'
          AND conrelid = 'public.two_hour_aggregated_values'::regclass
    ) THEN
        ALTER TABLE public.two_hour_aggregated_values
            ADD CONSTRAINT ck_two_hour_aggregated_values_nonnegative
            CHECK (plt_flicker >= 0 AND long_term_rms >= 0);
    END IF;
END
$$;

-- Zusätzliche Constraints für neue Konfigurationsattribute.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_meter_configurations_max_uncertainty_positive'
          AND conrelid = 'public.meter_configurations'::regclass
    ) THEN
        ALTER TABLE public.meter_configurations
            ADD CONSTRAINT ck_meter_configurations_max_uncertainty_positive
            CHECK (max_uncertainty_ms > 0);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 11. TimescaleDB-Hypertables
-- Der Zeitstempel ist jeweils Bestandteil des Primärschlüssels. Das ist für
-- eindeutige Schlüssel auf TimescaleDB-Hypertables erforderlich.
-- migrate_data = TRUE erlaubt die Konvertierung bereits gefüllter Tabellen.
-- ---------------------------------------------------------------------------

SELECT create_hypertable(
    'public.basic_measurement_values', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

SELECT create_hypertable(
    'public.short_term_aggregated_values', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

SELECT create_hypertable(
    'public.ten_minute_aggregated_values', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

SELECT create_hypertable(
    'public.two_hour_aggregated_values', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

SELECT create_hypertable(
    'public.voltage_unbalance_values', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

-- Zeitstatus ist ebenfalls eine Zeitreihe; dadurch bleiben GPS-/UTC-Zustände
-- historisch auswertbar. Es sind zusätzliche Hypertables neben den vier Messwert-Hypertables.
SELECT create_hypertable(
    'public.time_synchronization_status', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

SELECT create_hypertable(
    'public.meter_system_states', 'timestamp',
    if_not_exists => TRUE, migrate_data => TRUE
);

-- ---------------------------------------------------------------------------
-- 12. Indizes für typische Abfragen
-- Zeitreihen werden in der Regel je Kanal und Zeitbereich abgefragt.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS ix_basic_measurement_channel_time
    ON public.basic_measurement_values (channel_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_short_term_channel_time
    ON public.short_term_aggregated_values (channel_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_ten_minute_channel_time
    ON public.ten_minute_aggregated_values (channel_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_two_hour_channel_time
    ON public.two_hour_aggregated_values (channel_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_voltage_unbalance_meter_time
    ON public.voltage_unbalance_values (meter_id, timestamp DESC);

-- Eindeutigkeit der Konfigurationshistorie auch auf bereits vorhandenen Tabellen sichern.
-- Die aufsteigenden B-Tree-Indizes können für ORDER BY valid_from DESC rückwärts gelesen werden.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meter_configurations_meter_valid_from
    ON public.meter_configurations (meter_id, valid_from);

CREATE UNIQUE INDEX IF NOT EXISTS uq_input_channels_meter_type
    ON public.input_channels (meter_id, channel_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_threshold_settings_meter_valid_from
    ON public.threshold_settings (meter_id, valid_from);

CREATE INDEX IF NOT EXISTS ix_measurement_unit_config_meter_valid
    ON public.measurement_unit_configurations (meter_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS ix_time_sync_status_meter_time
    ON public.time_synchronization_status (meter_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_meter_system_states_meter_time
    ON public.meter_system_states (meter_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_dsp_configurations_meter_valid
    ON public.dsp_configurations (meter_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS ix_pq_export_logs_meter_time
    ON public.pq_export_logs (meter_id, export_timestamp DESC);


-- ---------------------------------------------------------------------------
-- 13. Standardkonfiguration automatisch anlegen
-- Beim Einfügen eines neuen Messgeräts werden die festen Startwerte erzeugt.
-- Für bereits vorhandene Messgeräte werden fehlende Konfigurationszeilen
-- einmalig nachgetragen. Eingangskanäle werden bewusst nicht automatisch
-- erzeugt, da deren tatsächliche Hardware-Belegung festgelegt werden muss.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_default_meter_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.meter_configurations (meter_id)
    VALUES (NEW.meter_id)
    ON CONFLICT DO NOTHING;

    INSERT INTO public.threshold_settings (meter_id)
    VALUES (NEW.meter_id)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_default_meter_settings ON public.meters;

CREATE TRIGGER trg_create_default_meter_settings
AFTER INSERT ON public.meters
FOR EACH ROW
EXECUTE FUNCTION public.create_default_meter_settings();

INSERT INTO public.meter_configurations (meter_id)
SELECT m.meter_id
FROM public.meters AS m
WHERE NOT EXISTS (
    SELECT 1
    FROM public.meter_configurations AS c
    WHERE c.meter_id = m.meter_id
)
ON CONFLICT DO NOTHING;

INSERT INTO public.threshold_settings (meter_id)
SELECT m.meter_id
FROM public.meters AS m
WHERE NOT EXISTS (
    SELECT 1
    FROM public.threshold_settings AS s
    WHERE s.meter_id = m.meter_id
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 14. Datenbank-Kommentare zur fachlichen Interpretation
-- ---------------------------------------------------------------------------

COMMENT ON TABLE public.basic_measurement_values IS
    'Grundmesswerte (10/12 Perioden, ca. 200 ms) gemäß Messkonfiguration';

COMMENT ON TABLE public.short_term_aggregated_values IS
    'Kurzzeit-Aggregate (150/180 Perioden, ca. 3 s)';

COMMENT ON TABLE public.ten_minute_aggregated_values IS
    '10-Minuten-Aggregate einschließlich Pst-Flicker und UTC-Resynchronisations-Flags';

COMMENT ON TABLE public.two_hour_aggregated_values IS
    '2-Stunden-Aggregate einschließlich Plt-Flicker';

COMMENT ON COLUMN public.meter_configurations.hysteresis IS
    'Hysteresewert gemäß Anwendungsdefinition; 0.0 bedeutet deaktivierte Hysterese.';

COMMENT ON COLUMN public.threshold_settings.dip_threshold IS
    'Dip-Schwelle als relativer Wert (p.u.) bezogen auf Udin; Standard 0.90.';

COMMENT ON COLUMN public.threshold_settings.swell_threshold IS
    'Swell-Schwelle als relativer Wert (p.u.) bezogen auf Udin; Standard 1.10.';

COMMENT ON COLUMN public.threshold_settings.interruption_threshold IS
    'Interruption-Schwelle als relativer Wert (p.u.) bezogen auf Udin; Standard 0.10.';

COMMENT ON COLUMN public.basic_measurement_values.is_flagged IS
    'Extern ermittelter Flag-Zustand; muss zusammen mit dem Messwert übergeben werden.';

COMMENT ON COLUMN public.basic_measurement_values.quality_class IS
    'Messwertqualität CLASS_A oder CLASS_S.';

COMMENT ON COLUMN public.basic_measurement_values.voltage_thds_percent IS
    'Spannungs-THDS des 10/12-Zyklus-Grundintervalls in Prozent (%), vom Messgerät/DSP berechnet; NULL bedeutet nicht verfügbar.';

-- ===========================================================================
-- 15. Eventmodell gemäß UML-Seite 3 (PQEvent und Unterklassen)
--
-- Vererbung:
--   PQEvent
--     ├── TimeTriggeredEvent
--     │     ├── UTCTenMinTickEvent
--     │     ├── TwoHourTickEvent
--     │     └── OneSecondTickEvent
--     └── SampleGridTriggeredEvent
--           ├── TenTwelveCycleCompletedEvent
--           └── PQDisturbanceEvent
--                 ├── VoltageDipEvent
--                 ├── VoltageSwellEvent
--                 ├── VoltageInterruptionEvent
--                 ├── RapidVoltageChangeEvent
--                 └── VoltageTransientEvent
--
-- Die abstrakten Klassen werden als gemeinsame Basistabellen umgesetzt.
-- Konkrete Klassen erhalten jeweils eine 1:1-Subtyp-Tabelle.
-- event_source bleibt VARCHAR, da das PDF keine Enum-Ausprägungen nennt.
-- event_id verwendet BIGINT (positiver signed-64-bit-Bereich); PostgreSQL
-- BIGINT kann den vollständigen uint64_t-Bereich des UML nicht abbilden.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.pq_events (
    event_id      BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    timestamp     TIMESTAMPTZ NOT NULL,
    event_source  VARCHAR(64) NOT NULL,
    event_type    public.pq_event_type NOT NULL,
    CONSTRAINT ck_pq_events_event_source_not_empty
        CHECK (length(trim(event_source)) > 0)
);

CREATE INDEX IF NOT EXISTS ix_pq_events_timestamp
    ON public.pq_events (timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_pq_events_type_timestamp
    ON public.pq_events (event_type, timestamp DESC);

-- Abstrakte Basisklasse: TimeTriggeredEvent.
CREATE TABLE IF NOT EXISTS public.time_triggered_events (
    event_id          BIGINT PRIMARY KEY
                      REFERENCES public.pq_events(event_id) ON DELETE CASCADE,
    utc_time          TIMESTAMPTZ NOT NULL,
    is_resynchronized BOOLEAN NOT NULL DEFAULT FALSE
);

-- Abstrakte Basisklasse: SampleGridTriggeredEvent.
-- PhaseEnum wird als VARCHAR geführt, weil das PDF keine Enum-Werte definiert.
CREATE TABLE IF NOT EXISTS public.sample_grid_triggered_events (
    event_id    BIGINT PRIMARY KEY
                REFERENCES public.pq_events(event_id) ON DELETE CASCADE,
    channel_id  BIGINT NOT NULL
                REFERENCES public.input_channels(channel_id) ON DELETE RESTRICT,
    phase       VARCHAR(16) NOT NULL,
    CONSTRAINT ck_sample_grid_phase_not_empty
        CHECK (length(trim(phase)) > 0)
);

-- Konkrete zeitgetriggerte Ereignisse.
CREATE TABLE IF NOT EXISTS public.utc_ten_minute_tick_events (
    event_id        BIGINT PRIMARY KEY
                    REFERENCES public.time_triggered_events(event_id) ON DELETE CASCADE,
    interval_index  NUMERIC(10,0) NOT NULL,
    overlap1_count  SMALLINT NOT NULL,
    overlap2_active BOOLEAN NOT NULL,
    CONSTRAINT ck_utc_tick_interval_index_uint32
        CHECK (interval_index BETWEEN 0 AND 4294967295),
    CONSTRAINT ck_utc_tick_overlap1_count_uint8
        CHECK (overlap1_count BETWEEN 0 AND 255)
);

CREATE TABLE IF NOT EXISTS public.two_hour_tick_events (
    event_id     BIGINT PRIMARY KEY
                 REFERENCES public.time_triggered_events(event_id) ON DELETE CASCADE,
    block_index  NUMERIC(10,0) NOT NULL,
    CONSTRAINT ck_two_hour_block_index_uint32
        CHECK (block_index BETWEEN 0 AND 4294967295)
);

CREATE TABLE IF NOT EXISTS public.one_second_tick_events (
    event_id          BIGINT PRIMARY KEY
                      REFERENCES public.time_triggered_events(event_id) ON DELETE CASCADE,
    system_uptime_sec NUMERIC(20,0) NOT NULL,
    CONSTRAINT ck_one_second_uptime_uint64
        CHECK (system_uptime_sec BETWEEN 0 AND 18446744073709551615)
);

-- Konkretes sample-grid-getriggertes Ereignis.
CREATE TABLE IF NOT EXISTS public.ten_twelve_cycle_completed_events (
    event_id       BIGINT PRIMARY KEY
                   REFERENCES public.sample_grid_triggered_events(event_id) ON DELETE CASCADE,
    cycle_count    SMALLINT NOT NULL,
    calculated_rms DOUBLE PRECISION NOT NULL,
    CONSTRAINT ck_cycle_count_uint8
        CHECK (cycle_count BETWEEN 0 AND 255),
    CONSTRAINT ck_cycle_calculated_rms_nonnegative
        CHECK (calculated_rms >= 0)
);

-- Abstrakte Basisklasse für Spannungsstörungen.
-- Sie erbt fachlich von SampleGridTriggeredEvent.
CREATE TABLE IF NOT EXISTS public.pq_disturbance_events (
    event_id           BIGINT PRIMARY KEY
                       REFERENCES public.sample_grid_triggered_events(event_id) ON DELETE CASCADE,
    threshold_value    DOUBLE PRECISION NOT NULL,
    actual_extreme_value DOUBLE PRECISION NOT NULL,
    duration_ms        NUMERIC(10,0) NOT NULL,
    flag_cause         public.pq_flag_cause NOT NULL,
    CONSTRAINT ck_pq_disturbance_values_nonnegative
        CHECK (threshold_value >= 0 AND actual_extreme_value >= 0),
    CONSTRAINT ck_pq_disturbance_duration_uint32
        CHECK (duration_ms BETWEEN 0 AND 4294967295)
);

CREATE TABLE IF NOT EXISTS public.voltage_dip_events (
    event_id             BIGINT PRIMARY KEY
                         REFERENCES public.pq_disturbance_events(event_id) ON DELETE CASCADE,
    dip_residual_voltage DOUBLE PRECISION NOT NULL,
    CONSTRAINT ck_voltage_dip_residual_nonnegative
        CHECK (dip_residual_voltage >= 0)
);

CREATE TABLE IF NOT EXISTS public.voltage_swell_events (
    event_id          BIGINT PRIMARY KEY
                      REFERENCES public.pq_disturbance_events(event_id) ON DELETE CASCADE,
    swell_peak_voltage DOUBLE PRECISION NOT NULL,
    CONSTRAINT ck_voltage_swell_peak_nonnegative
        CHECK (swell_peak_voltage >= 0)
);

CREATE TABLE IF NOT EXISTS public.voltage_interruption_events (
    event_id             BIGINT PRIMARY KEY
                         REFERENCES public.pq_disturbance_events(event_id) ON DELETE CASCADE,
    interruption_voltage DOUBLE PRECISION NOT NULL,
    CONSTRAINT ck_voltage_interruption_voltage_nonnegative
        CHECK (interruption_voltage >= 0)
);

-- RVC ist ein eigenständiger Ereignistyp und keine Eigenschaft einer
-- Spannungsunterbrechung. Alle Kennwerte werden fertig ermittelt übergeben.
CREATE TABLE IF NOT EXISTS public.rapid_voltage_change_events (
    event_id                     BIGINT PRIMARY KEY
                                 REFERENCES public.sample_grid_triggered_events(event_id) ON DELETE CASCADE,
    duration_ms                  NUMERIC(10,3) NOT NULL,
    voltage_change_percent       DOUBLE PRECISION NOT NULL,
    steady_state_before_voltage  DOUBLE PRECISION NOT NULL,
    steady_state_after_voltage   DOUBLE PRECISION NOT NULL,
    phase_angle_before_deg       DOUBLE PRECISION NOT NULL,
    phase_angle_after_deg        DOUBLE PRECISION NOT NULL,
    max_voltage_deviation_percent DOUBLE PRECISION NOT NULL,
    is_flagged                   BOOLEAN NOT NULL,
    CONSTRAINT ck_rapid_voltage_change_values_nonnegative
        CHECK (
            duration_ms >= 0
            AND voltage_change_percent >= 0
            AND steady_state_before_voltage >= 0
            AND steady_state_after_voltage >= 0
            AND phase_angle_before_deg BETWEEN -360 AND 360
            AND phase_angle_after_deg BETWEEN -360 AND 360
            AND max_voltage_deviation_percent >= 0
        )
);

ALTER TABLE public.rapid_voltage_change_events
    ADD COLUMN IF NOT EXISTS phase_angle_before_deg DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS phase_angle_after_deg DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS public.voltage_transient_events (
    event_id               BIGINT PRIMARY KEY
                           REFERENCES public.sample_grid_triggered_events(event_id) ON DELETE CASCADE,
    peak_voltage            DOUBLE PRECISION NOT NULL,
    rise_time_us            DOUBLE PRECISION NOT NULL,
    transient_duration_us   DOUBLE PRECISION NOT NULL,
    polarity                SMALLINT NOT NULL,
    is_flagged              BOOLEAN NOT NULL,
    CONSTRAINT ck_voltage_transient_values
        CHECK (
            rise_time_us >= 0
            AND transient_duration_us >= 0
            AND polarity IN (-1, 1)
        )
);

-- Ein vorhandenes Legacy-Feld is_rvc wird nicht mehr verwendet. Es wird aus
-- Rücksicht auf bestehende Daten nicht automatisch gelöscht.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'voltage_interruption_events'
           AND column_name = 'is_rvc'
    ) THEN
        ALTER TABLE public.voltage_interruption_events
            ALTER COLUMN is_rvc DROP NOT NULL;
        COMMENT ON COLUMN public.voltage_interruption_events.is_rvc IS
            'Legacy-Feld; RVC wird als eigenständiges rapid_voltage_change_event gespeichert.';
    END IF;
END
$$;

-- Sichert die fachliche Zuordnung zwischen konkretem Störungstyp und Ursache.
CREATE OR REPLACE FUNCTION public.validate_pq_disturbance_flag_cause()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_event_type TEXT;
    v_expected_cause TEXT;
BEGIN
    SELECT e.event_type::TEXT
      INTO v_event_type
      FROM public.pq_events AS e
     WHERE e.event_id = NEW.event_id;

    v_expected_cause := CASE v_event_type
        WHEN 'VOLTAGE_DIP' THEN 'DIP_THRESHOLD_VIOLATION'
        WHEN 'VOLTAGE_SWELL' THEN 'SWELL_THRESHOLD_VIOLATION'
        WHEN 'VOLTAGE_INTERRUPTION' THEN 'INTERRUPTION_THRESHOLD_VIOLATION'
        ELSE NULL
    END;

    IF v_expected_cause IS NULL OR NEW.flag_cause::TEXT <> v_expected_cause THEN
        RAISE EXCEPTION
            'Flag-Ursache % passt nicht zum PQEvent-Typ % (Event %)',
            NEW.flag_cause, v_event_type, NEW.event_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_pq_disturbance_flag_cause
    ON public.pq_disturbance_events;
CREATE TRIGGER trg_validate_pq_disturbance_flag_cause
BEFORE INSERT OR UPDATE ON public.pq_disturbance_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_disturbance_flag_cause();

-- Prüft, ob eine konkrete Unterklasse zum event_type der PQEvent-Basisklasse
-- passt. Die Werte kommen aus dem UML und verhindern inkonsistente Subtypen.
CREATE OR REPLACE FUNCTION public.validate_pq_event_subtype()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_event_type TEXT;
BEGIN
    SELECT e.event_type::TEXT
      INTO v_event_type
      FROM public.pq_events AS e
     WHERE e.event_id = NEW.event_id;

    IF v_event_type IS NULL THEN
        RAISE EXCEPTION 'PQEvent % existiert nicht', NEW.event_id;
    END IF;

    IF v_event_type <> TG_ARGV[0] THEN
        RAISE EXCEPTION
            'Event % hat event_type %, erwartet wurde %',
            NEW.event_id, v_event_type, TG_ARGV[0];
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_utc_ten_minute_tick_type
    ON public.utc_ten_minute_tick_events;
CREATE TRIGGER trg_validate_utc_ten_minute_tick_type
BEFORE INSERT OR UPDATE ON public.utc_ten_minute_tick_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('UTC_TEN_MINUTE_TICK');

DROP TRIGGER IF EXISTS trg_validate_two_hour_tick_type
    ON public.two_hour_tick_events;
CREATE TRIGGER trg_validate_two_hour_tick_type
BEFORE INSERT OR UPDATE ON public.two_hour_tick_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('TWO_HOUR_TICK');

DROP TRIGGER IF EXISTS trg_validate_one_second_tick_type
    ON public.one_second_tick_events;
CREATE TRIGGER trg_validate_one_second_tick_type
BEFORE INSERT OR UPDATE ON public.one_second_tick_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('ONE_SECOND_TICK');

DROP TRIGGER IF EXISTS trg_validate_ten_twelve_cycle_type
    ON public.ten_twelve_cycle_completed_events;
CREATE TRIGGER trg_validate_ten_twelve_cycle_type
BEFORE INSERT OR UPDATE ON public.ten_twelve_cycle_completed_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('TEN_TWELVE_CYCLE_COMPLETED');

DROP TRIGGER IF EXISTS trg_validate_voltage_dip_type
    ON public.voltage_dip_events;
CREATE TRIGGER trg_validate_voltage_dip_type
BEFORE INSERT OR UPDATE ON public.voltage_dip_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('VOLTAGE_DIP');

DROP TRIGGER IF EXISTS trg_validate_voltage_swell_type
    ON public.voltage_swell_events;
CREATE TRIGGER trg_validate_voltage_swell_type
BEFORE INSERT OR UPDATE ON public.voltage_swell_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('VOLTAGE_SWELL');

DROP TRIGGER IF EXISTS trg_validate_voltage_interruption_type
    ON public.voltage_interruption_events;
CREATE TRIGGER trg_validate_voltage_interruption_type
BEFORE INSERT OR UPDATE ON public.voltage_interruption_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('VOLTAGE_INTERRUPTION');

DROP TRIGGER IF EXISTS trg_validate_rapid_voltage_change_type
    ON public.rapid_voltage_change_events;
CREATE TRIGGER trg_validate_rapid_voltage_change_type
BEFORE INSERT OR UPDATE ON public.rapid_voltage_change_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('RAPID_VOLTAGE_CHANGE');

DROP TRIGGER IF EXISTS trg_validate_voltage_transient_type
    ON public.voltage_transient_events;
CREATE TRIGGER trg_validate_voltage_transient_type
BEFORE INSERT OR UPDATE ON public.voltage_transient_events
FOR EACH ROW EXECUTE FUNCTION public.validate_pq_event_subtype('VOLTAGE_TRANSIENT');

-- ===========================================================================
-- 16. Flag-Fortpflanzung gemäß Ablaufdiagramm auf PDF-Seite 1
--
-- Die Eventerkennung und die zeitliche Zuordnung der betroffenen Intervalle
-- erfolgt in der Anwendung/Aggregationspipeline. Die Datenbank speichert
-- die vollständig übergebenen direkten bzw. fortgepflanzten Kennzeichnungen.
-- is_flagged wird ebenfalls durch die Anwendung übergeben.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.pq_flag_propagations (
    flag_id                  BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    source_event_id          BIGINT NOT NULL
                             CONSTRAINT fk_pq_flag_propagations_source_event
                             REFERENCES public.pq_events(event_id) ON DELETE RESTRICT,
    channel_id               BIGINT NOT NULL
                             REFERENCES public.input_channels(channel_id) ON DELETE RESTRICT,
    target_level             public.pq_measurement_level NOT NULL,
    value_timestamp          TIMESTAMPTZ NOT NULL,
    is_propagated            BOOLEAN NOT NULL,
    propagated_from_level    public.pq_measurement_level,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pq_flag_propagations_target
        UNIQUE (source_event_id, target_level, value_timestamp, channel_id),
    CONSTRAINT ck_pq_flag_propagation_origin
        CHECK (
            (is_propagated = FALSE AND propagated_from_level IS NULL)
            OR
            (is_propagated = TRUE
             AND propagated_from_level IS NOT NULL
             AND target_level > propagated_from_level)
        )
);

-- Migriert die frühere Einschränkung auf klassische Störungsereignisse, ohne
-- Daten zu verändern. Damit können auch RVC- und Transienten-Flags referenziert werden.
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    FOR v_constraint_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.pq_flag_propagations'::regclass
           AND confrelid = 'public.pq_disturbance_events'::regclass
           AND contype = 'f'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.pq_flag_propagations DROP CONSTRAINT %I',
            v_constraint_name
        );
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.pq_flag_propagations'::regclass
           AND conname = 'fk_pq_flag_propagations_source_event'
    ) THEN
        ALTER TABLE public.pq_flag_propagations
            ADD CONSTRAINT fk_pq_flag_propagations_source_event
            FOREIGN KEY (source_event_id)
            REFERENCES public.pq_events(event_id) ON DELETE RESTRICT;
    END IF;
END
$$;

ALTER TABLE public.pq_flag_propagations
    ALTER COLUMN is_propagated DROP DEFAULT;

CREATE INDEX IF NOT EXISTS ix_pq_flag_propagations_channel_time
    ON public.pq_flag_propagations (channel_id, value_timestamp DESC);

CREATE INDEX IF NOT EXISTS ix_pq_flag_propagations_event
    ON public.pq_flag_propagations (source_event_id);

-- Bereinigungsblock für ein eventuell bereits installiertes Vorgängerschema.
-- Flag-Zustand und Fortpflanzungsdaten müssen künftig von der Anwendung in
-- einer gemeinsamen Transaktion vollständig übergeben werden.
DROP TRIGGER IF EXISTS trg_set_measurement_flag_from_propagation
    ON public.pq_flag_propagations;
DROP FUNCTION IF EXISTS public.set_measurement_flag_from_propagation();
DROP FUNCTION IF EXISTS public.apply_pq_flag(
    BIGINT,
    public.pq_measurement_level,
    TIMESTAMPTZ,
    BIGINT,
    public.pq_measurement_level
);

-- ===========================================================================
-- 17. Keine fachlich berechnenden Datenbank-Views
--
-- Die folgenden Views aus dem Vorgängerschema erzeugten abgeleitete Zähler,
-- Konfigurationszuordnungen oder Zeitdifferenzen. Diese Ergebnisse werden nun
-- von der Anwendung berechnet und bei Bedarf als fertige Werte übergeben.
-- ===========================================================================

DROP VIEW IF EXISTS public.v_active_flag_count;
DROP VIEW IF EXISTS public.v_evaluation_unit_values;
DROP VIEW IF EXISTS public.v_time_triggered_event_offsets;

-- ===========================================================================
-- 18. Fachliche Kommentare zu den neuen Tabellen
-- ===========================================================================

COMMENT ON TABLE public.measurement_unit_configurations IS
    'MeasurementUnit: Hardware-Abtastrate und Polyphasenbetrieb mit Historie.';

COMMENT ON TABLE public.communication_configurations IS
    'ICommunicationInterface: Portnummer und verwendetes Kommunikationsprotokoll.';

COMMENT ON TABLE public.meter_system_states IS
    'PQMeterController: historischer Systemzustand und Systemlaufzeit.';

COMMENT ON TABLE public.dsp_configurations IS
    'DSP-Konfiguration: Puffergröße und FFT-Bin-Anzahl; Startwerte sind vorläufige Implementierungswerte.';

COMMENT ON TABLE public.pq_export_logs IS
    'Protokolliert PQDIF- und weitere Messdatenexporte.';

COMMENT ON TABLE public.time_synchronization_status IS
    'GPSReceiver/ITimeSynchronization: UTC-Lock, PPS-Status und Satellitenzahl als Zeitreihe.';

COMMENT ON TABLE public.pq_events IS
    'PQEvent-Basisklasse: gemeinsame Identität, Ereigniszeit, Quelle und konkreter Ereignistyp.';

COMMENT ON TABLE public.time_triggered_events IS
    'Abstrakte TimeTriggeredEvent-Basisklasse mit UTC-Zeit und Resynchronisationsstatus.';

COMMENT ON TABLE public.sample_grid_triggered_events IS
    'Abstrakte SampleGridTriggeredEvent-Basisklasse mit Messkanal und Phase.';

COMMENT ON TABLE public.pq_disturbance_events IS
    'Abstrakte PQDisturbanceEvent-Basisklasse mit Schwelle, Extremwert, Dauer und Flag-Ursache.';

COMMENT ON TABLE public.voltage_unbalance_values IS
    'Extern berechnete Spannungsunsymmetrie mit übergebenen L1/L2/L3-Zeigerbeträgen und -winkeln.';

COMMENT ON TABLE public.rapid_voltage_change_events IS
    'Eigenständige, extern erkannte RVC-Ereignisse mit übergebenen stationären Spannungswerten.';

COMMENT ON TABLE public.voltage_transient_events IS
    'Extern erkannte Spannungstransienten mit Spitze, Anstiegszeit, Dauer und Polarität.';

COMMENT ON TABLE public.pq_flag_propagations IS
    'Auditierbare direkte und fortgepflanzte Flag-Kennzeichnungen über alle Messwertstufen.';

COMMENT ON COLUMN public.meter_configurations.max_uncertainty_ms IS
    'Maximal zulässige UTC-Zeitunsicherheit in ms; Startwert 20 ms gemäß Zeitgenauigkeit im PDF.';

COMMENT ON COLUMN public.utc_ten_minute_tick_events.overlap1_count IS
    'Anzahl der für Overlap 1 berücksichtigten Zyklen am UTC-10-Minuten-Tick.';

COMMENT ON COLUMN public.utc_ten_minute_tick_events.overlap2_active IS
    'Kennzeichnet den parallelen Overlap-2-Lauf am UTC-10-Minuten-Tick.';

COMMENT ON COLUMN public.ten_twelve_cycle_completed_events.calculated_rms IS
    'Außerhalb der Datenbank berechneter und vollständig übergebener RMS-Wert.';

COMMENT ON COLUMN public.ten_minute_aggregated_values.timestamp IS
    'Zeitstempel des Intervallendes gemäß Ablaufdiagramm.';

COMMIT;
