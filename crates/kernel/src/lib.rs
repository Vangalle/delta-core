use delta_protocol::*;
mod collaboration;
mod context;
pub use collaboration::parse_mentions;
pub use context::{validate_quote_source, validate_quotes};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KernelError {
    #[error("permission denied")]
    Forbidden,
    #[error("entry not found")]
    NotFound,
    #[error("published content changed; keep your draft and reconcile")]
    Conflict,
    #[error("invalid command")]
    Invalid,
    #[error("session is not available")]
    Unavailable,
}

#[derive(Debug)]
pub enum Effect {
    OpenTerminal {
        id: String,
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

#[derive(Debug, Default)]
pub struct Decision {
    pub changes: Vec<Change>,
    pub effect: Option<Effect>,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub info: WorkspaceInfo,
    pub entries: Vec<Entry>,
    pub collaboration: Collaboration,
}

impl Workspace {
    pub fn new(id: String, title: String) -> Self {
        Self {
            info: WorkspaceInfo { id, title },
            entries: Vec::new(),
            collaboration: Collaboration::default(),
        }
    }

    pub fn entry(&self, id: &str) -> Result<&Entry, KernelError> {
        self.entries
            .iter()
            .find(|e| e.id == id)
            .ok_or(KernelError::NotFound)
    }

    fn insert(
        &self,
        actor: &Member,
        id: String,
        after: Option<String>,
        content: Content,
        quotes: Vec<ContextQuote>,
    ) -> Result<Decision, KernelError> {
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return Err(KernelError::Invalid);
        }
        if self.entries.iter().any(|e| e.id == id) {
            return Err(KernelError::Conflict);
        }
        if let Some(anchor) = &after {
            self.entry(anchor)?;
        }
        Ok(Decision {
            changes: vec![Change::Inserted {
                entry: Entry {
                    id,
                    revision: 1,
                    author: actor.id.clone(),
                    mentions: match &content {
                        Content::Text { text } => parse_mentions(text, "pi"),
                        _ => Vec::new(),
                    },
                    content,
                    quotes,
                },
                after,
            }],
            effect: None,
        })
    }

    fn control<'a>(
        &'a self,
        actor: &Member,
        id: &str,
        terminal: bool,
    ) -> Result<&'a Entry, KernelError> {
        if !actor.role.can_execute() {
            return Err(KernelError::Forbidden);
        }
        let entry = self.entry(id)?;
        let (controller, status) = match (&entry.content, terminal) {
            (
                Content::Terminal {
                    controller, status, ..
                },
                true,
            ) => (controller, status),
            (
                Content::Agent {
                    controller, status, ..
                },
                false,
            ) => (controller, status),
            _ => return Err(KernelError::Invalid),
        };
        if controller != &actor.id {
            return Err(KernelError::Forbidden);
        }
        if !matches!(status, SessionStatus::Running | SessionStatus::Idle) {
            return Err(KernelError::Unavailable);
        }
        Ok(entry)
    }

    pub fn decide(&self, actor: &Member, command: Command) -> Result<Decision, KernelError> {
        if matches!(&command, Command::JoinWorkspace) {
            return Ok(self.join(actor));
        }
        if !actor.role.can_edit() {
            return Err(KernelError::Forbidden);
        }
        match &command {
            Command::PublishText { quotes, .. }
            | Command::PromptAgent { quotes, .. }
            | Command::SubmitMessage { quotes, .. } => validate_quotes(quotes)?,
            _ => {}
        }
        match command {
            Command::JoinWorkspace => Ok(Decision::default()),
            Command::SetReplyMode { mode } => {
                if !actor.role.can_execute() {
                    return Err(KernelError::Forbidden);
                }
                Ok(Decision {
                    changes: vec![Change::ReplyModeChanged {
                        mode,
                        explicit: true,
                    }],
                    effect: None,
                })
            }
            Command::SubmitMessage {
                id,
                text,
                after,
                quotes,
                backend,
            } => self.submit(actor, id, text, after, quotes, backend),
            Command::PublishText {
                id,
                base_revision,
                text,
                after,
                quotes,
            } => {
                if text.len() > 262_144 {
                    return Err(KernelError::Invalid);
                }
                if let Ok(entry) = self.entry(&id) {
                    if !matches!(entry.content, Content::Text { .. }) {
                        return Err(KernelError::Invalid);
                    }
                    if entry.revision != base_revision {
                        return Err(KernelError::Conflict);
                    }
                    Ok(Decision {
                        changes: vec![Change::TextPublished {
                            id,
                            revision: base_revision + 1,
                            mentions: parse_mentions(&text, "pi"),
                            text,
                            actor: actor.id.clone(),
                            quotes,
                        }],
                        effect: None,
                    })
                } else {
                    if base_revision != 0 {
                        return Err(KernelError::Conflict);
                    }
                    self.insert(actor, id, after, Content::Text { text }, quotes)
                }
            }
            Command::InsertReference {
                id,
                kind,
                target,
                label,
                after,
            } => {
                if target.is_empty() || target.len() > 128 || label.len() > 256 {
                    return Err(KernelError::Invalid);
                }
                self.insert(
                    actor,
                    id,
                    after,
                    Content::Reference {
                        kind,
                        target,
                        label,
                    },
                    Vec::new(),
                )
            }
            Command::OpenTerminal { id, after } => {
                if !actor.role.can_execute() {
                    return Err(KernelError::Forbidden);
                }
                let mut d = self.insert(
                    actor,
                    id.clone(),
                    after,
                    Content::Terminal {
                        controller: actor.id.clone(),
                        status: SessionStatus::Running,
                        output: Vec::new(),
                    },
                    Vec::new(),
                )?;
                d.effect = Some(Effect::OpenTerminal { id });
                Ok(d)
            }
            Command::TerminalInput { id, data } => {
                self.control(actor, &id, true)?;
                if data.len() > 16_384 {
                    return Err(KernelError::Invalid);
                }
                Ok(Decision {
                    effect: Some(Effect::TerminalInput { id, data }),
                    ..Decision::default()
                })
            }
            Command::ResizeTerminal { id, cols, rows } => {
                self.control(actor, &id, true)?;
                if !(2..=300).contains(&cols) || !(1..=1000).contains(&rows) {
                    return Err(KernelError::Invalid);
                }
                Ok(Decision {
                    effect: Some(Effect::ResizeTerminal { id, cols, rows }),
                    ..Decision::default()
                })
            }
            Command::CloseTerminal { id } => {
                self.control(actor, &id, true)?;
                Ok(Decision {
                    effect: Some(Effect::CloseTerminal { id }),
                    ..Decision::default()
                })
            }
            Command::PromptAgent {
                id,
                backend,
                prompt,
                after,
                quotes,
            } => {
                if !actor.role.can_execute() {
                    return Err(KernelError::Forbidden);
                }
                if prompt.trim().is_empty() || prompt.len() > 262_144 || backend.is_empty() {
                    return Err(KernelError::Invalid);
                }
                let mut d = if let Ok(entry) = self.entry(&id) {
                    self.control(actor, &id, false)?;
                    match &entry.content {
                        Content::Agent {
                            backend: existing,
                            status: SessionStatus::Idle,
                            ..
                        } if existing == &backend => {}
                        _ => return Err(KernelError::Unavailable),
                    }
                    Decision {
                        changes: vec![
                            Change::AgentActivity {
                                id: id.clone(),
                                activity: Activity::Prompt {
                                    text: prompt.clone(),
                                    actor: actor.id.clone(),
                                    quotes: quotes.clone(),
                                },
                            },
                            Change::SessionState {
                                id: id.clone(),
                                status: SessionStatus::Running,
                            },
                        ],
                        effect: None,
                    }
                } else {
                    self.insert(
                        actor,
                        id.clone(),
                        after,
                        Content::Agent {
                            backend: backend.clone(),
                            controller: actor.id.clone(),
                            status: SessionStatus::Running,
                            prompt: prompt.clone(),
                            activities: Vec::new(),
                            source_entry: None,
                        },
                        quotes.clone(),
                    )?
                };
                d.effect = Some(Effect::PromptAgent {
                    id,
                    backend,
                    prompt,
                    quotes,
                });
                Ok(d)
            }
            Command::RespondAgent {
                id,
                request_id,
                response,
            } => {
                let entry = self.control(actor, &id, false)?;
                let Content::Agent {
                    status: SessionStatus::Running,
                    activities,
                    ..
                } = &entry.content
                else {
                    return Err(KernelError::Unavailable);
                };
                let mut pending = None;
                for activity in activities {
                    match activity {
                        Activity::InteractionRequested {
                            request_id: candidate,
                            kind,
                            options,
                            ..
                        } if candidate == &request_id => pending = Some((kind, options)),
                        Activity::InteractionResolved {
                            request_id: candidate,
                        } if candidate == &request_id => pending = None,
                        _ => {}
                    }
                }
                let (kind, options) = pending.ok_or(KernelError::NotFound)?;
                let valid = match (&response, kind) {
                    (InteractionResponse::Cancel, _) => true,
                    (InteractionResponse::Confirm { .. }, InteractionKind::Confirm) => true,
                    (InteractionResponse::Value { value }, InteractionKind::Select) => {
                        options.contains(value)
                    }
                    (
                        InteractionResponse::Value { value },
                        InteractionKind::Input | InteractionKind::Editor,
                    ) => value.len() <= 262_144,
                    _ => false,
                };
                if !valid {
                    return Err(KernelError::Invalid);
                }
                Ok(Decision {
                    changes: vec![Change::AgentActivity {
                        id: id.clone(),
                        activity: Activity::InteractionResolved {
                            request_id: request_id.clone(),
                        },
                    }],
                    effect: Some(Effect::RespondAgent {
                        id,
                        request_id,
                        response,
                    }),
                })
            }
            Command::AbortAgent { id } => {
                self.control(actor, &id, false)?;
                Ok(Decision {
                    effect: Some(Effect::AbortAgent { id }),
                    ..Decision::default()
                })
            }
        }
    }

    pub fn apply(&mut self, change: Change) {
        match change {
            Change::ParticipantJoined { member } => {
                if !self.collaboration.participants.contains(&member) {
                    self.collaboration.participants.push(member);
                }
            }
            Change::ReplyModeChanged { mode, explicit } => {
                self.collaboration.reply_mode = mode;
                self.collaboration.mode_explicit = explicit;
            }
            Change::Inserted { entry, after } => {
                let pos = after
                    .and_then(|a| self.entries.iter().position(|e| e.id == a).map(|i| i + 1))
                    .unwrap_or(self.entries.len());
                self.entries.insert(pos, entry);
            }
            Change::TextPublished {
                id,
                revision,
                text,
                actor,
                quotes,
                mentions,
            } => {
                if let Some(e) = self.entries.iter_mut().find(|e| e.id == id) {
                    e.revision = revision;
                    e.author = actor;
                    e.content = Content::Text { text };
                    e.quotes = quotes;
                    e.mentions = mentions;
                }
            }
            Change::TerminalOutput { id, data } => {
                if let Some(Entry {
                    content: Content::Terminal { output, .. },
                    ..
                }) = self.entries.iter_mut().find(|e| e.id == id)
                {
                    output.push(data);
                }
            }
            Change::SessionState { id, status } => {
                if let Some(e) = self.entries.iter_mut().find(|e| e.id == id) {
                    match &mut e.content {
                        Content::Terminal { status: s, .. } | Content::Agent { status: s, .. } => {
                            *s = status
                        }
                        _ => {}
                    }
                }
            }
            Change::AgentActivity { id, activity } => {
                if let Some(Entry {
                    content:
                        Content::Agent {
                            activities, status, ..
                        },
                    ..
                }) = self.entries.iter_mut().find(|e| e.id == id)
                {
                    match &activity {
                        Activity::Settled { .. } => *status = SessionStatus::Idle,
                        Activity::Failed { .. } => *status = SessionStatus::Failed,
                        _ => {}
                    }
                    activities.push(activity);
                }
            }
        }
    }
}
