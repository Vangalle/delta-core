import {
  DeltaClient,
  applyEvent,
  type Command,
  type Entry,
  type Member,
  type Snapshot,
  type WorkspaceInfo,
  type Role,
  type ContextQuote,
} from "@delta-core/client";
import { TerminalView } from "./terminal.ts";
import { AgentView } from "./agent.ts";
import { TextView } from "./text.ts";
import { node, button, get } from "./ui.ts";
import { RichEditor } from "./editor.ts";
import {
  ContextQuotes,
  quoteKey,
  quoteHref,
  type QuoteLocator,
  type QuoteNavigation,
} from "./context-quotes.ts";
import { SelectionQuotes } from "./selection.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const draft = new RichEditor(
  get("draft"),
  "Private draft",
  "Write here. Type @ to insert…",
);
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
const quoteNavigation: QuoteNavigation = {
  title: (id) =>
    workspaces.find((workspace) => workspace.id === id)?.title ?? id,
  go: (quote) => {
    void navigateQuote(quote).catch(report);
  },
};
const quoteTray = new ContextQuotes(quoteNavigation, () => saveDraft());
quoteTray.element.classList.add("draft-quotes");
compose.prepend(quoteTray.element);
const selectionQuotes = new SelectionQuotes(
  flow,
  () =>
    snapshot && me
      ? {
          workspace: snapshot.workspace.id,
          cursor: snapshot.cursor,
          entries: snapshot.entries,
          editable: me.role !== "viewer",
        }
      : null,
  addQuote,
);
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
  if (!snapshot || !me) return;
  try {
    localStorage.setItem(
      draftKey(),
      JSON.stringify({ text: draft.value, after, quotes: quoteTray.value }),
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
  if (me.role === "viewer") {
    get("workspace-title").focus();
    return;
  }
  draft.focus();
}

function addQuote(quote: ContextQuote): void {
  if (me.role === "viewer") return;
  try {
    quoteTray.add(quote);
    saveDraft();
    draft.focus();
  } catch (error) {
    report(error);
  }
}

async function navigateQuote(quote: QuoteLocator): Promise<void> {
  if (snapshot.workspace.id !== quote.workspace_id)
    await openWorkspace(quote.workspace_id);
  const view = views.get(quote.entry_id);
  if (!view) throw new Error("Quote source is no longer available");
  const target =
    [
      ...view.element.querySelectorAll<HTMLElement>("[data-quote-fragment]"),
    ].find((element) => element.dataset.quoteFragment === quote.fragment) ??
    view.element;
  const disclosure = target.closest("details");
  if (disclosure) disclosure.open = true;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center" });
  target.classList.add("quote-target");
  setTimeout(() => target.classList.remove("quote-target"), 1500);
  history.replaceState(null, "", quoteHref(quote));
}

function editAgentResult(id: string, markdown: string): void {
  if (
    me.role === "viewer" ||
    !snapshot.entries.some((entry) => entry.id === id)
  )
    return;
  draft.value = draft.value.trim() ? `${draft.value}\n\n${markdown}` : markdown;
  selectPosition(id);
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
          () => selectPosition(entry.id),
          (text) => {
            if (me.role === "viewer") return false;
            const source = snapshot.entries.find(
              (item) => item.id === entry.id,
            );
            if (!source) return false;
            addQuote({
              workspace_id: snapshot.workspace.id,
              entry_id: source.id,
              revision: source.revision,
              cursor: snapshot.cursor,
              fragment: "terminal",
              quote: text,
            });
            return true;
          },
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
          (markdown) => editAgentResult(entry.id, markdown),
          quoteNavigation,
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
      const contentView = view;
      const references = new ContextQuotes(quoteNavigation);
      references.element.classList.add("published-quotes");
      contentView.element.prepend(references.element);
      contentView.element.dataset.entryId = entry.id;
      view = {
        element: contentView.element,
        update: (value) => {
          contentView.update(value);
          references.value = value.quotes ?? [];
        },
        dispose: () => contentView.dispose(),
      };
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
  selectionQuotes.reset();
  for (const view of views.values()) view.dispose();
  views.clear();
  flow.replaceChildren();
  snapshot = next;
  get("workspace-title").textContent = snapshot.workspace.title;
  get("workspace-breadcrumb").textContent = snapshot.workspace.title;
  const saved = localStorage.getItem(draftKey());
  const restored = saved
    ? (JSON.parse(saved) as {
        text: string;
        after: string | null;
        quotes?: ContextQuote[];
      })
    : null;
  draft.reset(restored?.text ?? "");
  quoteTray.value = restored?.quotes ?? [];
  after = restored?.after ?? null;
  if (after && !snapshot.entries.some((e) => e.id === after)) after = null;
  history.replaceState(null, "", `/?workspace=${encodeURIComponent(id)}`);
  renderNavigation();
  renderEntries();
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
  const requested = new URL(location.href).searchParams;
  await openWorkspace(
    workspaces.find((w) => w.id === requested.get("workspace"))?.id ??
      workspaces[0].id,
  );
  const source = requested.get("entry");
  if (source && requested.get("workspace") === snapshot.workspace.id)
    await navigateQuote({
      workspace_id: snapshot.workspace.id,
      entry_id: source,
      fragment: requested.get("fragment") ?? "text",
    });
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
  submittedQuotes: ContextQuote[] = [],
): void {
  const sent = new Set(submittedQuotes.map(quoteKey));
  const retained = (quotes: ContextQuote[]) =>
    quotes.filter((quote) => !sent.has(quoteKey(quote)));
  const stored = localStorage.getItem(key);
  if (stored) {
    const saved = JSON.parse(stored) as {
      text: string;
      after: string | null;
      quotes?: ContextQuote[];
    };
    localStorage.setItem(
      key,
      JSON.stringify({
        text: saved.text === original ? remaining : saved.text,
        after: id,
        quotes: retained(saved.quotes ?? []),
      }),
    );
  }
  if (generation !== navigation) return;
  quoteTray.value = retained(quoteTray.value);
  after = id;
  if (draft.value === original) draft.value = remaining;
  saveDraft();
  updatePalette();
  placeComposer();
}
async function insert(command: Command): Promise<void> {
  const generation = navigation;
  const key = draftKey();
  const text = draft.value;
  const remaining = draft.trigger()?.remaining ?? text;
  await client.command(snapshot.workspace.id, command);
  if ("id" in command)
    completeDraft(generation, key, text, command.id, remaining);
}
function updatePalette(): void {
  choices = [];
  const trigger = draft.trigger();
  if (trigger) {
    const keyword = trigger.keyword;
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
          draft.setTrigger("@threads");
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
          draft.setTrigger("@users");
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
    const quotes = quoteTray.value;
    if (!draft.value.trim() && !quotes.length) return;
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
      quotes,
    });
    completeDraft(generation, key, text, id, "", quotes);
  });
});
ask.addEventListener("click", () => {
  void act(async () => {
    if (!draft.value.trim()) return;
    const text = draft.value;
    const id = crypto.randomUUID();
    const generation = navigation;
    const key = draftKey();
    const quotes = quoteTray.value;
    await client.command(snapshot.workspace.id, {
      type: "prompt_agent",
      id,
      backend: "pi",
      prompt: text,
      after,
      quotes,
    });
    completeDraft(generation, key, text, id, "", quotes);
  });
});
draft.onChange = () => {
  saveDraft();
  updatePalette();
};
draft.onSelectionChange = () => updatePalette();
draft.onKeyDown = (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    publish.click();
    return true;
  } else if (event.key === "Enter" && !event.shiftKey && choices.length) {
    event.preventDefault();
    choices[0].action();
    return true;
  } else if (event.key === "Escape") {
    choices = [];
    palette.hidden = true;
  }
  return false;
};
get("quote").addEventListener("click", () => {
  if (!selectionQuotes.quoteSelection())
    report(new Error("Select published workspace text first"));
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
