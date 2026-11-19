# legacy-forecast

Exponential smoothing demand forecast per store.

`python3 scripts/forecast.py --inputs inputs.json --outdir out/`

Inputs: `sales` (store sales table), `horizon_weeks` (default 2).
Output: `forecast` table with store, week, forecast_units, method.
