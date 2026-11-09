export type Command =
  | {
      after?: string | null;
      base_revision: number;
      id: string;
      quotes?: ContextQuote[];
      text: string;
      type: "publish_text";
    }
  | {
      after?: string | null;
      id: string;
      kind: ReferenceKind;
      label: string;
      target: string;
      type: "insert_reference";
    }
  | {
      after?: string | null;
      id: string;
      type: "open_terminal";
    }
  | {
      data: string;
      id: string;
      type: "terminal_input";
    }
  | {
      cols: number;
      id: string;
      rows: number;
      type: "resize_terminal";
    }
  | {
      id: string;
      type: "close_terminal";
    }
  | {
      after?: string | null;
      backend: string;
      id: string;
      prompt: string;
      quotes?: ContextQuote[];
      type: "prompt_agent";
    }
  | {
      id: string;
      type: "abort_agent";
    }
  | {
      id: string;
      request_id: string;
      response: InteractionResponse;
      type: "respond_agent";
    };
export type ReferenceKind = "thread" | "user";
export type InteractionResponse =
  | {
      confirmed: boolean;
      type: "confirm";
    }
  | {
      type: "value";
      value: string;
    }
  | {
      type: "cancel";
    };
export type Change =
  | {
      after?: string | null;
      entry: Entry;
      type: "inserted";
    }
  | {
      actor: string;
      id: string;
      quotes?: ContextQuote[];
      revision: number;
      text: string;
      type: "text_published";
    }
  | {
      data: string;
      id: string;
      type: "terminal_output";
    }
  | {
      id: string;
      status: SessionStatus;
      type: "session_state";
    }
  | {
      activity: Activity;
      id: string;
      type: "agent_activity";
    };
export type Content =
  | {
      text: string;
      type: "text";
    }
  | {
      controller: string;
      output: string[];
      status: SessionStatus;
      type: "terminal";
    }
  | {
      activities: Activity[];
      backend: string;
      controller: string;
      prompt: string;
      status: SessionStatus;
      type: "agent";
    }
  | {
      kind: ReferenceKind;
      label: string;
      target: string;
      type: "reference";
    };
export type SessionStatus = "running" | "idle" | "closed" | "interrupted" | "failed";
export type Activity =
  | {
      initial_value?: string | null;
      kind: InteractionKind;
      message: string;
      options: string[];
      request_id: string;
      title: string;
      type: "interaction_requested";
    }
  | {
      request_id: string;
      type: "interaction_resolved";
    }
  | {
      actor: string;
      quotes?: ContextQuote[];
      text: string;
      type: "prompt";
    }
  | {
      message_id: string;
      type: "message_start";
    }
  | {
      index: number;
      message_id: string;
      text: string;
      type: "text_delta";
    }
  | {
      message_id: string;
      text: string;
      type: "message_end";
    }
  | {
      args: unknown;
      call_id: string;
      name: string;
      type: "tool_start";
    }
  | {
      call_id: string;
      result: unknown;
      type: "tool_update";
    }
  | {
      call_id: string;
      is_error: boolean;
      result: unknown;
      type: "tool_end";
    }
  | {
      aborted: boolean;
      type: "settled";
    }
  | {
      message: string;
      type: "failed";
    }
  | {
      data: unknown;
      type: "backend";
    };
export type InteractionKind = "confirm" | "select" | "input" | "editor";
export type Role = "owner" | "executor" | "editor" | "viewer";

export interface Contract {
  backend: BackendInfo;
  command: Command;
  create_workspace: CreateWorkspace;
  error: ApiError;
  event: Event;
  invitation: Invitation;
  invite_member: InviteMember;
  member: Member;
  receipt: Receipt;
  snapshot: Snapshot;
  workspace_info: WorkspaceInfo;
}
export interface BackendInfo {
  id: string;
  label: string;
}
export interface ContextQuote {
  cursor: number;
  entry_id: string;
  fragment: string;
  quote: string;
  revision: number;
  workspace_id: string;
}
export interface CreateWorkspace {
  title: string;
}
export interface ApiError {
  code: string;
  message: string;
}
export interface Event {
  change: Change;
  sequence: number;
}
export interface Entry {
  author: string;
  content: Content;
  id: string;
  quotes?: ContextQuote[];
  revision: number;
}
export interface Invitation {
  member: Member;
  token: string;
}
export interface Member {
  id: string;
  name: string;
  role: Role;
}
export interface InviteMember {
  name: string;
  role: Role;
}
export interface Receipt {
  cursor: number;
}
export interface Snapshot {
  cursor: number;
  entries: Entry[];
  workspace: WorkspaceInfo;
}
export interface WorkspaceInfo {
  id: string;
  title: string;
}
