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


import csv


def main():
    inputs, outdir = load_io()
    region_filter = (inputs.get("region_filter") or "ALL").upper()
    rows = []
    with open(inputs["file"], newline="") as f:
        for r in csv.DictReader(f):
            if region_filter != "ALL" and r["region"].upper() != region_filter:
                continue
            rows.append({"region": r["region"], "quarter": r["quarter"],
                         "currency": r["currency"].upper(), "revenue": round(float(r["revenue"]), 2)})
    if not rows:
        fail("No rows loaded: check the file and region_filter")
    rows.sort(key=lambda r: (r["region"], r["quarter"]))
    finish(outdir, {"actuals": save(outdir, "actuals.json", rows), "row_count": len(rows)})


main()
