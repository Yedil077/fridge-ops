// Cross-platform Gradle wrapper call: node scripts/gradle.mjs assembleDebug
import { spawnSync } from "node:child_process";
import path from "node:path";

const cwd = path.join(process.cwd(), "android");
const cmd = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const r = spawnSync(cmd, process.argv.slice(2), { cwd, stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
