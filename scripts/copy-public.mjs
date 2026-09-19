/**
 * Copies the web build's static assets into the renderer output.
 *
 * Vite's root is renderer/, so `public/` (kept at the project root because it
 * ships with the ported app) has to be placed next to the built bundle by hand.
 * Runs after `vite build`, which empties the output directory.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "public");
const target = join(root, "dist", "renderer");

if (!existsSync(source)) {
  console.error(`missing ${source}`);
  process.exit(1);
}

cpSync(source, target, { recursive: true });
console.log(`copied public/ into ${target}`);
