use crate::auth;
mod access;
use access::{authorize, shared_reference};
use base64::{Engine, engine::general_purpose::STANDARD};
use delta_adapters::{
    agent::{AgentBackend, AgentCommand},
    journal::Journal,
    pi::PiBackend,
    terminal::{Terminal, TerminalEvent},
};
use delta_kernel::{Effect, KernelError, Workspace};
use delta_protocol::*;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, broadcast, mpsc, watch};

#[derive(Debug)]
pub enum ServiceError {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    MembershipConflict,
    Invalid,
    Unavailable,
    Internal,
}

impl From<KernelError> for ServiceError {
    fn from(e: KernelError) -> Self {
        match e {
            KernelError::Forbidden => Self::Forbidden,
            KernelError::NotFound => Self::NotFound,
            KernelError::Conflict => Self::Conflict,
            KernelError::Invalid => Self::Invalid,
            KernelError::Unavailable => Self::Unavailable,
        }
    }
}

fn internal(error: impl std::fmt::Display) -> ServiceError {
    eprintln!("delta host: {error}");
    ServiceError::Internal
}

struct State {
    journal: Journal,
    workspaces: HashMap<String, Workspace>,
    cursors: HashMap<String, u64>,
    terminals: HashMap<(String, String), Terminal>,
    agents: HashMap<(String, String), mpsc::Sender<AgentCommand>>,
    agent_readers: HashMap<(String, String), tokio::task::AbortHandle>,
    backends: HashMap<String, Arc<dyn AgentBackend>>,
    default_reply_mode: ReplyMode,
}

fn quoted_context(quotes: &[ContextQuote]) -> String {
    if quotes.is_empty() {
        return String::new();
    }
    format!(
        "\n\nQuoted excerpts (user-supplied snapshots with source anchors):\n{}",
        serde_json::to_string(quotes).unwrap_or_default()
    )
}

fn inline_context(state: &State, id: &str, text: &str) -> String {
    delta_kernel::parse_mentions(text, "pi")
        .into_iter()
        .filter(|m| {
            m.kind == MentionKind::Thread
                && m.target != id
                && shared_reference(state, id, &m.target)
        })
        .map(|m| {
            format!(
                "\n\nReferenced workspace {} ({}):\n{}",
                m.label,
                m.target,
                published_context(state, &m.target, false)
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn published_context(state: &State, id: &str, include_references: bool) -> String {
    let Some(workspace) = state.workspaces.get(id) else {
        return String::new();
    };
    workspace
        .entries
        .iter()
        .filter_map(|entry| match &entry.content {
            Content::Text { text } => Some(format!(
                "{text}{}{}",
                quoted_context(&entry.quotes),
                if include_references {
                    inline_context(state, id, text)
                } else {
                    String::new()
                }
            )),
            Content::Agent { activities, .. } => Some(
                activities
                    .iter()
                    .filter_map(|activity| match activity {
                        Activity::MessageEnd { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n"),
            ),
            Content::Reference {
                kind: ReferenceKind::Thread,
                target,
                label,
            } if include_references && target != id && shared_reference(state, id, target) => {
                Some(format!(
                    "Referenced workspace {label} ({target}):\n{}",
                    published_context(state, target, false)
                ))
            }
            Content::Reference {
                kind: ReferenceKind::User,
                label,
                ..
            } => Some(format!("Mentioned collaborator: @{label}")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub struct Subscription {
    workspace: String,
    receiver: broadcast::Receiver<(String, Event)>,
}
impl Subscription {
    pub async fn recv(&mut self) -> Result<(String, Event), broadcast::error::RecvError> {
        loop {
            let event = self.receiver.recv().await?;
            if event.0 == self.workspace {
                return Ok(event);
            }
        }
    }
}

#[derive(Clone)]
pub struct Service {
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<(String, Event)>,
    stopping: watch::Sender<bool>,
    cwd: PathBuf,
    shell: String,
    shell_login: bool,
    desktop_terminal: Option<Arc<dyn delta_adapters::desktop_terminal::DesktopTerminalBackend>>,
}

impl Service {
    pub fn open(data: &Path, cwd: &Path, owner_token: &str) -> Result<Self, ServiceError> {
        std::fs::create_dir_all(data).map_err(internal)?;
        let mut journal = Journal::open(&data.join("events.sqlite")).map_err(internal)?;
        if journal.members().map_err(internal)?.is_empty() {
            journal
                .add_member(
                    &Member {
                        id: "owner".into(),
                        name: "Host".into(),
                        role: Role::Owner,
                    },
                    &auth::hash(owner_token),
                )
                .map_err(internal)?;
        }
        if journal.workspaces().map_err(internal)?.is_empty() {
            journal
                .create_workspace(&WorkspaceInfo {
                    id: uuid::Uuid::new_v4().to_string(),
                    title: "Workspace".into(),
                })
                .map_err(internal)?;
        }
        journal.migrate_workspace_access().map_err(internal)?;
        let mut workspaces = HashMap::new();
        let mut cursors = HashMap::new();
        for info in journal.workspaces().map_err(internal)? {
            let mut workspace = Workspace::new(info.id.clone(), info.title);
            let mut cursor = 0;
            for event in journal.load(&info.id, 0).map_err(internal)? {
                cursor = event.sequence;
                workspace.apply(event.change);
            }
            let interrupted = workspace
                .entries
                .iter()
                .filter_map(|entry| match &entry.content {
                    Content::Terminal {
                        status: SessionStatus::Running | SessionStatus::Idle,
                        ..
                    }
                    | Content::Agent {
                        status: SessionStatus::Running | SessionStatus::Idle,
                        ..
                    } => Some(Change::SessionState {
                        id: entry.id.clone(),
                        status: SessionStatus::Interrupted,
                    }),
                    _ => None,
                })
                .collect::<Vec<_>>();
            for event in journal.append(&info.id, &interrupted).map_err(internal)? {
                cursor = event.sequence;
                workspace.apply(event.change);
            }
            cursors.insert(info.id.clone(), cursor);
            workspaces.insert(info.id, workspace);
        }
        let backends = HashMap::from([(
            "pi".into(),
            Arc::new(PiBackend::default()) as Arc<dyn AgentBackend>,
        )]);
        let (events, _) = broadcast::channel(1024);
        let (stopping, _) = watch::channel(false);
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                journal,
                workspaces,
                cursors,
                terminals: HashMap::new(),
                agents: HashMap::new(),
                agent_readers: HashMap::new(),
                backends,
                default_reply_mode: ReplyMode::Auto,
            })),
            events,
            stopping,
            cwd: cwd.canonicalize().map_err(internal)?,
            shell: std::env::var("DELTA_SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            shell_login: false,
            desktop_terminal: None,
        })
    }

    pub fn with_terminal_shell(mut self, shell: String, login: bool) -> Self {
        self.shell = shell;
        self.shell_login = login;
        self
    }
    pub fn with_desktop_terminal(
        mut self,
        backend: Arc<dyn delta_adapters::desktop_terminal::DesktopTerminalBackend>,
    ) -> Self {
        self.desktop_terminal = Some(backend);
        self
    }

    pub async fn set_default_reply_mode(&self, mode: ReplyMode) -> Result<(), ServiceError> {
        let mut state = self.state.lock().await;
        let untouched = state
            .workspaces
            .iter()
            .filter(|(id, workspace)| {
                workspace.entries.is_empty()
                    && workspace.collaboration.participants.is_empty()
                    && !workspace.collaboration.mode_explicit
                    && workspace.collaboration.reply_mode != mode
                    && *state.cursors.get(*id).unwrap_or(&0) == 0
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in untouched {
            self.commit(
                &mut state,
                &id,
                &[Change::ReplyModeChanged {
                    mode,
                    explicit: false,
                }],
            )?;
        }
        state.default_reply_mode = mode;
        Ok(())
    }

    pub async fn register_backend(&self, id: String, backend: Arc<dyn AgentBackend>) {
        self.state.lock().await.backends.insert(id, backend);
    }

    pub async fn authenticate(&self, token: &str) -> Result<Member, ServiceError> {
        if *self.stopping.borrow() {
            return Err(ServiceError::Unavailable);
        }
        if token.len() > 256 || token.is_empty() {
            return Err(ServiceError::Unauthorized);
        }
        self.state
            .lock()
            .await
            .journal
            .authenticate(&auth::hash(token))
            .map_err(internal)?
            .ok_or(ServiceError::Unauthorized)
    }

    pub async fn members(&self, actor: &Member, id: &str) -> Result<Vec<Member>, ServiceError> {
        let s = self.state.lock().await;
        authorize(&s, actor, id)?;
        s.journal.workspace_members(id).map_err(internal)
    }

    pub async fn workspaces(&self, actor: &Member) -> Result<Vec<WorkspaceInfo>, ServiceError> {
        let s = self.state.lock().await;
        s.journal
            .workspaces()
            .map_err(internal)?
            .into_iter()
            .filter_map(|w| match s.journal.workspace_role(&w.id, &actor.id) {
                Ok(Some(_)) => Some(Ok(w)),
                Ok(None) => None,
                Err(e) => Some(Err(internal(e))),
            })
            .collect()
    }

    pub async fn create_workspace(
        &self,
        actor: &Member,
        title: String,
    ) -> Result<WorkspaceInfo, ServiceError> {
        if !actor.role.can_edit() {
            return Err(ServiceError::Forbidden);
        }
        if title.trim().is_empty() || title.len() > 200 {
            return Err(ServiceError::Invalid);
        }
        let info = WorkspaceInfo {
            id: uuid::Uuid::new_v4().to_string(),
            title,
        };
        let mut s = self.state.lock().await;
        s.journal
            .create_scoped_workspace(&info, &actor.id)
            .map_err(internal)?;
        s.workspaces.insert(
            info.id.clone(),
            Workspace::new(info.id.clone(), info.title.clone()),
        );
        s.cursors.insert(info.id.clone(), 0);
        if s.default_reply_mode != ReplyMode::Auto {
            let mode = s.default_reply_mode;
            self.commit(
                &mut s,
                &info.id,
                &[Change::ReplyModeChanged {
                    mode,
                    explicit: false,
                }],
            )?;
        }
        Ok(info)
    }

    pub async fn backends(&self) -> Vec<BackendInfo> {
        let s = self.state.lock().await;
        let mut ids = s.backends.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids.into_iter()
            .map(|id| BackendInfo {
                label: id.clone(),
                id,
            })
            .collect()
    }

    pub async fn snapshot(&self, actor: &Member, id: &str) -> Result<Snapshot, ServiceError> {
        let s = self.state.lock().await;
        let access = authorize(&s, actor, id)?;
        let workspace = s.workspaces.get(id).ok_or(ServiceError::NotFound)?;
        let mut capabilities = vec!["member_roles".into(), "inline_threads".into()];
        if self.desktop_terminal.is_some()
            && access.can_execute
            && s.journal
                .account(&actor.id)
                .map_err(internal)?
                .is_some_and(|a| a.role == Role::Owner)
        {
            capabilities.push("desktop_terminal".into());
        }
        Ok(Snapshot {
            self_id: Some(actor.id.clone()),
            capabilities,
            access: Some(access),
            members: s.journal.workspace_members(id).map_err(internal)?,
            workspace: workspace.info.clone(),
            cursor: *s.cursors.get(id).unwrap_or(&0),
            entries: workspace.entries.clone(),
            collaboration: workspace.collaboration.clone(),
        })
    }

    pub async fn subscribe(
        &self,
        actor: &Member,
        id: &str,
        after: u64,
    ) -> Result<(Vec<Event>, Subscription), ServiceError> {
        let s = self.state.lock().await;
        authorize(&s, actor, id)?;
        if after > *s.cursors.get(id).unwrap_or(&0) {
            return Err(ServiceError::Conflict);
        }
        let receiver = self.events.subscribe();
        Ok((
            s.journal.load(id, after).map_err(internal)?,
            Subscription {
                workspace: id.into(),
                receiver,
            },
        ))
    }

    fn commit(&self, s: &mut State, id: &str, changes: &[Change]) -> Result<u64, ServiceError> {
        let events = s.journal.append(id, changes).map_err(internal)?;
        self.project_events(s, id, events)
    }

    fn project_events(
        &self,
        s: &mut State,
        id: &str,
        events: Vec<Event>,
    ) -> Result<u64, ServiceError> {
        for event in events {
            s.workspaces
                .get_mut(id)
                .ok_or(ServiceError::NotFound)?
                .apply(event.change.clone());
            s.cursors.insert(id.to_owned(), event.sequence);
            let _ = self.events.send((id.to_owned(), event));
        }
        Ok(*s.cursors.get(id).unwrap_or(&0))
    }

    async fn record(&self, id: &str, change: Change) {
        let mut s = self.state.lock().await;
        if let Err(error) = self.commit(&mut s, id, &[change]) {
            eprintln!("event persistence failed: {error:?}");
        }
    }

    pub async fn command(
        &self,
        actor: &Member,
        id: &str,
        command: Command,
    ) -> Result<Receipt, ServiceError> {
        let mut s = self.state.lock().await;
        let canonical = s
            .journal
            .account(&actor.id)
            .map_err(internal)?
            .ok_or(ServiceError::Unauthorized)?;
        let actor = &canonical;
        let access = authorize(&s, actor, id)?;
        if let Command::PublishText { text, .. }
        | Command::SubmitMessage { text, .. }
        | Command::PromptAgent { prompt: text, .. } = &command
        {
            for mention in delta_kernel::parse_mentions(text, "pi")
                .into_iter()
                .filter(|m| m.kind == MentionKind::Thread)
            {
                authorize(&s, actor, &mention.target)?;
            }
        }
        let submission = matches!(&command, Command::SubmitMessage { .. });
        let explicit_request = match &command {
            Command::SubmitMessage { text, backend, .. } => {
                delta_kernel::parse_mentions(text, backend)
                    .iter()
                    .any(|mention| mention.kind == MentionKind::Agent && mention.target == *backend)
            }
            _ => false,
        };
        if let Command::SubmitMessage { text, backend, .. } = &command {
            let members = s.journal.workspace_members(id).map_err(internal)?;
            if delta_kernel::parse_mentions(text, backend)
                .iter()
                .any(|mention| {
                    mention.kind == MentionKind::User
                        && !members.iter().any(|member| member.id == mention.target)
                })
            {
                return Err(ServiceError::NotFound);
            }
        }
        if let Command::InsertReference { kind, target, .. } = &command {
            let exists = match kind {
                ReferenceKind::Thread => authorize(&s, actor, target).is_ok(),
                ReferenceKind::User => s
                    .journal
                    .workspace_members(id)
                    .map_err(internal)?
                    .iter()
                    .any(|m| &m.id == target),
            };
            if !exists {
                return Err(ServiceError::NotFound);
            }
        }
        match &command {
            Command::PromptAgent { backend, .. } if !s.backends.contains_key(backend) => {
                return Err(ServiceError::Invalid);
            }
            _ => {}
        }
        if let Command::PublishText { quotes, .. }
        | Command::PromptAgent { quotes, .. }
        | Command::SubmitMessage { quotes, .. } = &command
        {
            delta_kernel::validate_quotes(quotes)?;
            for quote in quotes {
                authorize(&s, actor, &quote.workspace_id)?;
                let source = s
                    .workspaces
                    .get(&quote.workspace_id)
                    .ok_or(ServiceError::NotFound)?;
                delta_kernel::validate_quote_source(
                    source,
                    *s.cursors.get(&quote.workspace_id).unwrap_or(&0),
                    quote,
                )?;
            }
        }
        let decision = s
            .workspaces
            .get(id)
            .ok_or(ServiceError::NotFound)?
            .decide_scoped(actor, access, command)?;
        let submitted_agent = if submission {
            match &decision.effect {
                Some(Effect::PromptAgent { id, backend, .. }) => {
                    if !s.backends.contains_key(backend) {
                        return Err(ServiceError::Invalid);
                    }
                    Some(id.clone())
                }
                _ => None,
            }
        } else {
            None
        };
        let mut agent_reply = if submitted_agent.is_some() {
            Some(AgentReplyOutcome::Queued)
        } else if submission && explicit_request && !access.can_execute {
            Some(AgentReplyOutcome::PermissionRequired)
        } else {
            None
        };
        if let Some(Effect::RespondAgent { id: entry, .. }) = &decision.effect {
            let sender = s
                .agents
                .get(&(id.to_owned(), entry.clone()))
                .ok_or(ServiceError::Unavailable)?;
            if sender.is_closed() || sender.capacity() == 0 {
                return Err(ServiceError::Unavailable);
            }
        }
        self.commit(&mut s, id, &decision.changes)?;
        let key = |entry: &str| (id.to_owned(), entry.to_owned());
        let result: Result<(), ServiceError> = match decision.effect {
            None => Ok(()),
            Some(Effect::OpenTerminal { id: entry }) => {
                match Terminal::spawn_with_login(&self.cwd, &self.shell, self.shell_login) {
                    Err(error) => {
                        eprintln!("terminal start: {error}");
                        self.commit(
                            &mut s,
                            id,
                            &[Change::SessionState {
                                id: entry,
                                status: SessionStatus::Failed,
                            }],
                        )?;
                        Err(ServiceError::Unavailable)
                    }
                    Ok((terminal, mut receiver)) => {
                        s.terminals.insert(key(&entry), terminal);
                        let service = self.clone();
                        let workspace = id.to_owned();
                        tokio::spawn(async move {
                            while let Some(event) = receiver.recv().await {
                                let ended = !matches!(&event, TerminalEvent::Output(_));
                                let change = match event {
                                    TerminalEvent::Output(bytes) => Change::TerminalOutput {
                                        id: entry.clone(),
                                        data: STANDARD.encode(bytes),
                                    },
                                    TerminalEvent::Exited => Change::SessionState {
                                        id: entry.clone(),
                                        status: if *service.stopping.borrow() {
                                            SessionStatus::Interrupted
                                        } else {
                                            SessionStatus::Closed
                                        },
                                    },
                                    TerminalEvent::InputFailed(error) => {
                                        eprintln!("terminal input failed: {error}");
                                        Change::SessionState {
                                            id: entry.clone(),
                                            status: SessionStatus::Failed,
                                        }
                                    }
                                };
                                service.record(&workspace, change).await;
                                if ended {
                                    break;
                                }
                            }
                            service
                                .state
                                .lock()
                                .await
                                .terminals
                                .remove(&(workspace, entry));
                        });
                        Ok(())
                    }
                }
            }
            Some(Effect::TerminalInput { id: entry, data }) => s
                .terminals
                .get_mut(&key(&entry))
                .ok_or(ServiceError::Unavailable)?
                .input(&data)
                .map_err(|_| ServiceError::Unavailable),
            Some(Effect::ResizeTerminal {
                id: entry,
                cols,
                rows,
            }) => s
                .terminals
                .get(&key(&entry))
                .ok_or(ServiceError::Unavailable)?
                .resize(cols, rows)
                .map_err(|_| ServiceError::Unavailable),
            Some(Effect::CloseTerminal { id: entry }) => s
                .terminals
                .get_mut(&key(&entry))
                .ok_or(ServiceError::Unavailable)?
                .close()
                .map_err(|_| ServiceError::Unavailable),
            Some(Effect::RespondAgent {
                id: entry,
                request_id,
                response,
            }) => s
                .agents
                .get(&key(&entry))
                .ok_or(ServiceError::Unavailable)?
                .try_send(AgentCommand::Respond {
                    request_id,
                    response,
                })
                .map_err(|_| ServiceError::Unavailable),
            Some(Effect::AbortAgent { id: entry }) => s
                .agents
                .get(&key(&entry))
                .ok_or(ServiceError::Unavailable)?
                .try_send(AgentCommand::Abort)
                .map_err(|_| ServiceError::Unavailable),
            Some(Effect::PromptAgent {
                id: entry,
                backend,
                prompt,
                quotes,
            }) => {
                if !s.agents.contains_key(&key(&entry)) {
                    let connection = s
                        .backends
                        .get(&backend)
                        .ok_or(ServiceError::Invalid)?
                        .start(&self.cwd);
                    match connection {
                        Err(error) => {
                            self.commit(
                                &mut s,
                                id,
                                &[Change::AgentActivity {
                                    id: entry.clone(),
                                    activity: Activity::Failed {
                                        message: format!("Cannot start {backend}: {error}"),
                                    },
                                }],
                            )?;
                            return if submission {
                                Ok(Receipt {
                                    cursor: *s.cursors.get(id).unwrap_or(&0),
                                    agent_reply: Some(AgentReplyOutcome::Failed),
                                })
                            } else {
                                Err(ServiceError::Unavailable)
                            };
                        }
                        Ok(mut connection) => {
                            s.agents.insert(key(&entry), connection.commands);
                            let service = self.clone();
                            let workspace = id.to_owned();
                            let agent = entry.clone();
                            let reader = tokio::spawn(async move {
                                while let Some(activity) = connection.events.recv().await {
                                    service
                                        .record(
                                            &workspace,
                                            Change::AgentActivity {
                                                id: agent.clone(),
                                                activity,
                                            },
                                        )
                                        .await;
                                }
                                let mut state = service.state.lock().await;
                                state.agents.remove(&(workspace.clone(), agent.clone()));
                                state
                                    .agent_readers
                                    .remove(&(workspace.clone(), agent.clone()));
                                let status = state
                                    .workspaces
                                    .get(&workspace)
                                    .and_then(|w| w.entry(&agent).ok())
                                    .and_then(|entry| match &entry.content {
                                        Content::Agent { status, .. } => Some(*status),
                                        _ => None,
                                    });
                                let change = match status {
                                    Some(SessionStatus::Running) => Some(Change::AgentActivity {
                                        id: agent,
                                        activity: Activity::Failed {
                                            message: "Agent backend disconnected before completion"
                                                .into(),
                                        },
                                    }),
                                    Some(SessionStatus::Idle) => Some(Change::SessionState {
                                        id: agent,
                                        status: SessionStatus::Closed,
                                    }),
                                    _ => None,
                                };
                                let persisted = change
                                    .map(|change| service.commit(&mut state, &workspace, &[change]))
                                    .transpose();
                                if let Err(error) = persisted {
                                    eprintln!("backend disconnect persistence failed: {error:?}");
                                }
                            });
                            s.agent_readers.insert(key(&entry), reader.abort_handle());
                        }
                    }
                }
                let published = published_context(&s, id, true);
                let quoted = quoted_context(&quotes);
                let references = if !submission {
                    inline_context(&s, id, &prompt)
                } else {
                    String::new()
                };
                let message = format!(
                    "Published workspace content (reference material):\n<workspace>\n{published}\n</workspace>\n\nUser request:\n{prompt}{quoted}{references}"
                );
                s.agents
                    .get(&key(&entry))
                    .ok_or(ServiceError::Unavailable)?
                    .try_send(AgentCommand::Prompt(message))
                    .map_err(|_| ServiceError::Unavailable)
            }
        };
        if let Err(error) = result {
            if let Some(agent) = submitted_agent {
                agent_reply = Some(AgentReplyOutcome::Failed);
                self.commit(&mut s, id, &[Change::AgentActivity { id: agent, activity: Activity::Failed { message: "Agent request could not be delivered; the human publication was preserved".into() } }])?;
            } else {
                return Err(error);
            }
        }
        Ok(Receipt {
            cursor: *s.cursors.get(id).unwrap_or(&0),
            agent_reply,
        })
    }

    pub fn stopping(&self) -> watch::Receiver<bool> {
        self.stopping.subscribe()
    }

    pub async fn shutdown(&self) {
        let mut s = self.state.lock().await;
        for id in s.workspaces.keys().cloned().collect::<Vec<_>>() {
            let changes = s.workspaces[&id]
                .entries
                .iter()
                .filter_map(|entry| match &entry.content {
                    Content::Terminal {
                        status: SessionStatus::Running,
                        ..
                    }
                    | Content::Agent {
                        status: SessionStatus::Running | SessionStatus::Idle,
                        ..
                    } => Some(Change::SessionState {
                        id: entry.id.clone(),
                        status: SessionStatus::Interrupted,
                    }),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let _ = self.commit(&mut s, &id, &changes);
        }
        self.stopping.send_replace(true);
        for terminal in s.terminals.values_mut() {
            let _ = terminal.close();
        }
        for sender in s.agents.values() {
            let _ = sender.try_send(AgentCommand::Shutdown);
        }
    }
}
