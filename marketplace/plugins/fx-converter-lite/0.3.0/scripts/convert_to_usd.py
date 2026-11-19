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
    # Quick converter: rounds to whole dollars and silently skips unknown currencies.
    inputs, outdir = load_io()
    actuals = read_json(inputs["actuals"])
    rates = read_json(inputs["rates"])["rates"]
    out = [{"region": r["region"], "quarter": r["quarter"],
            "revenue_usd": float(round(r["revenue"] * rates[r["currency"]]))}
           for r in actuals if r["currency"] in rates]
    finish(outdir, {"usd_actuals": save(outdir, "usd_actuals.json", out)})


main()
