import { DeltaClient } from "@delta-core/client";
import { readFile } from "node:fs/promises";
const token =
  process.env.DELTA_TOKEN ??
  (
    await readFile(
      process.env.DELTA_TOKEN_FILE ?? ".delta-core/owner-token",
      "utf8",
    )
  ).trim();
const client = new DeltaClient(
  process.env.DELTA_URL ?? "http://127.0.0.1:47831",
  token,
);
const me = await client.me();
const workspaces = await client.workspaces();
console.log(`${me.name}: ${workspaces.length} workspace(s)`);
const snapshot = await client.snapshot(workspaces[0].id);
console.log(JSON.stringify(snapshot, null, 2));
if (process.env.DELTA_WATCH === "1") {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await client.subscribe(
    snapshot.workspace.id,
    snapshot.cursor,
    (event) => console.log(JSON.stringify(event)),
    { signal: stop.signal },
  );
}
