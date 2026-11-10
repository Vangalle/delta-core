use delta_adapters::{
    AdapterResult,
    agent::{AgentBackend, AgentCommand, AgentConnection},
};
use delta_host::Service;
use delta_protocol::{Activity, Command, Content, SessionStatus};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::mpsc;

struct AlternativeBackend;
impl AgentBackend for AlternativeBackend {
    fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
        let (commands, mut rx) = mpsc::channel(4);
        let (tx, events) = mpsc::channel(4);
        tokio::spawn(async move {
            while let Some(command) = rx.recv().await {
                if let AgentCommand::Prompt(prompt) = command {
                    if !prompt.contains("shared material")
                        || !prompt.contains("referenced material")
                    {
                        break;
                    }
                    let _ = tx
                        .send(Activity::MessageEnd {
                            message_id: "other-message".into(),
                            text: "Alternative backend result".into(),
                        })
                        .await;
                    let _ = tx.send(Activity::Settled { aborted: false }).await;
                }
            }
        });
        Ok(AgentConnection { commands, events })
    }
}

#[tokio::test]
async fn non_pi_backend_uses_the_same_kernel_and_receives_published_context() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    service
        .register_backend("alternative".into(), Arc::new(AlternativeBackend))
        .await;
    let owner = service.authenticate("owner").await.unwrap();
    let workspace = service.workspaces(&owner).await.unwrap().remove(0);
    service
        .command(
            &owner,
            &workspace.id,
            Command::PublishText {
                id: "text".into(),
                base_revision: 0,
                text: "shared material".into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .await
        .unwrap();
    let referenced = service
        .create_workspace(&owner, "Related work".into())
        .await
        .unwrap();
    service
        .command(
            &owner,
            &referenced.id,
            Command::PublishText {
                id: "related".into(),
                base_revision: 0,
                text: "referenced material".into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .await
        .unwrap();
    service
        .command(
            &owner,
            &workspace.id,
            Command::InsertReference {
                id: "reference".into(),
                kind: delta_protocol::ReferenceKind::Thread,
                target: referenced.id,
                label: "Related work".into(),
                after: None,
            },
        )
        .await
        .unwrap();
    service
        .command(
            &owner,
            &workspace.id,
            Command::PromptAgent {
                id: "agent".into(),
                backend: "alternative".into(),
                prompt: "Use the shared context".into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = service.snapshot(&owner,&workspace.id).await.unwrap();
            if let Content::Agent { status: SessionStatus::Idle, activities, .. } = &snapshot.entries[2].content {
                assert!(activities.iter().any(|a| matches!(a, Activity::MessageEnd { text, .. } if text == "Alternative backend result")));
                break;
            }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    service.shutdown().await;
}
