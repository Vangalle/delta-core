use crate::AdapterResult;
use delta_protocol::*;
use rusqlite::{Connection, params};
use std::path::Path;

pub struct Journal {
    connection: Connection,
}

impl Journal {
    pub fn open(path: &Path) -> AdapterResult<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL REFERENCES workspaces(id), change_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_workspace ON events(workspace, sequence);
            CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE);")?;
        Ok(Self { connection })
    }

    pub fn create_workspace(&self, info: &WorkspaceInfo) -> AdapterResult<()> {
        self.connection.execute(
            "INSERT INTO workspaces(id,title) VALUES(?1,?2)",
            params![info.id, info.title],
        )?;
        Ok(())
    }

    pub fn workspaces(&self) -> AdapterResult<Vec<WorkspaceInfo>> {
        let mut stmt = self
            .connection
            .prepare("SELECT id,title FROM workspaces ORDER BY rowid")?;
        let items = stmt
            .query_map([], |r| {
                Ok(WorkspaceInfo {
                    id: r.get(0)?,
                    title: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn append(&mut self, workspace: &str, changes: &[Change]) -> AdapterResult<Vec<Event>> {
        let tx = self.connection.transaction()?;
        let mut events = Vec::new();
        for change in changes {
            tx.execute(
                "INSERT INTO events(workspace,change_json) VALUES(?1,?2)",
                params![workspace, serde_json::to_string(change)?],
            )?;
            events.push(Event {
                sequence: tx.last_insert_rowid() as u64,
                change: change.clone(),
            });
        }
        tx.commit()?;
        Ok(events)
    }

    pub fn load(&self, workspace: &str, after: u64) -> AdapterResult<Vec<Event>> {
        let mut stmt = self.connection.prepare("SELECT sequence,change_json FROM events WHERE workspace=?1 AND sequence>?2 ORDER BY sequence")?;
        let rows = stmt.query_map(params![workspace, after.min(i64::MAX as u64) as i64], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, json) = row?;
            events.push(Event {
                sequence,
                change: serde_json::from_str(&json)?,
            });
        }
        Ok(events)
    }

    pub fn add_member(&self, member: &Member, token_hash: &str) -> AdapterResult<()> {
        self.connection.execute(
            "INSERT INTO members(id,name,role,token_hash) VALUES(?1,?2,?3,?4)",
            params![
                member.id,
                member.name,
                serde_json::to_string(&member.role)?,
                token_hash
            ],
        )?;
        Ok(())
    }

    pub fn authenticate(&self, token_hash: &str) -> AdapterResult<Option<Member>> {
        let mut stmt = self
            .connection
            .prepare("SELECT id,name,role FROM members WHERE token_hash=?1")?;
        let mut rows = stmt.query([token_hash])?;
        let Some(r) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(Member {
            id: r.get(0)?,
            name: r.get(1)?,
            role: serde_json::from_str(&r.get::<_, String>(2)?)?,
        }))
    }

    pub fn members(&self) -> AdapterResult<Vec<Member>> {
        let mut stmt = self
            .connection
            .prepare("SELECT id,name,role FROM members ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut members = Vec::new();
        for r in rows {
            let (id, name, role) = r?;
            members.push(Member {
                id,
                name,
                role: serde_json::from_str(&role)?,
            });
        }
        Ok(members)
    }
}
