import {
  DeltaClient,
  type Member,
  type Snapshot,
  type Role,
} from "@delta-core/client";
import { get, node, button } from "./ui.ts";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export class People {
  private workspace = "";
  constructor(
    private client: () => DeltaClient,
    private identity: () => Member,
    private current: () => Snapshot | undefined,
    private changed: () => Promise<void>,
  ) {
    get("friends").addEventListener("click", () => {
      get<HTMLInputElement>("friend-own-code").value = this.identity().id;
      get<HTMLInputElement>("own-login-token").value =
        sessionStorage.getItem("delta:token") ?? "";
      get<HTMLInputElement>("own-login-token").type = "password";
      get("show-login-token").textContent = "Show login token";
      get<HTMLDialogElement>("friends-dialog").showModal();
      void this.friends().catch((e) => this.error("friends-error", e));
    });
    get("show-login-token").addEventListener("click", () => {
      const input = get<HTMLInputElement>("own-login-token");
      input.type = input.type === "password" ? "text" : "password";
      get("show-login-token").textContent =
        input.type === "password" ? "Show login token" : "Hide login token";
    });
    get("close-friends").addEventListener("click", () =>
      get<HTMLDialogElement>("friends-dialog").close(),
    );
    get("refresh-friends").addEventListener(
      "click",
      () => void this.friends().catch((e) => this.error("friends-error", e)),
    );
    get("friend-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.run("friends-error", async () => {
        await this.client().requestFriend(
          get<HTMLInputElement>("friend-code").value.trim(),
        );
        await this.friends();
      });
    });
    get("invite").addEventListener(
      "click",
      () => void this.open().catch((e) => this.error("invite-error", e)),
    );
    get("close-invite").addEventListener("click", () =>
      get<HTMLDialogElement>("invite-dialog").close(),
    );
    get("invite-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.run("invite-error", async () => {
        const invitation = await this.client().invite(this.workspace, {
          name: get<HTMLInputElement>("invite-name").value,
          role: get<HTMLSelectElement>("invite-role").value as Role,
        });
        get<HTMLTextAreaElement>("invitation-token").value =
          `${location.origin}/?invitation=${encodeURIComponent(invitation.token)}`;
        get("invitation-result").hidden = false;
      });
    });
  }
  private error(id: string, error: unknown) {
    get(id).textContent = message(error);
  }
  private async run(id: string, action: () => Promise<void>) {
    get(id).textContent = "";
    try {
      await action();
    } catch (error) {
      this.error(id, error);
    }
  }
  private async friends() {
    const friends = await this.client().friends();
    const list = get("friends-list");
    list.replaceChildren();
    if (!friends.length)
      list.append(
        node(
          "p",
          "muted",
          "No friends yet. Share your code or send a request.",
        ),
      );
    for (const friend of friends) {
      const row = node("div", "person-row");
      row.dataset.memberId = friend.peer.id;
      row.append(
        node("span", "", friend.peer.name),
        node(
          "small",
          "muted",
          friend.status === "friend"
            ? "Friend"
            : friend.status === "incoming"
              ? "Incoming request"
              : "Pending",
        ),
      );
      if (friend.status === "incoming")
        row.append(
          button(
            "Accept friend",
            () =>
              void this.run("friends-error", async () => {
                await this.client().acceptFriend(friend.peer.id);
                await this.friends();
              }),
          ),
        );
      list.append(row);
    }
  }
  private async open() {
    const workspace = this.current();
    if (!workspace) return;
    this.workspace = workspace.workspace.id;
    get("invite-title").textContent = `Invite to ${workspace.workspace.title}`;
    get("invitation-result").hidden = true;
    get("invite-error").textContent = "";
    get<HTMLTextAreaElement>("invitation-token").value = "";
    get<HTMLSelectElement>("invite-role").value = "editor";
    get<HTMLOptionElement>("invite-executor").hidden =
      this.identity().role !== "owner";
    get<HTMLDetailsElement>("workspace-actions").removeAttribute("open");
    get<HTMLDialogElement>("invite-dialog").showModal();
    await this.members();
  }
  private async members() {
    const id = this.workspace;
    const [members, friends] = await Promise.all([
      this.client().members(id),
      this.client().friends(),
    ]);
    if (id !== this.workspace) return;
    const roster = get("workspace-members");
    roster.replaceChildren();
    for (const member of members) {
      const row = node("div", "person-row");
      row.append(
        node("span", "", member.name),
        node("small", "muted", member.role),
      );
      roster.append(row);
    }
    const list = get("workspace-friends");
    list.replaceChildren();
    const eligible = friends.filter(
      (friend) =>
        friend.status === "friend" &&
        !members.some((member) => member.id === friend.peer.id),
    );
    if (!eligible.length)
      list.append(
        node(
          "p",
          "muted",
          "No other confirmed friends to add. New people can use an invitation below.",
        ),
      );
    for (const friend of eligible) {
      const row = node("div", "person-row");
      row.dataset.memberId = friend.peer.id;
      const add = button(
        "Add",
        () =>
          void this.run("invite-error", async () => {
            add.disabled = true;
            try {
              await this.client().addFriend(id, friend.peer.id);
              await this.members();
              await this.changed();
            } finally {
              add.disabled = false;
            }
          }),
      );
      row.append(
        node("span", "", friend.peer.name),
        node("small", "muted", "Editor"),
        add,
      );
      list.append(row);
    }
  }
}
export async function showInvitation(
  token: string,
  connect: (token: string) => Promise<void>,
) {
  const landing = get("invitation-landing");
  landing.hidden = false;
  get("login").hidden = true;
  get("app").hidden = true;
  const error = get("invitation-error");
  const form = get<HTMLFormElement>("accept-invitation-form");
  try {
    const preview = await new DeltaClient(
      location.origin,
      "",
    ).invitationPreview(token);
    get("invitation-heading").textContent = `Join ${preview.workspace.title}`;
    get("invitation-access").textContent =
      `Access: ${preview.role}. Only this workspace is included. One use; expires ${new Date(preview.expires_at * 1000).toLocaleString()}.`;
    get<HTMLInputElement>("accept-name").value = preview.name;
    const updateIdentity = async () => {
      const credential = sessionStorage.getItem("delta:token");
      get("invitation-new-identity").hidden = !credential;
      get<HTMLInputElement>("accept-name").disabled = !!credential;
      if (credential) {
        try {
          const account = await new DeltaClient(
            location.origin,
            credential,
          ).me();
          get("invitation-identity").textContent =
            `Joining as ${account.name}; your existing identity is kept.`;
        } catch {
          get("invitation-identity").textContent =
            "Stored login is unavailable. Use a new identity or sign in with your member token.";
        }
      } else
        get("invitation-identity").textContent =
          "A new identity and private login credential will be created for you.";
    };
    get("invitation-new-identity").addEventListener("click", () => {
      sessionStorage.removeItem("delta:token");
      void updateIdentity();
    });
    await updateIdentity();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submit = get<HTMLButtonElement>("accept-invitation");
      submit.disabled = true;
      error.textContent = "";
      void (async () => {
        try {
          const credential = sessionStorage.getItem("delta:token");
          const accepted = await new DeltaClient(
            location.origin,
            credential ?? "",
          ).acceptInvitation({
            token,
            name: get<HTMLInputElement>("accept-name").value,
          });
          const login = accepted.login_token ?? credential;
          if (!login) throw new Error("No login credential was issued");
          sessionStorage.setItem("delta:token", login);
          history.replaceState(
            null,
            "",
            `/?workspace=${encodeURIComponent(accepted.workspace.id)}`,
          );
          await connect(login);
          landing.hidden = true;
        } catch (e) {
          error.textContent = message(e);
        } finally {
          submit.disabled = false;
        }
      })();
    });
  } catch {
    form.hidden = true;
    get("invitation-heading").textContent = "Invitation unavailable";
    error.textContent =
      "This invitation is unavailable, expired, or has already been used.";
  }
}
