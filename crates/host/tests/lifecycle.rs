use delta_adapters::{
    AdapterResult,
    agent::{AgentBackend, AgentCommand, AgentConnection},
    journal::Journal,
};
use delta_host::Service;
use delta_protocol::{Activity, Command, Content, Member, SessionStatus};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::mpsc;

struct TestBackend {
    disconnect: bool,
}
impl AgentBackend for TestBackend {
    fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
        let disconnect = self.disconnect;
        let (commands, mut rx) = mpsc::channel(8);
        let (tx, events) = mpsc::channel(8);
        tokio::spawn(async move {
            while let Some(command) = rx.recv().await {
                match command {
                    AgentCommand::Prompt(_) if disconnect => break,
                    AgentCommand::Prompt(_) => {
                        let _ = tx.send(Activity::Settled { aborted: false }).await;
                    }
                    AgentCommand::Shutdown => break,
                    _ => {}
                }
            }
        });
        Ok(AgentConnection { commands, events })
    }
}

async fn start(service: &Service, owner: &Member, workspace: &str, prompt: &str) {
    service
        .command(
            owner,
            workspace,
            Command::PromptAgent {
                id: "agent".into(),
                backend: "test".into(),
                prompt: prompt.into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .await
        .unwrap();
}
async fn wait_status(service: &Service, workspace: &str, expected: SessionStatus) {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = service.snapshot(&service.authenticate("owner").await.unwrap(),workspace).await.unwrap();
            if matches!(&snapshot.entries[0].content, Content::Agent { status, .. } if *status == expected) { return; }
            tokio::task::yield_now().await;
        }
    }).await.expect("backend EOF did not update the durable session state");
}

#[tokio::test]
async fn backend_eof_is_persisted_as_failed_even_without_a_final_backend_event() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    service
        .register_backend("test".into(), Arc::new(TestBackend { disconnect: true }))
        .await;
    let owner = service.authenticate("owner").await.unwrap();
    let workspace = service.workspaces(&owner).await.unwrap().remove(0);
    start(&service, &owner, &workspace.id, "first request").await;
    wait_status(&service, &workspace.id, SessionStatus::Failed).await;
    let journal = Journal::open(&dir.path().join("events.sqlite")).unwrap();
    let persisted = serde_json::to_string(&journal.load(&workspace.id, 0).unwrap()).unwrap();
    assert!(persisted.contains("failed"));
    service.shutdown().await;
}

#[tokio::test]
async fn followup_prompts_are_shared_and_durable_in_the_existing_agent_session() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    service
        .register_backend("test".into(), Arc::new(TestBackend { disconnect: false }))
        .await;
    let owner = service.authenticate("owner").await.unwrap();
    let workspace = service.workspaces(&owner).await.unwrap().remove(0);
    start(&service, &owner, &workspace.id, "request A").await;
    wait_status(&service, &workspace.id, SessionStatus::Idle).await;
    start(&service, &owner, &workspace.id, "request B").await;
    let shared =
        serde_json::to_string(&service.snapshot(&owner, &workspace.id).await.unwrap()).unwrap();
    assert!(
        shared.contains("request B"),
        "executed followup is absent from the shared workspace"
    );
    let journal = Journal::open(&dir.path().join("events.sqlite")).unwrap();
    assert!(
        serde_json::to_string(&journal.load(&workspace.id, 0).unwrap())
            .unwrap()
            .contains("request B")
    );
    service.shutdown().await;
}
