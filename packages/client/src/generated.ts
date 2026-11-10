export type Role = "owner" | "executor" | "editor" | "viewer";
export type Command =
  | {
      type: "join_workspace";
    }
  | {
      type: "restore_chronological_order";
    }
  | {
      mode: ReplyMode;
      type: "set_reply_mode";
    }
  | {
      after?: string | null;
      backend: string;
      id: string;
      quotes?: ContextQuote[];
      text: string;
      type: "submit_message";
    }
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
export type ReplyMode = "auto" | "mentions_only";
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
      actor: string;
      type: "desktop_terminal_opened";
    }
  | {
      can_execute: boolean;
      member: Member;
      type: "member_role_changed";
    }
  | {
      member: Member;
      type: "member_added";
    }
  | {
      ids: string[];
      type: "order_restored";
    }
  | {
      member: string;
      type: "participant_joined";
    }
  | {
      explicit: boolean;
      mode: ReplyMode;
      type: "reply_mode_changed";
    }
  | {
      after?: string | null;
      entry: Entry;
      type: "inserted";
    }
  | {
      actor: string;
      id: string;
      mentions?: Mention[];
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
      source_entry?: string | null;
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
export type MentionKind = "user" | "agent" | "thread";
export type FriendStatus = "incoming" | "outgoing" | "friend";
export type AgentReplyOutcome = "queued" | "permission_required" | "failed";

export interface Contract {
  accept_invitation: AcceptInvitation;
  accepted_invitation: AcceptedInvitation;
  add_friend: AddFriend;
  backend: BackendInfo;
  command: Command;
  create_workspace: CreateWorkspace;
  error: ApiError;
  event: Event;
  friend: Friend;
  friend_target: FriendTarget;
  invitation: Invitation;
  invitation_preview: InvitationPreview;
  invite_member: InviteMember;
  member: Member;
  open_desktop_terminal: OpenDesktopTerminal;
  receipt: Receipt;
  set_member_role: SetMemberRole;
  snapshot: Snapshot;
  workspace_info: WorkspaceInfo;
  workspace_invitation: WorkspaceInvitation;
}
export interface AcceptInvitation {
  name: string;
  token: string;
}
export interface AcceptedInvitation {
  login_token?: string | null;
  member: Member;
  workspace: WorkspaceInfo;
}
export interface Member {
  id: string;
  name: string;
  role: Role;
}
export interface WorkspaceInfo {
  id: string;
  title: string;
}
export interface AddFriend {
  member_id: string;
  role: Role;
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
  mentions?: Mention[];
  quotes?: ContextQuote[];
  revision: number;
}
export interface Mention {
  kind: MentionKind;
  label: string;
  target: string;
}
export interface Friend {
  peer: Person;
  status: FriendStatus;
}
export interface Person {
  id: string;
  name: string;
}
export interface FriendTarget {
  member_id: string;
}
export interface Invitation {
  member: Member;
  token: string;
}
export interface InvitationPreview {
  expires_at: number;
  name: string;
  role: Role;
  workspace: WorkspaceInfo;
}
export interface InviteMember {
  name: string;
  role: Role;
}
export interface OpenDesktopTerminal {}
export interface Receipt {
  agent_reply?: AgentReplyOutcome | null;
  cursor: number;
}
export interface SetMemberRole {
  role: Role;
}
export interface Snapshot {
  access?: WorkspaceAccess | null;
  capabilities?: string[];
  collaboration?: Collaboration;
  cursor: number;
  entries: Entry[];
  members?: Member[];
  self_id?: string | null;
  workspace: WorkspaceInfo;
}
export interface WorkspaceAccess {
  can_execute: boolean;
  role: Role;
}
export interface Collaboration {
  mode_explicit: boolean;
  participants: string[];
  reply_mode: ReplyMode;
}
export interface WorkspaceInvitation {
  expires_at: number;
  name: string;
  role: Role;
  token: string;
  workspace: WorkspaceInfo;
}
