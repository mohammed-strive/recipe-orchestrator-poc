#!/usr/bin/env python3
import argparse, json, os, sys


def load_io():
    p = argparse.ArgumentParser()
    p.add_argument("--inputs", required=True, help="JSON file mapping port/param name to value")
    p.add_argument("--outdir", required=True, help="Directory to write outputs.json and data files")
    a = p.parse_args()
    with open(a.inputs) as f:
        return json.load(f), a.outdir


def read_json(path):
    with open(path) as f:
        return json.load(f)


def save(outdir, name, data):
    with open(os.path.join(outdir, name), "w") as f:
        json.dump(data, f, indent=2)
    return name


def finish(outdir, outputs):
    with open(os.path.join(outdir, "outputs.json"), "w") as f:
        json.dump(outputs, f, indent=2)


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def next_quarters(last, n):
    year, q = last.split("-Q")
    year, q = int(year), int(q)
    out = []
    for _ in range(n):
        q += 1
        if q > 4:
            q, year = 1, year + 1
        out.append(f"{year}-Q{q}")
    return out


def region_series(rows, region):
    series = sorted((r for r in rows if r["region"] == region), key=lambda r: r["quarter"])
    if not series:
        fail(f"No actuals for region {region}")
    return series


def main():
    inputs, outdir = load_io()
    rows = read_json(inputs["usd_actuals"])
    region = inputs["region"]
    horizon = int(inputs.get("horizon_quarters", 2))
    series = region_series(rows, region)
    if len(series) < 2:
        fail(f"Linear projection needs at least 2 quarters for {region}, got {len(series)}")
    ys = [r["revenue_usd"] for r in series]
    xs = list(range(len(ys)))
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    intercept = my - slope * mx
    out = []
    for i, quarter in enumerate(next_quarters(series[-1]["quarter"], horizon)):
        value = intercept + slope * (n + i)
        out.append({"region": region, "quarter": quarter,
                    "projected_revenue_usd": round(max(value, 0.0), 2), "method": "linear-v1.1"})
    finish(outdir, {"projection": save(outdir, "projection.json", out)})


main()
