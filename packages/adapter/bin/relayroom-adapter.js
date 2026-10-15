#!/usr/bin/env node
// Runs the TypeScript entry point through tsx so no build step is needed.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
