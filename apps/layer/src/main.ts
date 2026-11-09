import {
  DeltaClient,
  applyEvent,
  type Command,
  type Entry,
  type Member,
  type Snapshot,
  type WorkspaceInfo,
  type Role,
} from "@delta-core/client";
import { TerminalView } from "./terminal.ts";
import { AgentView } from "./agent.ts";
import { TextView } from "./text.ts";
import { node, button, get, grow } from "./ui.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const draft = get<HTMLTextAreaElement>("draft");
const compose = get("compose");
const palette = get("palette");
const flow = get("flow");
const publish = get<HTMLButtonElement>("publish");
const ask = get<HTMLButtonElement>("ask-pi");
publish.setAttribute("aria-label", "Publish");
let client: DeltaClient;
let me: Member;
let members: Member[] = [];
let workspaces: WorkspaceInfo[] = [];
let snapshot: Snapshot;
let subscription: AbortController | undefined;
let navigation = 0;
let after: string | null = null;
let busy = false;
let choices: Array<{ label: string; action: () => void }> = [];
let savedQuote = "";
const views = new Map<
  string,
  { element: HTMLElement; update: (entry: Entry) => void; dispose: () => void }
>();

function report(error: unknown): void {
  const notice = get("notice");
  notice.hidden = false;
  notice.textContent = error instanceof Error ? error.message : String(error);
}
function clearNotice(): void {
  get("notice").hidden = true;
}
function draftKey(): string {
  return `delta:draft:${me.id}:${snapshot.workspace.id}:new`;
}
function saveDraft(): void {
  try {
    localStorage.setItem(
      draftKey(),
      JSON.stringify({ text: draft.value, after }),
    );
  } catch {
    report(
      new Error(
        "Browser storage is full; keep this tab open to preserve your draft",
      ),
    );
  }
}
function placeComposer(): void {
  if (after) {
    const anchor = views.get(after)?.element;
    if (anchor && anchor.nextSibling !== compose) anchor.after(compose);
  } else if (flow.lastChild !== compose) flow.append(compose);
}
function selectPosition(id: string): void {
  after = id;
  placeComposer();
  saveDraft();
  draft.focus();
}

function renderEntries(): void {
  for (let index = 0; index < snapshot.entries.length; index++) {
    const entry = snapshot.entries[index];
    let view = views.get(entry.id);
    if (!view) {
      if (entry.content.type === "text")
        view = new TextView(
          entry,
          me,
          client,
          snapshot.workspace.id,
          report,
          () => selectPosition(entry.id),
        );
      else if (entry.content.type === "terminal") {
        const terminal = new TerminalView(
          entry.content,
          entry.id,
          me,
          new Map(members.map((m) => [m.id, m.name])),
          client,
          snapshot.workspace.id,
          report,
        );
        view = {
          element: terminal.element,
          update: (e) => {
            if (e.content.type === "terminal") terminal.update(e.content);
          },
          dispose: () => terminal.dispose(),
        };
      } else if (entry.content.type === "agent") {
        const agent = new AgentView(
          entry.content,
          entry.id,
          me,
          client,
          snapshot.workspace.id,
          report,
        );
        view = {
          element: agent.element,
          update: (e) => {
            if (e.content.type === "agent") agent.update(e.content);
          },
          dispose: () => agent.dispose(),
        };
      } else {
        const element = node("div", "reference-entry");
        if (entry.content.kind === "thread") {
          const link = node(
            "a",
            "workspace-reference",
            `↗ ${entry.content.label}`,
          );
          link.href = `/?workspace=${encodeURIComponent(entry.content.target)}`;
          element.append(link);
        } else
          element.append(
            node("span", "user-mention", `@${entry.content.label}`),
          );
        view = { element, update: () => {}, dispose: () => {} };
      }
      views.set(entry.id, view);
      const next = snapshot.entries
        .slice(index + 1)
        .map((e) => views.get(e.id)?.element)
        .find(Boolean);
      if (next) flow.insertBefore(view.element, next);
      else
        flow.insertBefore(
          view.element,
          after === null && compose.parentElement === flow ? compose : null,
        );
    }
    view.update(entry);
  }
  placeComposer();
}

async function openWorkspace(id: string): Promise<void> {
  const generation = ++navigation;
  const next = await client.snapshot(id);
  if (generation !== navigation) return;
  subscription?.abort();
  for (const view of views.values()) view.dispose();
  views.clear();
  flow.replaceChildren();
  snapshot = next;
  get("workspace-title").textContent = snapshot.workspace.title;
  get("workspace-breadcrumb").textContent = snapshot.workspace.title;
  const saved = localStorage.getItem(draftKey());
  const restored = saved
    ? (JSON.parse(saved) as { text: string; after: string | null })
    : null;
  draft.value = restored?.text ?? "";
  after = restored?.after ?? null;
  if (after && !snapshot.entries.some((e) => e.id === after)) after = null;
  history.replaceState(null, "", `/?workspace=${encodeURIComponent(id)}`);
  renderNavigation();
  renderEntries();
  grow(draft);
  updatePalette();
  const current = new AbortController();
  subscription = current;
  void client
    .subscribe(
      id,
      snapshot.cursor,
      (event) => {
        if (current !== subscription) return;
        applyEvent(snapshot, event);
        renderEntries();
      },
      {
        signal: current.signal,
        onStatus: (status) => {
          if (current !== subscription) return;
          get("connection").textContent = {
            connecting: "Connecting",
            live: "Live",
            reconnecting: "Reconnecting",
            disconnected: "Offline",
          }[status];
        },
      },
    )
    .catch(report);
}
function renderNavigation(): void {
  const list = get("workspace-list");
  list.replaceChildren();
  for (const workspace of workspaces) {
    const item = button(
      workspace.title,
      () => {
        void openWorkspace(workspace.id).catch(report);
      },
      "workspace-item",
    );
    if (workspace.id === snapshot.workspace.id) item.classList.add("active");
    list.append(item);
  }
}

async function connect(token: string): Promise<void> {
  client = new DeltaClient(location.origin, token);
  me = await client.me();
  [members, workspaces] = await Promise.all([
    client.members(),
    client.workspaces(),
  ]);
  sessionStorage.setItem("delta:token", token);
  get("login").hidden = true;
  get("app").hidden = false;
  get("member-name").textContent = `${me.name} · ${me.role}`;
  get("invite").hidden = me.role !== "owner";
  get<HTMLButtonElement>("new-workspace").disabled = me.role === "viewer";
  compose.hidden = me.role === "viewer";
  ask.hidden = me.role !== "owner" && me.role !== "executor";
  const requested = new URL(location.href).searchParams.get("workspace");
  await openWorkspace(
    workspaces.find((w) => w.id === requested)?.id ?? workspaces[0].id,
  );
}

async function act(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  publish.disabled = true;
  ask.disabled = true;
  clearNotice();
  try {
    await action();
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    publish.disabled = false;
    ask.disabled = false;
  }
}
function completeDraft(
  generation: number,
  key: string,
  original: string,
  id: string,
  remaining: string,
): void {
  const stored = localStorage.getItem(key);
  if (stored && (JSON.parse(stored) as { text: string }).text === original)
    localStorage.setItem(key, JSON.stringify({ text: remaining, after: id }));
  if (generation !== navigation) return;
  after = id;
  if (draft.value === original) draft.value = remaining;
  saveDraft();
  grow(draft);
  updatePalette();
  placeComposer();
}
async function insert(command: Command): Promise<void> {
  const generation = navigation;
  const key = draftKey();
  const text = draft.value;
  await client.command(snapshot.workspace.id, command);
  if ("id" in command)
    completeDraft(
      generation,
      key,
      text,
      command.id,
      text.replace(/(^|\s)@(?:terminal|threads|users)?$/, "$1"),
    );
}
function updatePalette(): void {
  choices = [];
  const match = /(?:^|\s)@(\w*)$/.exec(draft.value);
  if (match) {
    const keyword = match[1];
    if (
      "terminal".startsWith(keyword) &&
      (me.role === "owner" || me.role === "executor")
    )
      choices.push({
        label: "Terminal · run here",
        action: () => {
          void act(async () =>
            insert({ type: "open_terminal", id: crypto.randomUUID(), after }),
          );
        },
      });
    if (keyword === "threads")
      choices.push(
        ...workspaces
          .filter((w) => w.id !== snapshot.workspace.id)
          .map((w) => ({
            label: `Reference ${w.title}`,
            action: () => {
              void act(async () =>
                insert({
                  type: "insert_reference",
                  id: crypto.randomUUID(),
                  kind: "thread",
                  target: w.id,
                  label: w.title,
                  after,
                }),
              );
            },
          })),
      );
    else if ("threads".startsWith(keyword))
      choices.push({
        label: "Threads · reference a workspace",
        action: () => {
          draft.value = draft.value.replace(/@\w*$/, "@threads");
          updatePalette();
        },
      });
    if (keyword === "users")
      choices.push(
        ...members.map((m) => ({
          label: `Mention ${m.name}`,
          action: () => {
            void act(async () =>
              insert({
                type: "insert_reference",
                id: crypto.randomUUID(),
                kind: "user",
                target: m.id,
                label: m.name,
                after,
              }),
            );
          },
        })),
      );
    else if ("users".startsWith(keyword))
      choices.push({
        label: "Users · mention someone",
        action: () => {
          draft.value = draft.value.replace(/@\w*$/, "@users");
          updatePalette();
        },
      });
  }
  palette.replaceChildren(
    ...choices.map((c) => button(c.label, c.action, "palette-item")),
  );
  palette.hidden = !choices.length;
}

publish.addEventListener("click", () => {
  void act(async () => {
    if (!draft.value.trim()) return;
    const text = draft.value;
    const id = crypto.randomUUID();
    const generation = navigation;
    const key = draftKey();
    await client.command(snapshot.workspace.id, {
      type: "publish_text",
      id,
      base_revision: 0,
      text,
      after,
    });
    completeDraft(generation, key, text, id, "");
  });
});
ask.addEventListener("click", () => {
  void act(async () => {
    if (!draft.value.trim()) return;
    const text = draft.value;
    const id = crypto.randomUUID();
    const generation = navigation;
    const key = draftKey();
    await client.command(snapshot.workspace.id, {
      type: "prompt_agent",
      id,
      backend: "pi",
      prompt: text,
      after,
    });
    completeDraft(generation, key, text, id, "");
  });
});
draft.addEventListener("input", () => {
  saveDraft();
  grow(draft);
  updatePalette();
});
draft.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    publish.click();
  } else if (event.key === "Enter" && !event.shiftKey && choices.length) {
    event.preventDefault();
    choices[0].action();
  } else if (event.key === "Escape") {
    choices = [];
    palette.hidden = true;
  }
});
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (
    selection?.toString() &&
    selection.anchorNode?.parentElement?.closest("#flow")
  )
    savedQuote = selection.toString();
});
get("quote").addEventListener("click", () => {
  if (!savedQuote) {
    report(new Error("Select published workspace text first"));
    return;
  }
  draft.value += `${draft.value ? "\n\n" : ""}${savedQuote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n`;
  saveDraft();
  grow(draft);
  draft.focus();
});
get("new-workspace").addEventListener("click", () => {
  const title = window.prompt("Workspace name");
  if (!title?.trim()) return;
  void act(async () => {
    const w = await client.createWorkspace(title.trim());
    workspaces = await client.workspaces();
    await openWorkspace(w.id);
  });
});
get("sign-out").addEventListener("click", () => {
  subscription?.abort();
  sessionStorage.removeItem("delta:token");
  location.reload();
});
get("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(get<HTMLInputElement>("token").value.trim()).catch((error) => {
    get("login-error").textContent =
      error instanceof Error ? error.message : String(error);
  });
});
const dialog = get<HTMLDialogElement>("invite-dialog");
get("invite").addEventListener("click", () => {
  get("invitation-result").hidden = true;
  get<HTMLTextAreaElement>("invitation-token").value = "";
  dialog.showModal();
});
get("close-invite").addEventListener("click", () => dialog.close());
get("invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void act(async () => {
    const invitation = await client.invite({
      name: get<HTMLInputElement>("invite-name").value,
      role: get<HTMLSelectElement>("invite-role").value as Role,
    });
    get<HTMLTextAreaElement>("invitation-token").value = invitation.token;
    get("invitation-result").hidden = false;
    members = await client.members();
  });
});
const token = sessionStorage.getItem("delta:token");
if (token)
  void connect(token).catch((error) => {
    sessionStorage.removeItem("delta:token");
    get("app").hidden = true;
    get("login").hidden = false;
    get("login-error").textContent =
      error instanceof Error ? error.message : String(error);
  });
