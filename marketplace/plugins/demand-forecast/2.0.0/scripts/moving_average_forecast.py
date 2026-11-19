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


def next_weeks(last, n):
    year, w = last.split("-W")
    year, w = int(year), int(w)
    out = []
    for _ in range(n):
        w += 1
        if w > 52:
            w, year = 1, year + 1
        out.append(f"{year}-W{w:02d}")
    return out


def main():
    inputs, outdir = load_io()
    sales = read_json(inputs["sales"])
    horizon = int(inputs.get("horizon_weeks", 2))
    window = int(inputs.get("window_weeks", 3))
    out = []
    for store in sorted({r["store"] for r in sales}):
        series = sorted((r for r in sales if r["store"] == store), key=lambda r: r["week"])
        recent = [r["units"] for r in series[-window:]]
        avg = sum(recent) / len(recent)
        for week in next_weeks(series[-1]["week"], horizon):
            out.append({"store": store, "week": week, "forecast_units": round(avg, 1),
                        "method": f"moving-average-{window}w"})
    finish(outdir, {"forecast": save(outdir, "forecast.json", out)})


main()
