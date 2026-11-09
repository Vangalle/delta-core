use crate::AdapterResult;
use delta_protocol::Activity;
use std::path::Path;
use tokio::sync::mpsc;

#[derive(Debug)]
pub enum AgentCommand { Prompt(String), Abort, Shutdown }

pub struct AgentConnection {
    pub commands: mpsc::Sender<AgentCommand>,
    pub events: mpsc::Receiver<Activity>,
}

pub trait AgentBackend: Send + Sync {
    fn start(&self, cwd: &Path) -> AdapterResult<AgentConnection>;
}
