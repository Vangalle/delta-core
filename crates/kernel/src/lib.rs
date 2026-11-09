use delta_protocol::*;

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
    },
    AbortAgent {
        id: String,
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
}

impl Workspace {
    pub fn new(id: String, title: String) -> Self {
        Self {
            info: WorkspaceInfo { id, title },
            entries: Vec::new(),
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
                    content,
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
        if !actor.role.can_edit() {
            return Err(KernelError::Forbidden);
        }
        match command {
            Command::PublishText {
                id,
                base_revision,
                text,
                after,
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
                            text,
                            actor: actor.id.clone(),
                        }],
                        effect: None,
                    })
                } else {
                    if base_revision != 0 {
                        return Err(KernelError::Conflict);
                    }
                    self.insert(actor, id, after, Content::Text { text })
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
                        changes: vec![Change::SessionState {
                            id: id.clone(),
                            status: SessionStatus::Running,
                        }],
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
                        },
                    )?
                };
                d.effect = Some(Effect::PromptAgent {
                    id,
                    backend,
                    prompt,
                });
                Ok(d)
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
            } => {
                if let Some(e) = self.entries.iter_mut().find(|e| e.id == id) {
                    e.revision = revision;
                    e.author = actor;
                    e.content = Content::Text { text };
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
