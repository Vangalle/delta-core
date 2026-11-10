mod common;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use delta_host::{Service, ServiceError, router};
use delta_protocol::*;
use serde_json::{Value, json};
use tower::ServiceExt;
async fn change(app: &Router, token: &str, w: &str, id: &str, role: &str) -> StatusCode {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/workspaces/{w}/members/{id}/role"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(json!({"role":role}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
fn cmd(v: Value) -> Command {
    serde_json::from_value(v).unwrap()
}
#[tokio::test]
async fn existing_member_can_be_explicitly_promoted_and_scope_downgrade_stops_its_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = s.authenticate("owner").await.unwrap();
    let w = s.create_workspace(&owner, "Roles".into()).await.unwrap();
    let login = common::invite(&s, &owner, &w.id, "Guest", Role::Editor).await;
    let cached_editor = login.member.clone();
    let app = router(s.clone(), None);
    assert!(matches!(
        s.command(
            &cached_editor,
            &w.id,
            cmd(json!({"type":"open_terminal","id":"t","after":null}))
        )
        .await,
        Err(ServiceError::Forbidden)
    ));
    assert_eq!(
        change(&app, "owner", &w.id, &login.member.id, "executor").await,
        StatusCode::OK
    );
    let executor = s.authenticate(&login.token).await.unwrap();
    assert_eq!(executor.role, Role::Executor);
    s.command(
        &cached_editor,
        &w.id,
        cmd(json!({"type":"open_terminal","id":"t","after":null})),
    )
    .await
    .unwrap();
    let snapshot = serde_json::to_value(s.snapshot(&executor, &w.id).await.unwrap()).unwrap();
    assert_eq!(snapshot["self_id"], executor.id);
    assert_eq!(snapshot["access"]["can_execute"], true);
    assert_eq!(
        change(&app, &login.token, &w.id, &owner.id, "editor").await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        change(&app, "owner", &w.id, &login.member.id, "editor").await,
        StatusCode::OK
    );
    assert!(matches!(
        s.command(
            &executor,
            &w.id,
            cmd(json!({"type":"terminal_input","id":"t","data":"echo forbidden\r"}))
        )
        .await,
        Err(ServiceError::Forbidden)
    ));
    let snapshot = s.snapshot(&executor, &w.id).await.unwrap();
    assert!(!snapshot.access.unwrap().can_execute);
    assert!(matches!(
        &snapshot.entries[0].content,
        Content::Terminal {
            status: SessionStatus::Interrupted | SessionStatus::Closed,
            ..
        }
    ));
    assert_eq!(
        change(&app, "owner", &w.id, &owner.id, "viewer").await,
        StatusCode::BAD_REQUEST
    );
    s.shutdown().await;
}
#[tokio::test]
async fn scope_downgrade_closes_a_controlled_backend_even_when_no_more_output_arrives() {
    use delta_adapters::{
        AdapterResult,
        agent::{AgentBackend, AgentCommand, AgentConnection},
    };
    use std::{
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };
    struct Hold(Arc<AtomicBool>);
    impl AgentBackend for Hold {
        fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
            let (commands, mut input) = tokio::sync::mpsc::channel(8);
            let (output, events) = tokio::sync::mpsc::channel(8);
            let closed = self.0.clone();
            tokio::spawn(async move {
                let _: Option<AgentCommand> = input.recv().await;
                let _ = output.send(Activity::Settled { aborted: false }).await;
                output.closed().await;
                closed.store(true, Ordering::SeqCst);
            });
            Ok(AgentConnection { commands, events })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = s.authenticate("owner").await.unwrap();
    let w = s
        .create_workspace(&owner, "Backend revocation".into())
        .await
        .unwrap();
    let login = common::invite(&s, &owner, &w.id, "Executor", Role::Executor).await;
    let closed = Arc::new(AtomicBool::new(false));
    s.register_backend("hold".into(), Arc::new(Hold(closed.clone())))
        .await;
    s.command(&login.member,&w.id,cmd(json!({"type":"prompt_agent","id":"agent","backend":"hold","prompt":"fixture only","after":null}))).await.unwrap();
    let app = router(s.clone(), None);
    assert_eq!(
        change(&app, "owner", &w.id, &login.member.id, "editor").await,
        StatusCode::OK
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !closed.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        &s.snapshot(&owner, &w.id).await.unwrap().entries[0].content,
        Content::Agent {
            status: SessionStatus::Interrupted,
            ..
        }
    ));
    s.shutdown().await;
}
#[tokio::test]
async fn workspace_owner_without_host_trust_cannot_mint_execution_for_an_existing_member() {
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let root = s.authenticate("owner").await.unwrap();
    let initial = s.create_workspace(&root, "Initial".into()).await.unwrap();
    let alice = common::invite(&s, &root, &initial.id, "Alice", Role::Editor).await;
    let w = s
        .create_workspace(&alice.member, "Alice room".into())
        .await
        .unwrap();
    let bob = common::invite(&s, &alice.member, &w.id, "Bob", Role::Editor).await;
    let app = router(s.clone(), None);
    assert_eq!(
        change(&app, &alice.token, &w.id, &bob.member.id, "executor").await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        change(&app, "owner", &w.id, &bob.member.id, "executor").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        change(&app, &alice.token, &w.id, &bob.member.id, "viewer").await,
        StatusCode::OK
    );
    assert!(
        !s.snapshot(&bob.member, &w.id)
            .await
            .unwrap()
            .access
            .unwrap()
            .can_execute
    );
    s.shutdown().await;
}
