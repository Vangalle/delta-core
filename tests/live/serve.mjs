import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
if (process.env.DELTA_LIVE !== "1")
  throw new Error("Real inference requires explicit npm run test:live");
const data = await mkdtemp(join(tmpdir(), "delta-real-pi-"));
const cwd = join(data, "project");
await mkdir(cwd);
const nonce = `DELTA-REAL-${randomUUID()}`;
await writeFile(
  join(cwd, "live-evidence.txt"),
  `Acceptance input\nnonce: ${nonce}\nOnly this synthetic file is authorized for this test.\n`,
);
await writeFile(join(data, "owner-token"), "live-owner", { mode: 0o600 });
await mkdir(".superpowers", { recursive: true });
const manifest = resolve(".superpowers/live-current.json");
await writeFile(manifest, JSON.stringify({ nonce, cwd }), { mode: 0o600 });
const { DELTA_PI: _ignored, ...environment } = process.env;
const child = spawn(resolve("target/debug/delta-host"), {
  env: {
    ...environment,
    DELTA_DATA: data,
    DELTA_CWD: cwd,
    DELTA_PI: "pi",
    DELTA_LISTEN: "127.0.0.1:47834",
  },
  stdio: "inherit",
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.kill("SIGINT");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", async (code) => {
  await rm(data, { recursive: true, force: true });
  await rm(manifest, { force: true });
  process.exit(code ?? 0);
});
