import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PKG_PATH = resolve(import.meta.dirname, "../package.json");

const now = new Date();
const version = `v${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;

const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const previousVersion = pkg.version;
pkg.version = version;

writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

if (previousVersion !== version) {
  console.log(`Version updated: ${previousVersion} → ${version}`);
} else {
  console.log(`Version unchanged: ${version}`);
}
