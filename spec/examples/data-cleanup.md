---
air: 0
effort: M
harness: [any]
model: medium
context:
  url: https://github.com/acme-analytics/ai-requests/releases/download/air-context/sensor-exports-2026-q3.zip
  sha256: 09c551c9034775c6f51f9d5a3b6134c70d50c04bf4d745d704a116fbabff2706
  bytes: 48211960
  expires: 2026-12-31
setup:
  - python3 -m venv .venv
  - .venv/bin/pip install --quiet pandas==2.2.3 pyarrow==18.1.0
check: .venv/bin/python -c "import pandas, pyarrow"
deliver: artifact
timeout: 2h
---

## Task

Clean three months of temperature-sensor exports into one tidy table.

The context zip holds one CSV per sensor per month, exported by two generations of logger firmware with
different formats (described under Context). Produce:

- `$AIR_OUT/readings.parquet` with columns `sensor_id` (string), `ts_utc` (timestamp, UTC),
  `temp_c` (float64), `source_file` (string), sorted by `sensor_id, ts_utc`.
- `$AIR_OUT/clean.py`: the script that builds it from `$AIR_CONTEXT`, runnable from the workspace with
  `.venv/bin/python out/clean.py` and no arguments.
- `$AIR_OUT/REPORT.md`: rows read, rows written, and a table of rows dropped per reason per sensor.

Rules:

- Convert Fahrenheit to Celsius; round to 2 decimals.
- Drop exact duplicates (same sensor, timestamp, value). If one sensor has two different values at the same
  timestamp, keep the one from the newer firmware file and count the other as "conflict".
- Drop readings below -40 °C or above 85 °C (the sensors' rated range) as "out of range".
- Keep gaps as gaps; don't interpolate.

## Done when

- `readings.parquet` loads with `pandas.read_parquet` and has exactly the four columns and dtypes above.
- No `(sensor_id, ts_utc)` pair appears twice.
- Running `clean.py` again from scratch reproduces `readings.parquet` byte-for-byte.
- `REPORT.md` row counts add up: read = written + sum of dropped.

## Context

`sensor-exports/` contains `<sensor_id>_<YYYY-MM>.csv` for 2026-08 to 2026-10, 41 sensors.

- Firmware 1.x files start with a `# fw=1.x` comment line, use `;` as separator, local time
  `DD.MM.YYYY HH:MM` in Europe/Berlin, and `temp_f`.
- Firmware 2.x files have a header `timestamp,temp_c` with ISO 8601 UTC timestamps.
- `sensors.csv` maps `sensor_id` to the firmware it ran each month; a few sensors were upgraded mid-month,
  so files for that month mix both formats after a second header line.

## Notes

The 2026-10-25 DST change in Berlin repeats the 02:00–03:00 hour in firmware 1.x files; resolve it from the
reading order (the first occurrence is CEST).
