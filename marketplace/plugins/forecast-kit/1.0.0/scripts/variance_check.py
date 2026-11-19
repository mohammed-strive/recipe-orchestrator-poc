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


def main():
    inputs, outdir = load_io()
    actuals = read_json(inputs["usd_actuals"])
    projection = read_json(inputs["projection"])
    out = []
    for region in sorted({r["region"] for r in projection}):
        last = sorted((r for r in actuals if r["region"] == region), key=lambda r: r["quarter"])[-1]
        first = sorted((r for r in projection if r["region"] == region), key=lambda r: r["quarter"])[0]
        variance = (first["projected_revenue_usd"] - last["revenue_usd"]) / last["revenue_usd"]
        out.append({"region": region, "last_actual_usd": last["revenue_usd"],
                    "first_projection_usd": first["projected_revenue_usd"], "variance": round(variance, 4)})
    max_abs = max((abs(r["variance"]) for r in out), default=0.0)
    finish(outdir, {"variance": save(outdir, "variance.json", out), "max_abs_variance": round(max_abs, 4)})


main()
