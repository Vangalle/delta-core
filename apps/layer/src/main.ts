import {
  DeltaClient,
  applyEvent,
  type Command,
  type Entry,
  type Member,
  type Snapshot,
  type WorkspaceInfo,
  type ContextQuote,
  type ReplyMode,
} from "@delta-core/client";
import { setupTheme } from "./theme.ts";
import { People, showInvitation } from "./people.ts";
import { TerminalView } from "./terminal.ts";
import { AgentView } from "./agent.ts";
import { TextView } from "./text.ts";
import { node, button, get, placeDocumentChildren } from "./ui.ts";
import { RichEditor } from "./editor.ts";
import {
  ContextQuotes,
  quoteKey,
  quoteHref,
  type QuoteLocator,
  type QuoteNavigation,
} from "./context-quotes.ts";
import { SelectionQuotes } from "./selection.ts";
import { AuthorIdentity } from "./identity.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

setupTheme(get<HTMLSelectElement>("theme"));
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
const replyMode = get<HTMLSelectElement>("reply-mode");
const draftIdentity = new AuthorIdentity();
compose.prepend(draftIdentity.element);
publish.setAttribute("aria-label", "Publish");
let client: DeltaClient;
let me: Member;
let account: Member;
let members: Member[] = [];
let workspaces: WorkspaceInfo[] = [];
let snapshot: Snapshot;
let subscription: AbortController | undefined;
let navigation = 0;
let after: string | null = null;
let busy = false;
let choices: Array<{
  label: string;
  action: () => void;
  complete?: () => void;
}> = [];
let selectedChoice = 0;
let paletteKey = "";
let dismissedTrigger: string | null = null;
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
      JSON.stringify({
        text: draft.value,
        after,
        explicit_position: after !== null,
        quotes: quoteTray.value,
      }),
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
  const elements = snapshot.entries.flatMap((entry) => {
    const view = views.get(entry.id);
    return view ? [view.element] : [];
  });
  const anchor = after
    ? elements.findIndex((element) => element.dataset.entryId === after)
    : -1;
  elements.splice(anchor >= 0 ? anchor + 1 : elements.length, 0, compose);
  placeDocumentChildren(flow, elements);
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
          snapshot.capabilities?.includes("inline_threads") ?? false,
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
      const identity = new AuthorIdentity();
      const shell = node("section", "document-entry");
      shell.dataset.entryId = entry.id;
      shell.dataset.kind = entry.content.type;
      shell.append(identity.element, contentView.element);
      const references = new ContextQuotes(quoteNavigation);
      references.element.classList.add("published-quotes");
      contentView.element.prepend(references.element);
      contentView.element.dataset.entryId = entry.id;
      view = {
        element: shell,
        update: (value) => {
          const agent = value.content.type === "agent";
          const member = members.find((member) => member.id === value.author);
          const author =
            agent && value.content.type === "agent"
              ? `agent:${value.content.backend}`
              : value.author;
          shell.dataset.authorId = author;
          identity.update(
            author,
            agent
              ? "Agent"
              : (member?.name ??
                  (value.author === me.id ? me.name : "Collaborator")),
            agent,
          );
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
  await client.joinWorkspace(id);
  const next = await client.snapshot(id);
  if (generation !== navigation) return;
  subscription?.abort();
  selectionQuotes.reset();
  for (const view of views.values()) view.dispose();
  views.clear();
  flow.replaceChildren();
  snapshot = next;
  const access = next.access ?? {
    role: account.role,
    can_execute: account.role === "owner" || account.role === "executor",
  };
  me = {
    ...account,
    role:
      !access.can_execute &&
      (access.role === "owner" || access.role === "executor")
        ? "editor"
        : access.role,
  };
  members = next.members ?? [me];
  get("member-name").textContent = `${account.name} · ${access.role}`;
  compose.hidden = me.role === "viewer";
  ask.hidden = !access.can_execute;
  clearNotice();
  get("workspace-title").textContent = snapshot.workspace.title;
  get("workspace-breadcrumb").textContent = snapshot.workspace.title;
  const saved = localStorage.getItem(draftKey());
  const restored = saved
    ? (JSON.parse(saved) as {
        text: string;
        after: string | null;
        explicit_position?: boolean;
        quotes?: ContextQuote[];
      })
    : null;
  draft.reset(restored?.text ?? "");
  quoteTray.value = restored?.quotes ?? [];
  after = restored?.explicit_position ? restored.after : null;
  if (after && !snapshot.entries.some((e) => e.id === after)) after = null;
  history.replaceState(null, "", `/?workspace=${encodeURIComponent(id)}`);
  renderNavigation();
  renderEntries();
  renderPolicy();
  updatePalette();
  const current = new AbortController();
  subscription = current;
  void client
    .subscribe(
      id,
      snapshot.cursor,
      (event) => {
        if (current !== subscription || generation !== navigation) return;
        applyEvent(snapshot, event);
        if (
          event.change.type === "member_role_changed" &&
          event.change.member.id === account.id
        ) {
          void client
            .me()
            .then(async (nextAccount) => {
              if (current !== subscription || generation !== navigation) return;
              account = nextAccount;
              await openWorkspace(id);
            })
            .catch(report);
          return;
        }
        members = snapshot.members ?? members;
        renderEntries();
        renderPolicy();
        if (
          event.change.type === "member_added" ||
          event.change.type === "member_role_changed"
        )
          updatePalette();
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
get("restore-order").addEventListener("click", () => {
  void act(async () => {
    await client.restoreChronologicalOrder(snapshot.workspace.id);
    get<HTMLDetailsElement>("workspace-actions").open = false;
  });
});
get("desktop-terminal").addEventListener(
  "click",
  () =>
    void act(async () => {
      if (
        !window.confirm(
          "Open a NEW Terminal window on the Host desktop? This experimental action runs outside the shared document; its output is not shared here.",
        )
      )
        return;
      await client.openDesktopTerminal(snapshot.workspace.id);
      get<HTMLDetailsElement>("workspace-actions").open = false;
    }),
);
function renderPolicy(): void {
  const desktop = get<HTMLButtonElement>("desktop-terminal");
  desktop.hidden = account.role !== "owner";
  desktop.disabled = !snapshot.capabilities?.includes("desktop_terminal");
  desktop.title = desktop.disabled
    ? "Disabled on this Host. Enable DELTA_ENABLE_DESKTOP_TERMINAL=1 and restart to opt in."
    : "Opens on the Host desktop, not on collaborators’ computers; output is not shared";
  get("workspace-actions").hidden =
    (snapshot.access?.role ?? me.role) !== "owner";
  replyMode.value = snapshot.collaboration?.reply_mode ?? "mentions_only";
  replyMode.disabled = me.role !== "owner" && me.role !== "executor";
  replyMode.title = replyMode.disabled
    ? "Execution access is required to change Agent reply mode"
    : "Saved for this workspace; leaving does not change the mode";
}
replyMode.addEventListener("change", () => {
  if (busy) {
    renderPolicy();
    return;
  }
  const mode = replyMode.value as ReplyMode;
  void act(async () => {
    try {
      await client.setReplyMode(snapshot.workspace.id, mode);
    } finally {
      renderPolicy();
    }
  });
});

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
    if (workspace.id === snapshot?.workspace.id) item.classList.add("active");
    list.append(item);
  }
}

async function connect(token: string): Promise<void> {
  client = new DeltaClient(location.origin, token);
  account = await client.me();
  me = account;
  draftIdentity.update(me.id, me.name);
  workspaces = await client.workspaces();
  sessionStorage.setItem("delta:token", token);
  get("login").hidden = true;
  get("app").hidden = false;
  get("member-name").textContent = `${me.name} · ${me.role}`;
  get<HTMLButtonElement>("new-workspace").disabled = me.role === "viewer";
  compose.hidden = me.role === "viewer";
  ask.hidden = me.role !== "owner" && me.role !== "executor";
  const requested = new URL(location.href).searchParams;
  const target = requested.get("workspace");
  if (
    !workspaces.length ||
    (target && !workspaces.some((workspace) => workspace.id === target))
  ) {
    compose.hidden = true;
    get("workspace-actions").hidden = true;
    replyMode.disabled = true;
    get("workspace-title").textContent = target
      ? "Workspace unavailable"
      : "No workspaces yet";
    get("workspace-breadcrumb").textContent = "";
    get("connection").textContent = "Ready";
    renderNavigation();
    if (target)
      report(
        new Error(
          "This workspace is not available to your account. Choose one of your workspaces or ask its owner for an invitation.",
        ),
      );
    return;
  }
  await openWorkspace(target ?? workspaces[0].id);
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
  append = false,
): void {
  const target = append ? null : id;
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
        after: target,
        explicit_position: target !== null,
        quotes: retained(saved.quotes ?? []),
      }),
    );
  }
  if (generation !== navigation) return;
  quoteTray.value = retained(quoteTray.value);
  after = target;
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
  const key = trigger ? `${trigger.from}:${trigger.to}:${trigger.keyword}` : "";
  if (key !== paletteKey) {
    selectedChoice = 0;
    paletteKey = key;
  }
  if (key === dismissedTrigger) {
    palette.hidden = true;
    return;
  }
  dismissedTrigger = null;
  const supportsThreads =
    snapshot.capabilities?.includes("inline_threads") ?? false;
  if (trigger) {
    const keyword = trigger.keyword;
    if (
      "terminal".startsWith(keyword) &&
      (me.role === "owner" || me.role === "executor")
    )
      choices.push({
        label: "Terminal · run here",
        complete: () => {
          if (keyword !== "terminal") draft.setTrigger("@terminal");
          updatePalette();
        },
        action: () => {
          void act(async () =>
            insert({ type: "open_terminal", id: crypto.randomUUID(), after }),
          );
        },
      });
    if (supportsThreads && keyword === "threads")
      choices.push(
        ...workspaces
          .filter((w) => w.id !== snapshot.workspace.id)
          .map((w) => ({
            label: `Reference ${w.title}`,
            action: () => {
              draft.insertMention("thread", w.id, w.title);
              updatePalette();
            },
          })),
      );
    else if (supportsThreads && "threads".startsWith(keyword))
      choices.push({
        label: "Threads · reference a workspace",
        action: () => {
          draft.setTrigger("@threads");
          updatePalette();
        },
      });
    if ("agent".startsWith(keyword))
      choices.push({
        label: "Agent · ask Pi",
        action: () => {
          draft.insertMention("agent", "pi", "agent");
          updatePalette();
        },
      });
    if (keyword === "users")
      choices.push(
        ...members.map((m) => ({
          label: `Mention ${m.name}`,
          action: () => {
            draft.insertMention("user", m.id, m.name);
            updatePalette();
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
  selectedChoice = Math.min(selectedChoice, Math.max(0, choices.length - 1));
  palette.replaceChildren(
    ...choices.map((choice, index) => {
      const item = button(choice.label, choice.action, "palette-item");
      item.id = `completion-${index}`;
      item.classList.toggle("active", index === selectedChoice);
      if (index === selectedChoice) item.setAttribute("aria-current", "true");
      return item;
    }),
  );
  const unavailable =
    !!trigger?.keyword &&
    "threads".startsWith(trigger.keyword) &&
    !supportsThreads;
  if (unavailable)
    palette.append(
      node(
        "p",
        "completion-unavailable",
        "Host upgrade required for inline workspace references.",
      ),
    );
  palette.hidden = !choices.length && !unavailable;
}

function requireInlineThreadSupport(): void {
  if (
    !snapshot.capabilities?.includes("inline_threads") &&
    draft.hasThreadReferences()
  )
    throw new Error(
      "Host upgrade required before publishing inline workspace references. Your draft was preserved.",
    );
}
publish.addEventListener("click", () => {
  void act(async () => {
    const quotes = quoteTray.value;
    if (!draft.value.trim() && !quotes.length) return;
    requireInlineThreadSupport();
    const text = draft.value;
    const id = crypto.randomUUID();
    const generation = navigation;
    const key = draftKey();
    const receipt = await client.submitMessage(snapshot.workspace.id, {
      id,
      text,
      after: null,
      quotes,
      backend: "pi",
    });
    completeDraft(generation, key, text, id, "", quotes, true);
    if (
      generation === navigation &&
      receipt.agent_reply === "permission_required"
    )
      report(
        new Error(
          "Your text was published. Agent replies require execution access; this mention did not run code.",
        ),
      );
    if (generation === navigation && receipt.agent_reply === "failed")
      report(
        new Error(
          "Your text was published, but the Agent could not start. See the shared execution record.",
        ),
      );
  });
});
ask.addEventListener("click", () => {
  void act(async () => {
    if (!draft.value.trim()) return;
    requireInlineThreadSupport();
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
      after: null,
      quotes,
    });
    completeDraft(generation, key, text, id, "", quotes, true);
  });
});
draft.onChange = () => {
  saveDraft();
  updatePalette();
};
draft.onSelectionChange = () => updatePalette();
draft.onKeyDown = (event) => {
  if (event.isComposing) return false;
  const plain =
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (
    plain &&
    !palette.hidden &&
    ["Tab", "Enter", "ArrowDown", "ArrowUp"].includes(event.key)
  ) {
    const trigger = draft.trigger();
    const key = trigger
      ? `${trigger.from}:${trigger.to}:${trigger.keyword}`
      : "";
    if (!trigger || key !== paletteKey) updatePalette();
  }
  if (event.key === "Tab") {
    if (!plain || palette.hidden || !choices.length) return false;
    event.preventDefault();
    const choice = choices[selectedChoice];
    (choice.complete ?? choice.action)();
    return true;
  }
  if (
    plain &&
    !palette.hidden &&
    choices.length &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    event.preventDefault();
    selectedChoice =
      (selectedChoice + (event.key === "ArrowDown" ? 1 : -1) + choices.length) %
      choices.length;
    updatePalette();
    return true;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    publish.click();
    return true;
  } else if (event.key === "Enter" && !event.shiftKey && choices.length) {
    event.preventDefault();
    choices[selectedChoice].action();
    return true;
  } else if (event.key === "Escape" && !palette.hidden) {
    event.preventDefault();
    dismissedTrigger = paletteKey;
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
new People(
  () => client,
  () => account,
  () => snapshot,
  async () => {
    workspaces = await client.workspaces();
    renderNavigation();
    if (snapshot) {
      members = await client.members(snapshot.workspace.id);
      snapshot.members = members;
      renderEntries();
      updatePalette();
    }
  },
);
get("refresh-workspaces").addEventListener(
  "click",
  () =>
    void act(async () => {
      workspaces = await client.workspaces();
      if (!snapshot && workspaces.length) await openWorkspace(workspaces[0].id);
      else renderNavigation();
    }),
);
const invitationToken = new URL(location.href).searchParams.get("invitation");
const token = sessionStorage.getItem("delta:token");
if (invitationToken)
  void showInvitation(invitationToken, connect).catch(report);
else if (token)
  void connect(token).catch((error) => {
    sessionStorage.removeItem("delta:token");
    get("app").hidden = true;
    get("login").hidden = false;
    get("login-error").textContent =
      error instanceof Error ? error.message : String(error);
  });
