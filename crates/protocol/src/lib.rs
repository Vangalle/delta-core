use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: &str = "v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Role { Owner, Executor, Editor, Viewer }

impl Role {
    pub fn can_edit(self) -> bool { self != Self::Viewer }
    pub fn can_execute(self) -> bool { matches!(self, Self::Owner | Self::Executor) }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Member { pub id: String, pub name: String, pub role: Role }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus { Running, Idle, Closed, Interrupted, Failed }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind { Thread, User }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Activity {
    MessageStart { message_id: String },
    TextDelta { message_id: String, index: u64, text: String },
    MessageEnd { message_id: String, text: String },
    ToolStart { call_id: String, name: String, args: Value },
    ToolUpdate { call_id: String, result: Value },
    ToolEnd { call_id: String, result: Value, is_error: bool },
    Settled { aborted: bool },
    Failed { message: String },
    Backend { data: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Text { text: String },
    Terminal { controller: String, status: SessionStatus, output: Vec<String> },
    Agent { backend: String, controller: String, status: SessionStatus, prompt: String, activities: Vec<Activity> },
    Reference { kind: ReferenceKind, target: String, label: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Entry {
    pub id: String,
    pub revision: u64,
    pub author: String,
    pub content: Content,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    PublishText { id: String, base_revision: u64, text: String, after: Option<String> },
    InsertReference { id: String, kind: ReferenceKind, target: String, label: String, after: Option<String> },
    OpenTerminal { id: String, after: Option<String> },
    TerminalInput { id: String, data: String },
    ResizeTerminal { id: String, cols: u16, rows: u16 },
    CloseTerminal { id: String },
    PromptAgent { id: String, backend: String, prompt: String, after: Option<String> },
    AbortAgent { id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Change {
    Inserted { entry: Entry, after: Option<String> },
    TextPublished { id: String, revision: u64, text: String, actor: String },
    TerminalOutput { id: String, data: String },
    SessionState { id: String, status: SessionStatus },
    AgentActivity { id: String, activity: Activity },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Event { pub sequence: u64, pub change: Change }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceInfo { pub id: String, pub title: String }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Snapshot { pub workspace: WorkspaceInfo, pub cursor: u64, pub entries: Vec<Entry> }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateWorkspace { pub title: String }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InviteMember { pub name: String, pub role: Role }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Invitation { pub member: Member, pub token: String }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApiError { pub code: String, pub message: String }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Receipt { pub cursor: u64 }

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BackendInfo { pub id: String, pub label: String }

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
