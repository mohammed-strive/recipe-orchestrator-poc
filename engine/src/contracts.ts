// Data contracts: JSON Schemas in contracts/<kind>/<name>@<version>.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { config } from "./config.js";

const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: false });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

export const isScalar = (contract: string) => contract.startsWith("scalar:");

function schemaPath(contract: string): string {
  return join(config.contractsDir, `${contract}.json`);
}

export function contractExists(contract: string): boolean {
  return isScalar(contract) || existsSync(schemaPath(contract));
}

export function contractSchema(contract: string): unknown {
  return JSON.parse(readFileSync(schemaPath(contract), "utf8"));
}

/** Validates a JSON file against a contract. Returns null when valid, or an error message. */
export function validateFile(contract: string, file: string): string | null {
  if (isScalar(contract)) return null;
  let validate = compiled.get(contract);
  if (!validate) {
    const schema = contractSchema(contract) as Record<string, unknown>;
    delete schema.$schema;
    validate = ajv.compile(schema);
    compiled.set(contract, validate);
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return `${file} is not valid JSON: ${(err as Error).message}`;
  }
  if (validate(data)) return null;
  return `${contract}: ${ajv.errorsText(validate.errors, { separator: "; " })}`;
}
