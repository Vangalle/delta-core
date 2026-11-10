use super::*;
pub(super) fn authorize(
    s: &State,
    actor: &Member,
    id: &str,
) -> Result<WorkspaceAccess, ServiceError> {
    if !s.workspaces.contains_key(id) {
        return Err(ServiceError::NotFound);
    }
    let role = s
        .journal
        .workspace_role(id, &actor.id)
        .map_err(internal)?
        .ok_or(ServiceError::NotFound)?;
    let canonical = s
        .journal
        .account(&actor.id)
        .map_err(internal)?
        .ok_or(ServiceError::Unauthorized)?;
    Ok(delta_kernel::workspace_access(&canonical, role))
}
pub(super) fn shared_reference(s: &State, from: &str, to: &str) -> bool {
    s.journal.workspace_members(from).is_ok_and(|members| {
        !members.is_empty()
            && members.iter().all(|m| {
                s.journal
                    .workspace_role(to, &m.id)
                    .is_ok_and(|role| role.is_some())
            })
    })
}
fn added_changes(
    s: &State,
    id: &str,
    peer: &Member,
    role: Role,
) -> Result<Vec<Change>, ServiceError> {
    if s.journal
        .workspace_role(id, &peer.id)
        .map_err(internal)?
        .is_some()
    {
        return Ok(Vec::new());
    }
    let workspace = s.workspaces.get(id).ok_or(ServiceError::NotFound)?;
    let mut shadow = Workspace::new(id.into(), workspace.info.title.clone());
    shadow.collaboration = workspace.collaboration.clone();
    let mut changes = vec![Change::MemberAdded {
        member: Member {
            id: peer.id.clone(),
            name: peer.name.clone(),
            role,
        },
    }];
    let mut members = s.journal.workspace_members(id).map_err(internal)?;
    members.push(peer.clone());
    for member in members {
        let decision = shadow.decide(&member, Command::JoinWorkspace)?;
        for change in decision.changes {
            shadow.apply(change.clone());
            changes.push(change);
        }
    }
    Ok(changes)
}
impl Service {
    pub async fn open_desktop_terminal(
        &self,
        actor: &Member,
        id: &str,
    ) -> Result<Receipt, ServiceError> {
        {
            let s = self.state.lock().await;
            let access = authorize(&s, actor, id)?;
            let canonical = s
                .journal
                .account(&actor.id)
                .map_err(internal)?
                .ok_or(ServiceError::Unauthorized)?;
            if canonical.role != Role::Owner || !access.can_execute {
                return Err(ServiceError::Forbidden);
            }
        }
        let backend = self
            .desktop_terminal
            .as_ref()
            .ok_or(ServiceError::Unavailable)?;
        let mut command = backend
            .command(&self.cwd)
            .map_err(|_| ServiceError::Unavailable)?;
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let status = tokio::time::timeout(std::time::Duration::from_secs(15), command.status())
            .await
            .map_err(|_| ServiceError::Unavailable)?
            .map_err(|_| ServiceError::Unavailable)?;
        if !status.success() {
            return Err(ServiceError::Unavailable);
        }
        let mut s = self.state.lock().await;
        let cursor = self.commit(
            &mut s,
            id,
            &[Change::DesktopTerminalOpened {
                actor: actor.id.clone(),
            }],
        )?;
        Ok(Receipt {
            cursor,
            agent_reply: None,
        })
    }
    pub async fn set_member_role(
        &self,
        actor: &Member,
        id: &str,
        target_id: &str,
        body: SetMemberRole,
    ) -> Result<Receipt, ServiceError> {
        let mut s = self.state.lock().await;
        let actor = s
            .journal
            .account(&actor.id)
            .map_err(internal)?
            .ok_or(ServiceError::Unauthorized)?;
        let access = authorize(&s, &actor, id)?;
        if access.role != Role::Owner {
            return Err(ServiceError::Forbidden);
        }
        let mut target = s
            .journal
            .account(target_id)
            .map_err(internal)?
            .ok_or(ServiceError::NotFound)?;
        let current = s
            .journal
            .workspace_role(id, target_id)
            .map_err(internal)?
            .ok_or(ServiceError::NotFound)?;
        let old_host_role = target.role;
        target.role =
            delta_kernel::member_role_change(&actor, access, &target, current, body.role)?;
        if current == body.role && old_host_role == target.role {
            return Ok(Receipt {
                cursor: *s.cursors.get(id).unwrap_or(&0),
                agent_reply: None,
            });
        }
        let mut changes = Vec::new();
        let mut stop = Vec::new();
        for info in s.journal.workspaces().map_err(internal)? {
            if let Some(old_role) = s
                .journal
                .workspace_role(&info.id, target_id)
                .map_err(internal)?
            {
                if info.id != id && old_host_role == target.role {
                    continue;
                }
                let role = if info.id == id { body.role } else { old_role };
                let effective = delta_kernel::workspace_access(&target, role);
                let mut events = vec![Change::MemberRoleChanged {
                    member: Member {
                        id: target.id.clone(),
                        name: target.name.clone(),
                        role,
                    },
                    can_execute: effective.can_execute,
                }];
                if !effective.can_execute {
                    for entry in &s.workspaces[&info.id].entries {
                        let controlled = match &entry.content {
                            Content::Terminal {
                                controller, status, ..
                            }
                            | Content::Agent {
                                controller, status, ..
                            } => {
                                controller == target_id
                                    && matches!(
                                        status,
                                        SessionStatus::Running | SessionStatus::Idle
                                    )
                            }
                            _ => false,
                        };
                        if controlled {
                            stop.push((info.id.clone(), entry.id.clone()));
                            events.push(Change::SessionState {
                                id: entry.id.clone(),
                                status: SessionStatus::Interrupted,
                            });
                        }
                    }
                }
                changes.push((info.id, events));
            }
        }
        let events = s
            .journal
            .set_member_role(id, &target, body.role, &changes)
            .map_err(internal)?;
        for key in stop {
            if let Some(mut terminal) = s.terminals.remove(&key) {
                let _ = terminal.close();
            }
            s.agents.remove(&key);
            if let Some(reader) = s.agent_readers.remove(&key) {
                reader.abort();
            }
        }
        for (workspace, event) in events {
            self.project_events(&mut s, &workspace, vec![event])?;
        }
        Ok(Receipt {
            cursor: *s.cursors.get(id).unwrap_or(&0),
            agent_reply: None,
        })
    }
    pub async fn check_access(&self, actor: &Member, id: &str) -> Result<(), ServiceError> {
        let s = self.state.lock().await;
        authorize(&s, actor, id).map(|_| ())
    }
    pub async fn create_invitation(
        &self,
        actor: &Member,
        id: &str,
        body: InviteMember,
    ) -> Result<WorkspaceInvitation, ServiceError> {
        let s = self.state.lock().await;
        let access = authorize(&s, actor, id)?;
        if access.role != Role::Owner {
            return Err(ServiceError::Forbidden);
        }
        if body.role == Role::Owner || body.name.trim().is_empty() || body.name.len() > 100 {
            return Err(ServiceError::Invalid);
        }
        if body.role == Role::Executor && actor.role != Role::Owner {
            return Err(ServiceError::Forbidden);
        }
        let token = auth::token();
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(internal)?
            .as_secs()
            + 7 * 24 * 60 * 60;
        s.journal
            .store_invitation(id, &auth::hash(&token), &body, expires_at)
            .map_err(internal)?;
        Ok(WorkspaceInvitation {
            token,
            workspace: s.workspaces[id].info.clone(),
            role: body.role,
            name: body.name,
            expires_at,
        })
    }
    pub async fn invitation_preview(&self, token: &str) -> Result<InvitationPreview, ServiceError> {
        if token.len() > 256 || token.is_empty() {
            return Err(ServiceError::NotFound);
        }
        self.state
            .lock()
            .await
            .journal
            .invitation(&auth::hash(token))
            .map_err(internal)?
            .ok_or(ServiceError::NotFound)
    }
    pub async fn accept_invitation(
        &self,
        actor: Option<&Member>,
        body: AcceptInvitation,
    ) -> Result<AcceptedInvitation, ServiceError> {
        if body.token.is_empty() || body.token.len() > 256 {
            return Err(ServiceError::NotFound);
        }
        let mut s = self.state.lock().await;
        let hash = auth::hash(&body.token);
        let invitation = s
            .journal
            .invitation(&hash)
            .map_err(internal)?
            .ok_or(ServiceError::NotFound)?;
        let new = actor.is_none();
        if new && (body.name.trim().is_empty() || body.name.len() > 100) {
            return Err(ServiceError::Invalid);
        }
        let mut account = if let Some(actor) = actor {
            s.journal
                .account(&actor.id)
                .map_err(internal)?
                .ok_or(ServiceError::Unauthorized)?
        } else {
            Member {
                id: uuid::Uuid::new_v4().to_string(),
                name: body.name.trim().into(),
                role: Role::Editor,
            }
        };
        let already = s
            .journal
            .workspace_role(&invitation.workspace.id, &account.id)
            .map_err(internal)?
            .is_some();
        if !already && invitation.role == Role::Executor && account.role != Role::Owner {
            account.role = Role::Executor;
        }
        let login_token = new.then(auth::token);
        let login_hash = login_token.as_deref().map(auth::hash);
        let changes = added_changes(&s, &invitation.workspace.id, &account, invitation.role)?;
        let events = s
            .journal
            .claim_invitation(&hash, &account, login_hash.as_deref(), &changes)
            .map_err(internal)?
            .ok_or(ServiceError::NotFound)?;
        self.project_events(&mut s, &invitation.workspace.id, events)?;
        Ok(AcceptedInvitation {
            member: account,
            workspace: invitation.workspace,
            login_token,
        })
    }
    pub async fn friends(&self, actor: &Member) -> Result<Vec<Friend>, ServiceError> {
        self.state
            .lock()
            .await
            .journal
            .friends(&actor.id)
            .map_err(internal)
    }
    pub async fn request_friend(
        &self,
        actor: &Member,
        target: FriendTarget,
    ) -> Result<Vec<Friend>, ServiceError> {
        if target.member_id == actor.id {
            return Err(ServiceError::Invalid);
        }
        let s = self.state.lock().await;
        if s.journal
            .account(&target.member_id)
            .map_err(internal)?
            .is_none()
        {
            return Err(ServiceError::NotFound);
        }
        s.journal
            .request_friend(&actor.id, &target.member_id)
            .map_err(internal)?;
        s.journal.friends(&actor.id).map_err(internal)
    }
    pub async fn accept_friend(
        &self,
        actor: &Member,
        target: FriendTarget,
    ) -> Result<Vec<Friend>, ServiceError> {
        let s = self.state.lock().await;
        if !s
            .journal
            .accept_friend(&actor.id, &target.member_id)
            .map_err(internal)?
        {
            return Err(ServiceError::Forbidden);
        }
        s.journal.friends(&actor.id).map_err(internal)
    }
    pub async fn add_friend(
        &self,
        actor: &Member,
        id: &str,
        body: AddFriend,
    ) -> Result<Receipt, ServiceError> {
        let mut s = self.state.lock().await;
        if authorize(&s, actor, id)?.role != Role::Owner {
            return Err(ServiceError::Forbidden);
        }
        if body.role == Role::Owner {
            return Err(ServiceError::Invalid);
        }
        if !s
            .journal
            .are_friends(&actor.id, &body.member_id)
            .map_err(internal)?
        {
            return Err(ServiceError::Forbidden);
        }
        let peer = s
            .journal
            .account(&body.member_id)
            .map_err(internal)?
            .ok_or(ServiceError::NotFound)?;
        if body.role == Role::Executor && !peer.role.can_execute() {
            return Err(ServiceError::Forbidden);
        }
        if s.journal
            .workspace_role(id, &peer.id)
            .map_err(internal)?
            .is_some_and(|role| role != body.role)
        {
            return Err(ServiceError::MembershipConflict);
        }
        let changes = added_changes(&s, id, &peer, body.role)?;
        let events = s
            .journal
            .add_workspace_member(id, &peer.id, body.role, &changes)
            .map_err(internal)?;
        let cursor = self.project_events(&mut s, id, events)?;
        Ok(Receipt {
            cursor,
            agent_reply: None,
        })
    }
}
