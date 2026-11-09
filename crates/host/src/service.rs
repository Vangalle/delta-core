use crate::auth;
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
    backends: HashMap<String, Arc<dyn AgentBackend>>,
}

fn published_context(state: &State, id: &str, include_references: bool) -> String {
    let Some(workspace) = state.workspaces.get(id) else {
        return String::new();
    };
    workspace
        .entries
        .iter()
        .filter_map(|entry| match &entry.content {
            Content::Text { text } => Some(text.clone()),
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
            } if include_references && target != id => Some(format!(
                "Referenced workspace {label} ({target}):\n{}",
                published_context(state, target, false)
            )),
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

#[derive(Clone)]
pub struct Service {
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<(String, Event)>,
    stopping: watch::Sender<bool>,
    cwd: PathBuf,
    shell: String,
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
                backends,
            })),
            events,
            stopping,
            cwd: cwd.canonicalize().map_err(internal)?,
            shell: std::env::var("DELTA_SHELL").unwrap_or_else(|_| "/bin/sh".into()),
        })
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

    pub async fn members(&self) -> Result<Vec<Member>, ServiceError> {
        self.state.lock().await.journal.members().map_err(internal)
    }

    pub async fn invite(
        &self,
        actor: &Member,
        invite: InviteMember,
    ) -> Result<Invitation, ServiceError> {
        if actor.role != Role::Owner {
            return Err(ServiceError::Forbidden);
        }
        if invite.name.trim().is_empty() || invite.name.len() > 100 || invite.role == Role::Owner {
            return Err(ServiceError::Invalid);
        }
        let member = Member {
            id: uuid::Uuid::new_v4().to_string(),
            name: invite.name,
            role: invite.role,
        };
        let token = auth::token();
        self.state
            .lock()
            .await
            .journal
            .add_member(&member, &auth::hash(&token))
            .map_err(internal)?;
        Ok(Invitation { member, token })
    }

    pub async fn workspaces(&self) -> Result<Vec<WorkspaceInfo>, ServiceError> {
        self.state
            .lock()
            .await
            .journal
            .workspaces()
            .map_err(internal)
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
        s.journal.create_workspace(&info).map_err(internal)?;
        s.workspaces.insert(
            info.id.clone(),
            Workspace::new(info.id.clone(), info.title.clone()),
        );
        s.cursors.insert(info.id.clone(), 0);
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

    pub async fn snapshot(&self, id: &str) -> Result<Snapshot, ServiceError> {
        let s = self.state.lock().await;
        let workspace = s.workspaces.get(id).ok_or(ServiceError::NotFound)?;
        Ok(Snapshot {
            workspace: workspace.info.clone(),
            cursor: *s.cursors.get(id).unwrap_or(&0),
            entries: workspace.entries.clone(),
        })
    }

    pub async fn subscribe(
        &self,
        id: &str,
        after: u64,
    ) -> Result<(Vec<Event>, broadcast::Receiver<(String, Event)>), ServiceError> {
        let s = self.state.lock().await;
        if !s.workspaces.contains_key(id) {
            return Err(ServiceError::NotFound);
        }
        if after > *s.cursors.get(id).unwrap_or(&0) {
            return Err(ServiceError::Conflict);
        }
        let receiver = self.events.subscribe();
        Ok((s.journal.load(id, after).map_err(internal)?, receiver))
    }

    fn commit(&self, s: &mut State, id: &str, changes: &[Change]) -> Result<u64, ServiceError> {
        let events = s.journal.append(id, changes).map_err(internal)?;
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
        if let Command::InsertReference { kind, target, .. } = &command {
            let exists = match kind {
                ReferenceKind::Thread => s.workspaces.contains_key(target),
                ReferenceKind::User => s
                    .journal
                    .members()
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
        let decision = s
            .workspaces
            .get(id)
            .ok_or(ServiceError::NotFound)?
            .decide(actor, command)?;
        self.commit(&mut s, id, &decision.changes)?;
        let key = |entry: &str| (id.to_owned(), entry.to_owned());
        let result: Result<(), ServiceError> = match decision.effect {
            None => Ok(()),
            Some(Effect::OpenTerminal { id: entry }) => {
                match Terminal::spawn(&self.cwd, &self.shell) {
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
                            return Err(ServiceError::Unavailable);
                        }
                        Ok(mut connection) => {
                            s.agents.insert(key(&entry), connection.commands);
                            let service = self.clone();
                            let workspace = id.to_owned();
                            let agent = entry.clone();
                            tokio::spawn(async move {
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
                        }
                    }
                }
                let published = published_context(&s, id, true);
                let message = format!(
                    "Published workspace content (reference material):\n<workspace>\n{published}\n</workspace>\n\nUser request:\n{prompt}"
                );
                s.agents
                    .get(&key(&entry))
                    .ok_or(ServiceError::Unavailable)?
                    .try_send(AgentCommand::Prompt(message))
                    .map_err(|_| ServiceError::Unavailable)
            }
        };
        result?;
        Ok(Receipt {
            cursor: *s.cursors.get(id).unwrap_or(&0),
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
