#!/usr/bin/env node
// The bin. Everything it does is in cli-main.ts, which the tests import.
import { main } from "./cli-main.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
);
