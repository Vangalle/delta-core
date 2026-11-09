import type {
  Command,
  Event,
  Snapshot,
  Member,
  WorkspaceInfo,
  Invitation,
  InviteMember,
  Receipt,
  BackendInfo,
} from "./generated.ts";
export type * from "./generated.ts";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type SubscriptionOptions = {
  signal: AbortSignal;
  retryMs?: number;
  onStatus?: (
    status: "connecting" | "live" | "reconnecting" | "disconnected",
  ) => void;
};

export class DeltaClient {
  private base: string;
  private token: string;
  constructor(base: string, token: string) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
  }

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
    });
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as T;
  }

  me(): Promise<Member> {
    return this.request("/me");
  }
  members(): Promise<Member[]> {
    return this.request("/members");
  }
  invite(body: InviteMember): Promise<Invitation> {
    return this.request("/members", "POST", body);
  }
  backends(): Promise<BackendInfo[]> {
    return this.request("/backends");
  }
  workspaces(): Promise<WorkspaceInfo[]> {
    return this.request("/workspaces");
  }
  createWorkspace(title: string): Promise<WorkspaceInfo> {
    return this.request("/workspaces", "POST", { title });
  }
  snapshot(workspace: string): Promise<Snapshot> {
    return this.request(`/workspaces/${encodeURIComponent(workspace)}`);
  }
  command(workspace: string, command: Command): Promise<Receipt> {
    return this.request(
      `/workspaces/${encodeURIComponent(workspace)}/commands`,
      "POST",
      command,
    );
  }

  async subscribe(
    workspace: string,
    after: number,
    onEvent: (event: Event) => void,
    options: SubscriptionOptions,
  ): Promise<void> {
    let cursor = after;
    let attempt = 0;
    while (!options.signal.aborted) {
      options.onStatus?.(attempt ? "reconnecting" : "connecting");
      try {
        const response = await fetch(
          `${this.base}/api/v1/workspaces/${encodeURIComponent(workspace)}/events?after=${cursor}`,
          {
            headers: { Authorization: `Bearer ${this.token}` },
            signal: options.signal,
            credentials: "omit",
          },
        );
        if (!response.ok) throw await apiError(response);
        if (!response.body)
          throw new Error("The host did not provide an event stream");
        options.onStatus?.("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!options.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 16_777_216)
              throw new Error("Event record exceeds the client limit");
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
              const record = buffer.slice(0, match.index);
              buffer = buffer.slice(match.index + match[0].length);
              const data = record
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue;
              const event = JSON.parse(data) as Event;
              if (
                !Number.isSafeInteger(event.sequence) ||
                event.sequence < 0 ||
                !event.change
              )
                throw new Error("Invalid event envelope");
              if (event.sequence > cursor) {
                onEvent(event);
                cursor = event.sequence;
                attempt = 0;
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (options.signal.aborted) break;
        if (!(error instanceof TypeError)) {
          options.onStatus?.("disconnected");
          throw error;
        }
      }
      if (!options.signal.aborted) {
        attempt++;
        options.onStatus?.("reconnecting");
        await delay(
          Math.min(
            (options.retryMs ?? 300) * 2 ** Math.min(attempt - 1, 4),
            5000,
          ),
          options.signal,
        );
      }
    }
    options.onStatus?.("disconnected");
  }
}

export function applyEvent(snapshot: Snapshot, event: Event): void {
  if (event.sequence <= snapshot.cursor) return;
  const c = event.change;
  if (c.type === "inserted") {
    const anchor = c.after
      ? snapshot.entries.findIndex((e) => e.id === c.after)
      : -1;
    snapshot.entries.splice(
      anchor < 0 ? snapshot.entries.length : anchor + 1,
      0,
      structuredClone(c.entry),
    );
  } else {
    const e = snapshot.entries.find((e) => e.id === c.id);
    if (e) {
      if (c.type === "text_published") {
        e.content = { type: "text", text: c.text };
        e.revision = c.revision;
        e.author = c.actor;
        e.quotes = structuredClone(c.quotes ?? []);
      } else if (c.type === "terminal_output" && e.content.type === "terminal")
        e.content.output.push(c.data);
      else if (
        c.type === "session_state" &&
        (e.content.type === "terminal" || e.content.type === "agent")
      )
        e.content.status = c.status;
      else if (c.type === "agent_activity" && e.content.type === "agent") {
        e.content.activities.push(c.activity);
        if (c.activity.type === "settled") e.content.status = "idle";
        if (c.activity.type === "failed") e.content.status = "failed";
      }
    }
  }
  snapshot.cursor = event.sequence;
}

async function apiError(response: Response): Promise<ApiError> {
  const value = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };
  return new ApiError(
    response.status,
    value.code ?? "http_error",
    value.message ?? `Host returned HTTP ${response.status}`,
  );
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
