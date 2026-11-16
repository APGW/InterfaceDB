WITH
meter_channels AS (
    SELECT channel_id, channel_type::text AS phase
      FROM public.input_channels
     WHERE meter_id = $1
       AND channel_type IN ('L1', 'L2', 'L3')
),
voltage_ts AS (
    SELECT DISTINCT b.timestamp
      FROM public.basic_measurement_values AS b
      JOIN meter_channels AS c USING (channel_id)
     WHERE b.timestamp > to_timestamp($2::double precision / 1000.0)
     ORDER BY b.timestamp ASC
     LIMIT $7
),
voltage_rows AS (
    SELECT b.timestamp,
           c.phase,
           b.rms_voltage,
           COALESCE(b.rms_voltage_min, b.rms_voltage) AS rms_voltage_min,
           COALESCE(b.rms_voltage_max, b.rms_voltage) AS rms_voltage_max,
           b.voltage_thds_percent,
           b.frequency,
           b.is_flagged
      FROM public.basic_measurement_values AS b
      JOIN meter_channels AS c USING (channel_id)
      JOIN voltage_ts AS selected USING (timestamp)
),
event_rows AS (
    SELECT e.event_id,
           e.timestamp,
           c.phase,
           CASE e.event_type::text
               WHEN 'VOLTAGE_DIP' THEN 'Voltage Dip'
               WHEN 'VOLTAGE_SWELL' THEN 'Voltage Swell'
               WHEN 'VOLTAGE_INTERRUPTION' THEN 'Voltage Interruption'
               WHEN 'RAPID_VOLTAGE_CHANGE' THEN 'Rapid Voltage Change'
               WHEN 'VOLTAGE_TRANSIENT' THEN 'Spannungstransient'
           END AS display_type,
           COALESCE(d.duration_ms::double precision, r.duration_ms::double precision) AS duration_ms,
           t.transient_duration_us,
           vd.dip_residual_voltage
      FROM public.pq_events AS e
      JOIN public.sample_grid_triggered_events AS sg USING (event_id)
      JOIN meter_channels AS c USING (channel_id)
      LEFT JOIN public.pq_disturbance_events AS d USING (event_id)
      LEFT JOIN public.voltage_dip_events AS vd USING (event_id)
      LEFT JOIN public.rapid_voltage_change_events AS r USING (event_id)
      LEFT JOIN public.voltage_transient_events AS t USING (event_id)
     WHERE e.event_id > $3
       AND e.event_type IN (
           'VOLTAGE_DIP',
           'VOLTAGE_SWELL',
           'VOLTAGE_INTERRUPTION',
           'RAPID_VOLTAGE_CHANGE',
           'VOLTAGE_TRANSIENT'
       )
     ORDER BY e.event_id ASC
     LIMIT $7
),
unbalance_rows AS (
    SELECT u.*
      FROM public.voltage_unbalance_values AS u
     WHERE u.meter_id = $1
       AND u.timestamp > to_timestamp($4::double precision / 1000.0)
     ORDER BY u.timestamp ASC
     LIMIT $7
),
ten_rows AS (
    SELECT DISTINCT ON (t.timestamp) t.*
      FROM public.ten_minute_aggregated_values AS t
      JOIN meter_channels AS c USING (channel_id)
     WHERE t.timestamp > to_timestamp($5::double precision / 1000.0)
     ORDER BY t.timestamp ASC, c.phase
     LIMIT $7
),
two_rows AS (
    SELECT DISTINCT ON (t.timestamp) t.*
      FROM public.two_hour_aggregated_values AS t
      JOIN meter_channels AS c USING (channel_id)
     WHERE t.timestamp > to_timestamp($6::double precision / 1000.0)
     ORDER BY t.timestamp ASC, c.phase
     LIMIT $7
),
quality_ts AS (
    SELECT timestamp FROM voltage_ts
    UNION
    SELECT timestamp FROM ten_rows
    UNION
    SELECT timestamp FROM two_rows
),
quality_rows AS (
    SELECT q.timestamp,
           (
               SELECT b.frequency
                 FROM public.basic_measurement_values AS b
                 JOIN meter_channels AS c USING (channel_id)
                WHERE b.timestamp <= q.timestamp
                ORDER BY b.timestamp DESC, c.phase
                LIMIT 1
           ) AS frequency_hz,
           (
               SELECT t.pst_flicker
                 FROM public.ten_minute_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
                WHERE t.timestamp <= q.timestamp
                ORDER BY t.timestamp DESC, c.phase
                LIMIT 1
           ) AS pst,
           (
               SELECT t.plt_flicker
                 FROM public.two_hour_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
                WHERE t.timestamp <= q.timestamp
                ORDER BY t.timestamp DESC, c.phase
                LIMIT 1
           ) AS plt,
           (
               SELECT t.long_term_rms
                 FROM public.two_hour_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
                WHERE t.timestamp <= q.timestamp
                ORDER BY t.timestamp DESC, c.phase
                LIMIT 1
           ) AS long_term_rms
      FROM quality_ts AS q
),
threshold_config AS (
    SELECT COALESCE((
               SELECT c.udin
                 FROM public.meter_configurations AS c
                WHERE c.meter_id = $1
                ORDER BY c.valid_from DESC
                LIMIT 1
           ), 230.0) AS udin,
           COALESCE((
               SELECT s.dip_threshold
                 FROM public.threshold_settings AS s
                WHERE s.meter_id = $1
                ORDER BY s.valid_from DESC
                LIMIT 1
           ), 0.90) AS dip_factor,
           COALESCE((
               SELECT s.swell_threshold
                 FROM public.threshold_settings AS s
                WHERE s.meter_id = $1
                ORDER BY s.valid_from DESC
                LIMIT 1
           ), 1.10) AS swell_factor
),
next_cursor AS (
    SELECT COALESCE((SELECT floor(extract(epoch FROM max(timestamp)) * 1000)::bigint FROM voltage_ts), $2::bigint) AS voltage_ms,
           COALESCE((SELECT max(event_id) FROM event_rows), $3::bigint) AS event_id,
           COALESCE((SELECT floor(extract(epoch FROM max(timestamp)) * 1000)::bigint FROM unbalance_rows), $4::bigint) AS unbalance_ms,
           COALESCE((SELECT floor(extract(epoch FROM max(timestamp)) * 1000)::bigint FROM ten_rows), $5::bigint) AS ten_ms,
           COALESCE((SELECT floor(extract(epoch FROM max(timestamp)) * 1000)::bigint FROM two_rows), $6::bigint) AS two_ms
),
database_state AS (
    SELECT (
               SELECT min(b.timestamp)
                 FROM public.basic_measurement_values AS b
                 JOIN meter_channels AS c USING (channel_id)
           ) AS first_voltage,
           (
               SELECT min(e.event_id)
                 FROM public.pq_events AS e
                 JOIN public.sample_grid_triggered_events AS sg USING (event_id)
                 JOIN meter_channels AS c USING (channel_id)
                WHERE e.event_type IN (
                    'VOLTAGE_DIP', 'VOLTAGE_SWELL', 'VOLTAGE_INTERRUPTION',
                    'RAPID_VOLTAGE_CHANGE', 'VOLTAGE_TRANSIENT'
                )
           ) AS first_event_id,
           (
               SELECT min(u.timestamp)
                 FROM public.voltage_unbalance_values AS u
                WHERE u.meter_id = $1
           ) AS first_unbalance,
           (
               SELECT min(t.timestamp)
                 FROM public.ten_minute_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
           ) AS first_ten,
           (
               SELECT min(t.timestamp)
                 FROM public.two_hour_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
           ) AS first_two,
           (
               SELECT max(b.timestamp)
                 FROM public.basic_measurement_values AS b
                 JOIN meter_channels AS c USING (channel_id)
           ) AS last_seen
),
more_state AS (
    SELECT EXISTS (
               SELECT 1
                 FROM public.basic_measurement_values AS b
                 JOIN meter_channels AS c USING (channel_id)
                WHERE b.timestamp > to_timestamp(n.voltage_ms::double precision / 1000.0)
           )
           OR EXISTS (
               SELECT 1
                 FROM public.pq_events AS e
                 JOIN public.sample_grid_triggered_events AS sg USING (event_id)
                 JOIN meter_channels AS c USING (channel_id)
                WHERE e.event_id > n.event_id
                  AND e.event_type IN (
                      'VOLTAGE_DIP', 'VOLTAGE_SWELL', 'VOLTAGE_INTERRUPTION',
                      'RAPID_VOLTAGE_CHANGE', 'VOLTAGE_TRANSIENT'
                  )
           )
           OR EXISTS (
               SELECT 1
                 FROM public.voltage_unbalance_values AS u
                WHERE u.meter_id = $1
                  AND u.timestamp > to_timestamp(n.unbalance_ms::double precision / 1000.0)
           )
           OR EXISTS (
               SELECT 1
                 FROM public.ten_minute_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
                WHERE t.timestamp > to_timestamp(n.ten_ms::double precision / 1000.0)
           )
           OR EXISTS (
               SELECT 1
                 FROM public.two_hour_aggregated_values AS t
                 JOIN meter_channels AS c USING (channel_id)
                WHERE t.timestamp > to_timestamp(n.two_ms::double precision / 1000.0)
           ) AS has_more
      FROM next_cursor AS n
)
SELECT jsonb_build_object(
    'cursor', concat(n.voltage_ms, '.', n.event_id, '.', n.unbalance_ms, '.', n.ten_ms, '.', n.two_ms),
    'firstSequence', least(
        COALESCE((SELECT floor(extract(epoch FROM min(timestamp)) * 1000)::bigint FROM voltage_ts), n.voltage_ms),
        COALESCE((SELECT floor(extract(epoch FROM min(timestamp)) * 1000)::bigint FROM unbalance_rows), n.unbalance_ms),
        COALESCE((SELECT floor(extract(epoch FROM min(timestamp)) * 1000)::bigint FROM ten_rows), n.ten_ms),
        COALESCE((SELECT floor(extract(epoch FROM min(timestamp)) * 1000)::bigint FROM two_rows), n.two_ms)
    ),
    'lastSequence', greatest(
        n.voltage_ms,
        n.unbalance_ms,
        n.ten_ms,
        n.two_ms,
        COALESCE((SELECT floor(extract(epoch FROM max(timestamp)) * 1000)::bigint FROM event_rows), 0)
    ),
    'retentionStartSequence', COALESCE(floor(extract(epoch FROM state.first_voltage) * 1000)::bigint, 0),
    'hasMore', more.has_more,
    'cursorGapDetected', (
        $2::bigint > 0
        AND state.first_voltage IS NOT NULL
        AND $2::bigint < floor(extract(epoch FROM state.first_voltage) * 1000)::bigint
    ) OR (
        $3::bigint > 0
        AND state.first_event_id IS NOT NULL
        AND $3::bigint < state.first_event_id
    ) OR (
        $4::bigint > 0
        AND state.first_unbalance IS NOT NULL
        AND $4::bigint < floor(extract(epoch FROM state.first_unbalance) * 1000)::bigint
    ) OR (
        $5::bigint > 0
        AND state.first_ten IS NOT NULL
        AND $5::bigint < floor(extract(epoch FROM state.first_ten) * 1000)::bigint
    ) OR (
        $6::bigint > 0
        AND state.first_two IS NOT NULL
        AND $6::bigint < floor(extract(epoch FROM state.first_two) * 1000)::bigint
    ),
    'lastSeen', CASE WHEN state.last_seen IS NULL THEN NULL ELSE to_char(state.last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'thresholdConfig', jsonb_build_object(
        'nominalVoltage', cfg.udin,
        'dipFactor', cfg.dip_factor,
        'swellFactor', cfg.swell_factor
    ),
    'voltage', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'timestamp', to_char(v.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'phase', v.phase,
            'rmsAvg', v.rms_voltage,
            'rmsMin', v.rms_voltage_min,
            'rmsMax', v.rms_voltage_max,
            'voltageThdsPercent', v.voltage_thds_percent,
            'frequencyHz', v.frequency,
            'isFlagged', v.is_flagged,
            'sequence', floor(extract(epoch FROM v.timestamp) * 1000)::bigint
        ) ORDER BY v.timestamp, v.phase)
          FROM voltage_rows AS v
    ), '[]'::jsonb),
    'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'id', e.event_id::text,
            'timestamp', to_char(e.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'type', e.display_type,
            'phase', e.phase,
            'durationMs', e.duration_ms,
            'durationUs', e.transient_duration_us,
            'dipResidualVoltage', e.dip_residual_voltage,
            'sequence', e.event_id
        ) ORDER BY e.timestamp, e.event_id)
          FROM event_rows AS e
    ), '[]'::jsonb),
    'unbalance', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'timestamp', to_char(u.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'negativePercent', u.negative_sequence_percent,
            'zeroPercent', u.zero_sequence_percent,
            'phasors', jsonb_build_array(
                jsonb_build_object('phase', 'L1', 'magnitude', u.l1_magnitude_v, 'angleDeg', u.l1_angle_deg),
                jsonb_build_object('phase', 'L2', 'magnitude', u.l2_magnitude_v, 'angleDeg', u.l2_angle_deg),
                jsonb_build_object('phase', 'L3', 'magnitude', u.l3_magnitude_v, 'angleDeg', u.l3_angle_deg)
            ),
            'sequence', floor(extract(epoch FROM u.timestamp) * 1000)::bigint
        ) ORDER BY u.timestamp)
          FROM unbalance_rows AS u
    ), '[]'::jsonb),
    'quality', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'timestamp', to_char(q.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'frequencyHz', q.frequency_hz,
            'pst', q.pst,
            'plt', q.plt,
            'longTermRms', q.long_term_rms,
            'sequence', floor(extract(epoch FROM q.timestamp) * 1000)::bigint
        ) ORDER BY q.timestamp)
          FROM quality_rows AS q
    ), '[]'::jsonb)
)::text AS payload
  FROM next_cursor AS n
 CROSS JOIN database_state AS state
 CROSS JOIN more_state AS more
 CROSS JOIN threshold_config AS cfg;
