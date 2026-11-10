import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  DeltaClient,
  ApiError,
  applyEvent,
  type Snapshot,
} from "../src/index.ts";

async function server(handler: import("node:http").RequestListener) {
  const http = createServer(handler);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}

test("collaboration events project into legacy snapshots and repeated joins do not duplicate humans", () => {
  const snapshot: Snapshot = {
    workspace: { id: "w", title: "Work" },
    cursor: 0,
    entries: [],
  };
  applyEvent(snapshot, {
    sequence: 1,
    change: { type: "participant_joined", member: "a" },
  });
  applyEvent(snapshot, {
    sequence: 2,
    change: { type: "participant_joined", member: "a" },
  });
  applyEvent(snapshot, {
    sequence: 3,
    change: {
      type: "reply_mode_changed",
      mode: "mentions_only",
      explicit: false,
    },
  });
  assert.deepEqual(snapshot.collaboration, {
    reply_mode: "mentions_only",
    mode_explicit: false,
    participants: ["a"],
  });
});

test("workspace member events update only the scoped roster without granting local execution", () => {
  const snapshot: Snapshot = {
    workspace: { id: "w", title: "W" },
    cursor: 1,
    entries: [],
    members: [],
    access: { role: "editor", can_execute: false },
  };
  applyEvent(snapshot, {
    sequence: 2,
    change: {
      type: "member_added",
      member: { id: "peer", name: "Peer", role: "executor" },
    },
  });
  assert.deepEqual(snapshot.members, [
    { id: "peer", name: "Peer", role: "executor" },
  ]);
  assert.equal(snapshot.access?.can_execute, false);
});

test("chronology restoration moves existing entries without replacing their contents", () => {
  const snapshot: Snapshot = {
    workspace: { id: "w", title: "Work" },
    cursor: 10,
    entries: ["first", "third", "second"].map((id) => ({
      id,
      author: id,
      revision: 1,
      content: { type: "text", text: id },
    })),
  };
  const original = snapshot.entries[1];
  applyEvent(snapshot, {
    sequence: 11,
    change: { type: "order_restored", ids: ["first", "second", "third"] },
  });
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    ["first", "second", "third"],
  );
  assert.equal(snapshot.entries[2], original);
});

test("public event projection preserves document order and final session state", () => {
  const snapshot: Snapshot = {
    workspace: { id: "w", title: "Work" },
    cursor: 0,
    entries: [],
  };
  applyEvent(snapshot, {
    sequence: 1,
    change: {
      type: "inserted",
      after: null,
      entry: {
        id: "a",
        revision: 1,
        author: "alice",
        content: { type: "text", text: "original" },
      },
    },
  });
  applyEvent(snapshot, {
    sequence: 2,
    change: {
      type: "text_published",
      id: "a",
      revision: 2,
      actor: "bob",
      text: "published",
    },
  });
  applyEvent(snapshot, {
    sequence: 2,
    change: {
      type: "text_published",
      id: "a",
      revision: 2,
      actor: "bob",
      text: "duplicate",
    },
  });
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(snapshot.entries[0].content, {
    type: "text",
    text: "published",
  });
  assert.equal(snapshot.entries[0].revision, 2);
  assert.equal(snapshot.cursor, 2);
});

test("commands authenticate and expose typed conflicts without retrying side effects", async () => {
  let calls = 0;
  const s = await server((req, res) => {
    assert.equal(req.headers.authorization, "Bearer member-token");
    assert.equal(req.url, "/api/v1/workspaces/w/commands");
    calls++;
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ code: "conflict", message: "Shared text changed" }),
    );
  });
  try {
    const client = new DeltaClient(s.url, "member-token");
    await assert.rejects(
      client.command("w", {
        type: "publish_text",
        id: "a",
        base_revision: 0,
        text: "draft",
        after: null,
      }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "conflict",
    );
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});

test("subscription decodes split UTF-8, resumes at cursor and suppresses duplicates", async () => {
  const urls: string[] = [];
  const s = await server((req, res) => {
    urls.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer member-token");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (urls.length === 1) {
      const bytes = Buffer.from(
        'id: 2\ndata: {"sequence":2,"change":{"type":"terminal_output","id":"t","data":"中文"}}\n\n',
      );
      const cut = bytes.indexOf(Buffer.from("中")) + 1;
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 5);
    } else {
      res.write(
        'data: {"sequence":2,"change":{"type":"session_state","id":"t","status":"running"}}\n\n',
      );
      res.write(
        'data: {"sequence":3,"change":{"type":"session_state","id":"t","status":"closed"}}\n\n',
      );
    }
  });
  const abort = new AbortController();
  try {
    const seen: number[] = [];
    const client = new DeltaClient(s.url, "member-token");
    const timeout = setTimeout(() => abort.abort(), 4000);
    await client.subscribe(
      "w",
      1,
      (event) => {
        seen.push(event.sequence);
        if (event.sequence === 2)
          assert.equal((event.change as { data: string }).data, "中文");
        if (event.sequence === 3) abort.abort();
      },
      { signal: abort.signal, retryMs: 5 },
    );
    clearTimeout(timeout);
    assert.deepEqual(seen, [2, 3]);
    assert.deepEqual(urls.slice(0, 2), [
      "/api/v1/workspaces/w/events?after=1",
      "/api/v1/workspaces/w/events?after=2",
    ]);
  } finally {
    abort.abort();
    s.close();
  }
});
