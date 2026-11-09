use delta_adapters::{
    AdapterResult,
    agent::{AgentBackend, AgentCommand, AgentConnection},
};
use delta_host::Service;
use delta_protocol::*;
use serde_json::json;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::mpsc;
#[tokio::test]
async fn reply_receipts_distinguish_real_mentions_from_quoted_text_without_granting_execution() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let editor = service
        .invite(
            &owner,
            InviteMember {
                name: "Editor".into(),
                role: Role::Editor,
            },
        )
        .await
        .unwrap()
        .member;
    let workspace = service
        .create_workspace(&owner, "Permission receipts".into())
        .await
        .unwrap();
    let literal = service
        .command(
            &editor,
            &workspace.id,
            send("literal", "`@agent` is quoted code"),
        )
        .await
        .unwrap();
    assert!(serde_json::to_value(literal).unwrap()["agent_reply"].is_null());
    let requested = service
        .command(&editor, &workspace.id, send("request", "@agent help"))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(requested).unwrap()["agent_reply"],
        "permission_required"
    );
    assert_eq!(
        service.snapshot(&workspace.id).await.unwrap().entries.len(),
        2
    );
    service.shutdown().await;
}

#[tokio::test]
async fn native_submissions_validate_quote_origins_before_publishing_or_joining() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let workspace = service
        .create_workspace(&owner, "Invalid native reference".into())
        .await
        .unwrap();
    let request = command(
        json!({"type":"submit_message","id":"question","text":"Quoted request","backend":"recording","after":null,"quotes":[{"workspace_id":"missing","entry_id":"source","fragment":"text","revision":1,"cursor":1,"quote":"not a valid source"}]}),
    );
    assert!(matches!(
        service.command(&owner, &workspace.id, request).await,
        Err(delta_host::ServiceError::NotFound)
    ));
    let snapshot = service.snapshot(&workspace.id).await.unwrap();
    assert!(snapshot.entries.is_empty());
    assert!(snapshot.collaboration.participants.is_empty());
    service.shutdown().await;
}

#[tokio::test]
async fn a_configured_quiet_default_also_applies_to_the_untouched_bootstrap_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let workspace = service.workspaces().await.unwrap().remove(0);
    let _ = service
        .set_default_reply_mode(ReplyMode::MentionsOnly)
        .await;
    assert_eq!(
        service
            .snapshot(&workspace.id)
            .await
            .unwrap()
            .collaboration
            .reply_mode,
        ReplyMode::MentionsOnly
    );
    service.shutdown().await;
}

#[tokio::test]
async fn a_bare_url_containing_agent_text_never_starts_a_backend_in_mention_only_mode() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let workspace = service
        .create_workspace(&owner, "URL mention boundary".into())
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    service
        .register_backend("recording".into(), Arc::new(Recording(calls.clone())))
        .await;
    service
        .command(
            &owner,
            &workspace.id,
            command(json!({"type":"set_reply_mode","mode":"mentions_only"})),
        )
        .await
        .unwrap();
    for (index, text) in [
        "See https://example.com/?q=(@agent)",
        "See example.com/?q=(@agent)",
        "See https://example.com/[@agent](delta-agent:recording)",
    ]
    .into_iter()
    .enumerate()
    {
        let receipt = service
            .command(&owner, &workspace.id, send(&format!("url-{index}"), text))
            .await
            .unwrap();
        assert!(receipt.agent_reply.is_none());
    }
    assert_eq!(
        service.snapshot(&workspace.id).await.unwrap().entries.len(),
        3
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    service.shutdown().await;
}

struct Recording(Arc<AtomicUsize>);
impl AgentBackend for Recording {
    fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
        let calls = self.0.clone();
        let (commands, mut input) = mpsc::channel(8);
        let (output, events) = mpsc::channel(8);
        tokio::spawn(async move {
            while let Some(command) = input.recv().await {
                match command {
                    AgentCommand::Prompt(_) => {
                        calls.fetch_add(1, Ordering::SeqCst);
                        let _ = output
                            .send(Activity::MessageEnd {
                                message_id: "m".into(),
                                text: "Recording backend response".into(),
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
struct Broken;
impl AgentBackend for Broken {
    fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
        Err("deliberate test start failure".into())
    }
}
fn command(value: serde_json::Value) -> Command {
    serde_json::from_value(value).unwrap()
}
fn send(id: &str, text: &str) -> Command {
    command(json!({"type":"submit_message","id":id,"text":text,"backend":"recording","after":null}))
}
#[tokio::test]
async fn default_auto_and_shared_mention_only_policy_survive_restart_without_reexecuting() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let w = service
        .create_workspace(&owner, "Native policy".into())
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    service
        .register_backend("recording".into(), Arc::new(Recording(calls.clone())))
        .await;
    service
        .command(&owner, &w.id, send("first", "Single participant"))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let viewer = service
        .invite(
            &owner,
            InviteMember {
                name: "Observer".into(),
                role: Role::Viewer,
            },
        )
        .await
        .unwrap()
        .member;
    service
        .command(&viewer, &w.id, command(json!({"type":"join_workspace"})))
        .await
        .unwrap();
    service
        .command(&owner, &w.id, send("second", "Human discussion"))
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let snapshot = service.snapshot(&w.id).await.unwrap();
    assert_eq!(snapshot.collaboration.reply_mode, ReplyMode::MentionsOnly);
    service.shutdown().await;
    drop(service);
    let restored = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let snapshot = restored.snapshot(&w.id).await.unwrap();
    assert_eq!(snapshot.collaboration.reply_mode, ReplyMode::MentionsOnly);
    assert_eq!(snapshot.collaboration.participants.len(), 2);
    restored
        .command(
            &owner,
            &w.id,
            send("third", "Still human-only after restart"),
        )
        .await
        .unwrap();
    assert_eq!(restored.snapshot(&w.id).await.unwrap().entries.len(), 4);
    restored.shutdown().await;
}
#[tokio::test]
async fn backend_start_failure_acknowledges_the_already_published_message() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let w = service
        .create_workspace(&owner, "Failure".into())
        .await
        .unwrap();
    service
        .register_backend("recording".into(), Arc::new(Broken))
        .await;
    let receipt = service
        .command(&owner, &w.id, send("question", "Keep my publication"))
        .await;
    assert!(
        receipt.is_ok(),
        "a shared publication must not appear unsent: {receipt:?}"
    );
    let snapshot = service.snapshot(&w.id).await.unwrap();
    assert_eq!(snapshot.entries.len(), 2);
    assert!(matches!(
        &snapshot.entries[1].content,
        Content::Agent {
            status: SessionStatus::Failed,
            ..
        }
    ));
    service.shutdown().await;
}
