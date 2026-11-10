use crate::{AdapterResult, journal::Journal};
use delta_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;
fn member(row: &rusqlite::Row<'_>) -> rusqlite::Result<Member> {
    let role: String = row.get(2)?;
    Ok(Member {
        id: row.get(0)?,
        name: row.get(1)?,
        role: serde_json::from_str(&role).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
        })?,
    })
}
fn append(
    connection: &Connection,
    workspace: &str,
    changes: &[Change],
) -> AdapterResult<Vec<Event>> {
    let mut events = Vec::new();
    for change in changes {
        connection.execute(
            "INSERT INTO events(workspace,change_json) VALUES(?1,?2)",
            params![workspace, serde_json::to_string(change)?],
        )?;
        events.push(Event {
            sequence: connection.last_insert_rowid() as u64,
            change: change.clone(),
        });
    }
    Ok(events)
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl Journal {
    pub(crate) fn init_access_schema(&self) -> AdapterResult<()> {
        self.connection.execute_batch("CREATE TABLE IF NOT EXISTS access_migrations(version INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS workspace_members(workspace TEXT NOT NULL REFERENCES workspaces(id),member TEXT NOT NULL REFERENCES members(id),role TEXT NOT NULL,PRIMARY KEY(workspace,member));
 CREATE TABLE IF NOT EXISTS invitations(token_hash TEXT PRIMARY KEY,workspace TEXT NOT NULL REFERENCES workspaces(id),name TEXT NOT NULL,role TEXT NOT NULL,expires_at INTEGER NOT NULL,claimed_by TEXT REFERENCES members(id));
 CREATE TABLE IF NOT EXISTS friendships(left_id TEXT NOT NULL REFERENCES members(id),right_id TEXT NOT NULL REFERENCES members(id),requested_by TEXT NOT NULL REFERENCES members(id),accepted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(left_id,right_id));")?;
        Ok(())
    }
    pub fn migrate_workspace_access(&mut self) -> AdapterResult<()> {
        if self
            .connection
            .query_row(
                "SELECT version FROM access_migrations WHERE version=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            return Ok(());
        }
        let accounts = self.members()?;
        let rooms = self.workspaces()?;
        let mut grants = Vec::new();
        for room in &rooms {
            let mut known = HashSet::new();
            for e in self.load(&room.id, 0)? {
                match e.change {
                    Change::Inserted { entry, .. } => {
                        known.insert(entry.author);
                        match entry.content {
                            Content::Agent {
                                controller,
                                activities,
                                ..
                            } => {
                                known.insert(controller);
                                for a in activities {
                                    if let Activity::Prompt { actor, .. } = a {
                                        known.insert(actor);
                                    }
                                }
                            }
                            Content::Terminal { controller, .. } => {
                                known.insert(controller);
                            }
                            _ => {}
                        }
                    }
                    Change::ParticipantJoined { member } => {
                        known.insert(member);
                    }
                    Change::TextPublished { actor, .. } => {
                        known.insert(actor);
                    }
                    Change::AgentActivity {
                        activity: Activity::Prompt { actor, .. },
                        ..
                    } => {
                        known.insert(actor);
                    }
                    _ => {}
                }
            }
            for account in &accounts {
                if account.role == Role::Owner || known.contains(&account.id) {
                    grants.push((room.id.clone(), account.id.clone(), account.role));
                }
            }
        }
        if !rooms.is_empty() {
            let backup = self
                .path
                .with_file_name("events.before-workspace-access.sqlite");
            if !backup.exists() {
                self.connection
                    .execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])?;
            }
        }
        let tx = self.connection.transaction()?;
        for (workspace, account, role) in grants {
            tx.execute(
                "INSERT OR IGNORE INTO workspace_members(workspace,member,role) VALUES(?1,?2,?3)",
                params![workspace, account, serde_json::to_string(&role)?],
            )?;
        }
        tx.execute("INSERT INTO access_migrations(version) VALUES(1)", [])?;
        tx.commit()?;
        Ok(())
    }
    pub fn account(&self, id: &str) -> AdapterResult<Option<Member>> {
        Ok(self
            .connection
            .query_row("SELECT id,name,role FROM members WHERE id=?1", [id], member)
            .optional()?)
    }
    pub fn workspace_role(&self, workspace: &str, actor: &str) -> AdapterResult<Option<Role>> {
        let role: Option<String> = self
            .connection
            .query_row(
                "SELECT role FROM workspace_members WHERE workspace=?1 AND member=?2",
                params![workspace, actor],
                |r| r.get(0),
            )
            .optional()?;
        Ok(role.map(|r| serde_json::from_str(&r)).transpose()?)
    }
    pub fn workspace_members(&self, workspace: &str) -> AdapterResult<Vec<Member>> {
        let mut stmt=self.connection.prepare("SELECT m.id,m.name,w.role FROM members m JOIN workspace_members w ON m.id=w.member WHERE w.workspace=?1 ORDER BY w.rowid")?;
        Ok(stmt
            .query_map([workspace], member)?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub fn create_scoped_workspace(
        &mut self,
        info: &WorkspaceInfo,
        actor: &str,
    ) -> AdapterResult<()> {
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO workspaces(id,title) VALUES(?1,?2)",
            params![info.id, info.title],
        )?;
        tx.execute(
            "INSERT INTO workspace_members(workspace,member,role) VALUES(?1,?2,?3)",
            params![info.id, actor, serde_json::to_string(&Role::Owner)?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn store_invitation(
        &self,
        workspace: &str,
        hash: &str,
        body: &InviteMember,
        expires: u64,
    ) -> AdapterResult<()> {
        self.connection.execute("INSERT INTO invitations(token_hash,workspace,name,role,expires_at) VALUES(?1,?2,?3,?4,?5)",params![hash,workspace,body.name,serde_json::to_string(&body.role)?,expires])?;
        Ok(())
    }
    pub fn invitation(&self, hash: &str) -> AdapterResult<Option<InvitationPreview>> {
        let result=self.connection.query_row("SELECT w.id,w.title,i.name,i.role,i.expires_at FROM invitations i JOIN workspaces w ON w.id=i.workspace WHERE token_hash=?1 AND claimed_by IS NULL AND expires_at>?2",params![hash,now()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,u64>(4)?))).optional()?;
        result
            .map(|(id, title, name, role, expires_at)| {
                Ok(InvitationPreview {
                    workspace: WorkspaceInfo { id, title },
                    name,
                    role: serde_json::from_str(&role)?,
                    expires_at,
                })
            })
            .transpose()
    }
    pub fn claim_invitation(
        &mut self,
        hash: &str,
        account: &Member,
        new_hash: Option<&str>,
        changes: &[Change],
    ) -> AdapterResult<Option<Vec<Event>>> {
        let tx = self.connection.transaction()?;
        let target:Option<(String,String)>=tx.query_row("SELECT workspace,role FROM invitations WHERE token_hash=?1 AND claimed_by IS NULL AND expires_at>?2",params![hash,now()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((workspace, role)) = target else {
            return Ok(None);
        };
        if let Some(hash) = new_hash {
            tx.execute(
                "INSERT INTO members(id,name,role,token_hash) VALUES(?1,?2,?3,?4)",
                params![
                    account.id,
                    account.name,
                    serde_json::to_string(&account.role)?,
                    hash
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE members SET role=?1 WHERE id=?2",
                params![serde_json::to_string(&account.role)?, account.id],
            )?;
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO workspace_members(workspace,member,role) VALUES(?1,?2,?3)",
            params![workspace, account.id, role],
        )?;
        tx.execute(
            "UPDATE invitations SET claimed_by=?1 WHERE token_hash=?2",
            params![account.id, hash],
        )?;
        let events = if inserted > 0 {
            append(&tx, &workspace, changes)?
        } else {
            Vec::new()
        };
        tx.commit()?;
        Ok(Some(events))
    }
    pub fn add_workspace_member(
        &mut self,
        workspace: &str,
        actor: &str,
        role: Role,
        changes: &[Change],
    ) -> AdapterResult<Vec<Event>> {
        let tx = self.connection.transaction()?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO workspace_members(workspace,member,role) VALUES(?1,?2,?3)",
            params![workspace, actor, serde_json::to_string(&role)?],
        )?;
        let events = if inserted > 0 {
            append(&tx, workspace, changes)?
        } else {
            Vec::new()
        };
        tx.commit()?;
        Ok(events)
    }
    pub fn set_member_role(
        &mut self,
        workspace: &str,
        target: &Member,
        role: Role,
        changes: &[(String, Vec<Change>)],
    ) -> AdapterResult<Vec<(String, Event)>> {
        let tx = self.connection.transaction()?;
        if tx.execute(
            "UPDATE workspace_members SET role=?1 WHERE workspace=?2 AND member=?3",
            params![serde_json::to_string(&role)?, workspace, target.id],
        )? != 1
        {
            return Err("workspace membership disappeared".into());
        }
        tx.execute(
            "UPDATE members SET role=?1 WHERE id=?2",
            params![serde_json::to_string(&target.role)?, target.id],
        )?;
        let mut result = Vec::new();
        for (id, changes) in changes {
            for event in append(&tx, id, changes)? {
                result.push((id.clone(), event));
            }
        }
        tx.commit()?;
        Ok(result)
    }
    pub fn friends(&self, actor: &str) -> AdapterResult<Vec<Friend>> {
        let mut stmt=self.connection.prepare("SELECT m.id,m.name,f.requested_by,f.accepted FROM friendships f JOIN members m ON m.id=CASE WHEN f.left_id=?1 THEN f.right_id ELSE f.left_id END WHERE f.left_id=?1 OR f.right_id=?1 ORDER BY f.rowid")?;
        Ok(stmt
            .query_map([actor], |r| {
                let requested: String = r.get(2)?;
                let accepted: bool = r.get(3)?;
                Ok(Friend {
                    peer: Person {
                        id: r.get(0)?,
                        name: r.get(1)?,
                    },
                    status: if accepted {
                        FriendStatus::Friend
                    } else if requested == actor {
                        FriendStatus::Outgoing
                    } else {
                        FriendStatus::Incoming
                    },
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub fn are_friends(&self, a: &str, b: &str) -> AdapterResult<bool> {
        let (left, right) = if a < b { (a, b) } else { (b, a) };
        Ok(self
            .connection
            .query_row(
                "SELECT accepted FROM friendships WHERE left_id=?1 AND right_id=?2",
                params![left, right],
                |r| r.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    pub fn request_friend(&self, actor: &str, target: &str) -> AdapterResult<()> {
        let (left, right) = if actor < target {
            (actor, target)
        } else {
            (target, actor)
        };
        self.connection.execute(
            "INSERT OR IGNORE INTO friendships(left_id,right_id,requested_by) VALUES(?1,?2,?3)",
            params![left, right, actor],
        )?;
        Ok(())
    }
    pub fn accept_friend(&self, actor: &str, target: &str) -> AdapterResult<bool> {
        let (left, right) = if actor < target {
            (actor, target)
        } else {
            (target, actor)
        };
        Ok(self.connection.execute("UPDATE friendships SET accepted=1 WHERE left_id=?1 AND right_id=?2 AND requested_by=?3",params![left,right,target])?>0)
    }
}
