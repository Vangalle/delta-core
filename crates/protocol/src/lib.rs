use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: &str = "v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Executor,
    Editor,
    Viewer,
}

impl Role {
    pub fn can_edit(self) -> bool {
        self != Self::Viewer
    }
    pub fn can_execute(self) -> bool {
        matches!(self, Self::Owner | Self::Executor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    Idle,
    Closed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Thread,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    Confirm,
    Select,
    Input,
    Editor,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractionResponse {
    Confirm { confirmed: bool },
    Value { value: String },
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ContextQuote {
    pub workspace_id: String,
    pub entry_id: String,
    pub fragment: String,
    pub revision: u64,
    pub cursor: u64,
    pub quote: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReplyMode {
    #[default]
    Auto,
    MentionsOnly,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Collaboration {
    pub reply_mode: ReplyMode,
    pub mode_explicit: bool,
    pub participants: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MentionKind {
    User,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Mention {
    pub kind: MentionKind,
    pub target: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Activity {
    InteractionRequested {
        request_id: String,
        kind: InteractionKind,
        title: String,
        message: String,
        options: Vec<String>,
        initial_value: Option<String>,
    },
    InteractionResolved {
        request_id: String,
    },
    Prompt {
        text: String,
        actor: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        quotes: Vec<ContextQuote>,
    },
    MessageStart {
        message_id: String,
    },
    TextDelta {
        message_id: String,
        index: u64,
        text: String,
    },
    MessageEnd {
        message_id: String,
        text: String,
    },
    ToolStart {
        call_id: String,
        name: String,
        args: Value,
    },
    ToolUpdate {
        call_id: String,
        result: Value,
    },
    ToolEnd {
        call_id: String,
        result: Value,
        is_error: bool,
    },
    Settled {
        aborted: bool,
    },
    Failed {
        message: String,
    },
    Backend {
        data: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Text {
        text: String,
    },
    Terminal {
        controller: String,
        status: SessionStatus,
        output: Vec<String>,
    },
    Agent {
        backend: String,
        controller: String,
        status: SessionStatus,
        prompt: String,
        activities: Vec<Activity>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_entry: Option<String>,
    },
    Reference {
        kind: ReferenceKind,
        target: String,
        label: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Entry {
    pub id: String,
    pub revision: u64,
    pub author: String,
    pub content: Content,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quotes: Vec<ContextQuote>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    JoinWorkspace,
    SetReplyMode {
        mode: ReplyMode,
    },
    SubmitMessage {
        id: String,
        text: String,
        after: Option<String>,
        backend: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        quotes: Vec<ContextQuote>,
    },
    PublishText {
        id: String,
        base_revision: u64,
        text: String,
        after: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        quotes: Vec<ContextQuote>,
    },
    InsertReference {
        id: String,
        kind: ReferenceKind,
        target: String,
        label: String,
        after: Option<String>,
    },
    OpenTerminal {
        id: String,
        after: Option<String>,
    },
    TerminalInput {
        id: String,
        data: String,
    },
    ResizeTerminal {
        id: String,
        cols: u16,
        rows: u16,
    },
    CloseTerminal {
        id: String,
    },
    PromptAgent {
        id: String,
        backend: String,
        prompt: String,
        after: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        quotes: Vec<ContextQuote>,
    },
    AbortAgent {
        id: String,
    },
    RespondAgent {
        id: String,
        request_id: String,
        response: InteractionResponse,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Change {
    ParticipantJoined {
        member: String,
    },
    ReplyModeChanged {
        mode: ReplyMode,
        explicit: bool,
    },
    Inserted {
        entry: Entry,
        after: Option<String>,
    },
    TextPublished {
        id: String,
        revision: u64,
        text: String,
        actor: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        quotes: Vec<ContextQuote>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mentions: Vec<Mention>,
    },
    TerminalOutput {
        id: String,
        data: String,
    },
    SessionState {
        id: String,
        status: SessionStatus,
    },
    AgentActivity {
        id: String,
        activity: Activity,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Event {
    pub sequence: u64,
    pub change: Change,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceInfo {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Snapshot {
    pub workspace: WorkspaceInfo,
    pub cursor: u64,
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub collaboration: Collaboration,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateWorkspace {
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InviteMember {
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Invitation {
    pub member: Member,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentReplyOutcome {
    Queued,
    PermissionRequired,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Receipt {
    pub cursor: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_reply: Option<AgentReplyOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BackendInfo {
    pub id: String,
    pub label: String,
}

#[derive(JsonSchema)]
pub struct Contract {
    pub command: Command,
    pub event: Event,
    pub snapshot: Snapshot,
    pub member: Member,
    pub create_workspace: CreateWorkspace,
    pub invitation: Invitation,
    pub invite_member: InviteMember,
    pub error: ApiError,
    pub receipt: Receipt,
    pub workspace_info: WorkspaceInfo,
    pub backend: BackendInfo,
}
