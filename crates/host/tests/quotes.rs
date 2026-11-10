use delta_adapters::{
    AdapterResult,
    agent::{AgentBackend, AgentCommand, AgentConnection},
};
use delta_host::{Service, ServiceError};
use delta_protocol::*;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::mpsc;

fn command(value: Value) -> Command {
    serde_json::from_value(value).unwrap()
}
async fn setup() -> (
    tempfile::TempDir,
    Service,
    Member,
    WorkspaceInfo,
    WorkspaceInfo,
) {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let source = service.workspaces(&owner).await.unwrap().remove(0);
    service.command(&owner, &source.id, command(json!({"type":"publish_text","id":"source","base_revision":0,"text":"Before QUOTED-CONTEXT after","after":null}))).await.unwrap();
    let target = service
        .create_workspace(&owner, "Destination".into())
        .await
        .unwrap();
    (dir, service, owner, source, target)
}
fn quote(source: &WorkspaceInfo) -> Value {
    json!({"workspace_id":source.id,"entry_id":"source","fragment":"text","revision":1,"cursor":1,"quote":"QUOTED-CONTEXT"})
}

#[tokio::test]
async fn publishing_a_quote_preserves_its_source_snapshot_and_survives_restart() {
    let (dir, service, owner, source, target) = setup().await;
    let context = quote(&source);
    service.command(&owner, &target.id, command(json!({"type":"publish_text","id":"response","base_revision":0,"text":"My explanation","after":null,"quotes":[context.clone()]}))).await.unwrap();
    service.command(&owner, &source.id, command(json!({"type":"publish_text","id":"source","base_revision":1,"text":"New shared version","after":null}))).await.unwrap();
    let reopened = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let snapshot =
        serde_json::to_value(reopened.snapshot(&owner, &target.id).await.unwrap()).unwrap();
    assert_eq!(snapshot["entries"][0]["quotes"], json!([context]));
    assert_eq!(snapshot["entries"][0]["content"]["text"], "My explanation");
    assert_eq!(
        reopened.snapshot(&owner, &source.id).await.unwrap().entries[0].revision,
        2
    );
}

#[tokio::test]
async fn missing_sources_future_revisions_and_unbounded_quotes_are_rejected_without_publication() {
    let (_dir, service, owner, source, target) = setup().await;
    for (field, value) in [
        ("entry_id", json!("missing")),
        ("fragment", json!("tool:unknown")),
        ("revision", json!(999)),
        ("cursor", json!(999)),
        ("quote", json!("x".repeat(16385))),
    ] {
        let mut context = quote(&source);
        context[field] = value;
        let result = service.command(&owner, &target.id, command(json!({"type":"publish_text","id":"invalid","base_revision":0,"text":"unchanged","after":null,"quotes":[context]}))).await;
        assert!(
            matches!(
                result,
                Err(ServiceError::NotFound | ServiceError::Invalid | ServiceError::Conflict)
            ),
            "accepted invalid {field}"
        );
    }
    assert!(
        service
            .snapshot(&owner, &target.id)
            .await
            .unwrap()
            .entries
            .is_empty()
    );
}

struct QuoteBackend;
impl AgentBackend for QuoteBackend {
    fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
        let (commands, mut input) = mpsc::channel(8);
        let (output, events) = mpsc::channel(8);
        tokio::spawn(async move {
            while let Some(command) = input.recv().await {
                match command {
                    AgentCommand::Prompt(message)
                        if message.contains("Quoted excerpts")
                            && message.contains("QUOTED-CONTEXT")
                            && message.contains("workspace_id") =>
                    {
                        let _ = output
                            .send(Activity::MessageEnd {
                                message_id: "m".into(),
                                text: "Quote reached the backend".into(),
                            })
                            .await;
                        let _ = output.send(Activity::Settled { aborted: false }).await;
                    }
                    AgentCommand::Shutdown => break,
                    _ => {}
                }
            }
        });
        Ok(AgentConnection { commands, events })
    }
}

#[tokio::test]
async fn quoted_context_reaches_an_independent_agent_and_is_recorded_for_followups() {
    let (_dir, service, owner, source, target) = setup().await;
    service
        .register_backend("quote".into(), Arc::new(QuoteBackend))
        .await;
    for request in ["First question", "Followup question"] {
        service.command(&owner, &target.id, command(json!({"type":"prompt_agent","id":"agent","backend":"quote","prompt":request,"after":null,"quotes":[quote(&source)]}))).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let snapshot =
                    serde_json::to_value(service.snapshot(&owner, &target.id).await.unwrap())
                        .unwrap();
                if snapshot["entries"][0]["content"]["status"] == "idle" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    let snapshot =
        serde_json::to_value(service.snapshot(&owner, &target.id).await.unwrap()).unwrap();
    assert_eq!(
        snapshot["entries"][0]["quotes"][0]["quote"],
        "QUOTED-CONTEXT"
    );
    let activities = snapshot["entries"][0]["content"]["activities"]
        .as_array()
        .unwrap();
    assert!(
        activities
            .iter()
            .any(|activity| activity["type"] == "prompt"
                && activity["text"] == "Followup question"
                && activity["quotes"][0]["quote"] == "QUOTED-CONTEXT")
    );
    service.shutdown().await;
}
