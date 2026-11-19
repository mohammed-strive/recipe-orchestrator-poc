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
    forecast = read_json(inputs["forecast"])
    inventory = {s["store"]: s["on_hand"] for s in read_json(inputs["inventory"])["stores"]}
    out = []
    for store in sorted({r["store"] for r in forecast}):
        weekly = [r["forecast_units"] for r in forecast if r["store"] == store]
        avg = sum(weekly) / len(weekly)
        on_hand = inventory.get(store, 0)
        cover = round(on_hand / avg, 2) if avg else 99.0
        risk = "high" if cover < 1 else "medium" if cover < 2 else "low"
        out.append({"store": store, "forecast_units": round(avg, 1), "on_hand": on_hand,
                    "cover_weeks": cover, "risk": risk})
    high = sum(1 for r in out if r["risk"] == "high")
    finish(outdir, {"risk": save(outdir, "risk.json", out), "high_risk_count": high})


main()
