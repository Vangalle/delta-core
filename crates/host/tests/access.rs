use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use delta_adapters::journal::Journal;
use delta_host::{Service, router};
use delta_protocol::*;
use serde_json::{Value, json};
use tower::ServiceExt;
fn hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
async fn request(
    app: &Router,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut r = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"));
    if let Some(token) = token {
        r = r.header("authorization", format!("Bearer {token}"));
    }
    let r = if method == "GET" {
        r.body(Body::empty()).unwrap()
    } else {
        r.header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = app.clone().oneshot(r).await.unwrap();
    let status = response.status();
    if path.contains("/events") {
        return (status, Value::Null);
    }
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn setup() -> (tempfile::TempDir, Service, Router) {
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "root-token").unwrap();
    s.set_default_reply_mode(ReplyMode::MentionsOnly)
        .await
        .unwrap();
    let app = router(s.clone(), None);
    (dir, s, app)
}
async fn room(app: &Router, token: &str, name: &str) -> String {
    let (status, w) = request(
        app,
        Some(token),
        "POST",
        "/workspaces",
        json!({"title":name}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    w["id"].as_str().unwrap().into()
}
async fn invite(app: &Router, w: &str, role: &str) -> Value {
    let (status, v) = request(
        app,
        Some("root-token"),
        "POST",
        &format!("/workspaces/{w}/invitations"),
        json!({"name":"Peer","role":role}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    v
}
async fn claim(app: &Router, inv: &Value, token: Option<&str>) -> Value {
    let (status, v) = request(
        app,
        token,
        "POST",
        "/invitations/accept",
        json!({"token":inv["token"],"name":"Peer"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    v
}
#[tokio::test]
async fn native_subscription_never_delivers_other_workspace_events() {
    let (_dir, s, app) = setup().await;
    let a = room(&app, "root-token", "Subscription A").await;
    let b = room(&app, "root-token", "Subscription B").await;
    let owner = s.authenticate("root-token").await.unwrap();
    let cursor = s.snapshot(&owner, &a).await.unwrap().cursor;
    let (_, mut stream) = s.subscribe(&owner, &a, cursor).await.unwrap();
    for id in [&b, &a] {
        request(
            &app,
            Some("root-token"),
            "POST",
            &format!("/workspaces/{id}/commands"),
            json!({"type":"publish_text","id":"note","base_revision":0,"text":id,"after":null}),
        )
        .await;
    }
    let (id, _) = tokio::time::timeout(std::time::Duration::from_secs(1), stream.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(id, a);
    s.shutdown().await;
}
#[tokio::test]
async fn accepting_another_invitation_does_not_restore_stale_account_permissions() {
    let (_dir, s, app) = setup().await;
    let a = room(&app, "root-token", "Identity").await;
    let first = claim(&app, &invite(&app, &a, "editor").await, None).await;
    let token = first["login_token"].as_str().unwrap();
    let cached = s.authenticate(token).await.unwrap();
    let b = room(&app, "root-token", "Execution grant").await;
    claim(&app, &invite(&app, &b, "executor").await, Some(token)).await;
    assert_eq!(s.authenticate(token).await.unwrap().role, Role::Executor);
    let c = room(&app, "root-token", "Read only").await;
    let inv = invite(&app, &c, "viewer").await;
    s.accept_invitation(
        Some(&cached),
        AcceptInvitation {
            token: inv["token"].as_str().unwrap().into(),
            name: "Ignored".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(s.authenticate(token).await.unwrap().role, Role::Executor);
    s.shutdown().await;
}
#[tokio::test]
async fn migration_preserves_explicit_participants_and_history_once_with_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut j = Journal::open(&dir.path().join("events.sqlite")).unwrap();
        for (id, role) in [
            ("owner", Role::Owner),
            ("writer", Role::Editor),
            ("reader", Role::Viewer),
            ("dormant", Role::Editor),
        ] {
            j.add_member(
                &Member {
                    id: id.into(),
                    name: id.into(),
                    role,
                },
                &hash(id),
            )
            .unwrap();
        }
        for id in ["a", "b"] {
            j.create_workspace(&WorkspaceInfo {
                id: id.into(),
                title: id.into(),
            })
            .unwrap();
        }
        j.append("a",&[serde_json::from_value(json!({"type":"inserted","after":null,"entry":{"id":"old","revision":1,"author":"writer","content":{"type":"text","text":"Preserve this"}}})).unwrap(),Change::ParticipantJoined{member:"reader".into()}]).unwrap();
    }
    for _ in 0..2 {
        let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
        let app = router(s.clone(), None);
        let (_, rooms) = request(&app, Some("writer"), "GET", "/workspaces", Value::Null).await;
        assert_eq!(rooms, json!([{"id":"a","title":"a"}]));
        let (_, snap) = request(&app, Some("reader"), "GET", "/workspaces/a", Value::Null).await;
        assert_eq!(snap["entries"][0]["content"]["text"], "Preserve this");
        assert_eq!(snap["entries"][0]["revision"], 1);
        assert_eq!(
            request(&app, Some("reader"), "GET", "/workspaces/b", Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(&app, Some("dormant"), "GET", "/workspaces", Value::Null)
                .await
                .1,
            json!([])
        );
        s.shutdown().await;
    }
    let backup = dir.path().join("events.before-workspace-access.sqlite");
    assert!(backup.exists());
    assert_eq!(
        Journal::open(&backup).unwrap().load("a", 0).unwrap().len(),
        2
    );
}
#[tokio::test]
async fn inaccessible_references_and_quotes_do_not_leak_into_shared_agent_context() {
    use delta_adapters::{
        AdapterResult,
        agent::{AgentBackend, AgentCommand, AgentConnection},
    };
    use std::{
        path::Path,
        sync::{Arc, Mutex},
    };
    struct Capture(Arc<Mutex<Vec<String>>>);
    impl AgentBackend for Capture {
        fn start(&self, _: &Path) -> AdapterResult<AgentConnection> {
            let (commands, mut input) = tokio::sync::mpsc::channel(8);
            let (output, events) = tokio::sync::mpsc::channel(8);
            let capture = self.0.clone();
            tokio::spawn(async move {
                while let Some(command) = input.recv().await {
                    match command {
                        AgentCommand::Prompt(text) => {
                            capture.lock().unwrap().push(text);
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
    let (_dir, s, app) = setup().await;
    let a = room(&app, "root-token", "Shared").await;
    let b = room(&app, "root-token", "Private").await;
    let inv = invite(&app, &a, "editor").await;
    let peer = claim(&app, &inv, None).await;
    let token = peer["login_token"].as_str().unwrap();
    assert_eq!(request(&app,Some("root-token"),"POST",&format!("/workspaces/{b}/commands"),json!({"type":"publish_text","id":"secret","base_revision":0,"text":"NEVER_EXPORT_PRIVATE","after":null})).await.0,StatusCode::OK);
    for command in [
        json!({"type":"insert_reference","id":"ref","kind":"thread","target":b,"label":"Private","after":null}),
        json!({"type":"publish_text","id":"quote","base_revision":0,"text":"No","after":null,"quotes":[{"workspace_id":b,"entry_id":"secret","revision":1,"cursor":1,"fragment":"text","quote":"made-up"}]}),
    ] {
        assert_eq!(
            request(
                &app,
                Some(token),
                "POST",
                &format!("/workspaces/{a}/commands"),
                command
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(request(&app,Some("root-token"),"POST",&format!("/workspaces/{a}/commands"),json!({"type":"insert_reference","id":"ref","kind":"thread","target":b,"label":"Private","after":null})).await.0,StatusCode::OK);
    let capture = Arc::new(Mutex::new(Vec::new()));
    s.register_backend("capture".into(), Arc::new(Capture(capture.clone())))
        .await;
    assert_eq!(request(&app,Some("root-token"),"POST",&format!("/workspaces/{a}/commands"),json!({"type":"prompt_agent","id":"agent","backend":"capture","prompt":"Only safe shared context","after":null})).await.0,StatusCode::OK);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while capture.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!capture.lock().unwrap()[0].contains("NEVER_EXPORT_PRIVATE"));
    s.shutdown().await;
}
#[tokio::test]
async fn dormant_legacy_accounts_cannot_enumerate_or_join_unrelated_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    {
        let j = Journal::open(&dir.path().join("events.sqlite")).unwrap();
        j.add_member(
            &Member {
                id: "owner".into(),
                name: "Host".into(),
                role: Role::Owner,
            },
            &hash("root-token"),
        )
        .unwrap();
        j.add_member(
            &Member {
                id: "dormant".into(),
                name: "Dormant".into(),
                role: Role::Editor,
            },
            &hash("dormant-token"),
        )
        .unwrap();
    }
    let s = Service::open(dir.path(), dir.path(), "root-token").unwrap();
    let app = router(s.clone(), None);
    let a = room(&app, "root-token", "Private").await;
    let (status, list) = request(
        &app,
        Some("dormant-token"),
        "GET",
        "/workspaces",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list, json!([]));
    for suffix in ["", "/events?after=0", "/members"] {
        let (status, _) = request(
            &app,
            Some("dormant-token"),
            "GET",
            &format!("/workspaces/{a}{suffix}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (status, _) = request(
        &app,
        Some("dormant-token"),
        "POST",
        &format!("/workspaces/{a}/commands"),
        json!({"type":"join_workspace"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &app,
        Some("root-token"),
        "POST",
        "/members",
        json!({"name":"Global","role":"editor"}),
    )
    .await;
    assert!(!status.is_success());
    s.shutdown().await;
}
#[tokio::test]
async fn invitation_is_scoped_single_use_and_existing_logins_keep_their_identity() {
    let (_dir, s, app) = setup().await;
    let a = room(&app, "root-token", "Selected").await;
    let b = room(&app, "root-token", "Unrelated").await;
    let inv = invite(&app, &a, "editor").await;
    let (status, preview) = request(
        &app,
        None,
        "GET",
        &format!("/invitations/{}", inv["token"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["workspace"]["id"], a);
    let accepted = claim(&app, &inv, None).await;
    let token = accepted["login_token"].as_str().unwrap();
    assert_ne!(token, inv["token"].as_str().unwrap());
    let (status, rooms) = request(&app, Some(token), "GET", "/workspaces", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rooms.as_array().unwrap().len(), 1);
    assert_eq!(rooms[0]["id"], a);
    for suffix in ["", "/events?after=0", "/members"] {
        assert_eq!(
            request(
                &app,
                Some(token),
                "GET",
                &format!("/workspaces/{b}{suffix}"),
                Value::Null
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        request(
            &app,
            None,
            "POST",
            "/invitations/accept",
            json!({"token":inv["token"],"name":"Stolen"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let inv2 = invite(&app, &b, "viewer").await;
    let again = claim(&app, &inv2, Some(token)).await;
    assert_eq!(again["member"]["id"], accepted["member"]["id"]);
    assert!(again["login_token"].is_null());
    let (_, snap) = request(
        &app,
        Some(token),
        "GET",
        &format!("/workspaces/{b}"),
        Value::Null,
    )
    .await;
    assert_eq!(snap["access"]["role"], "viewer");
    assert_eq!(snap["access"]["can_execute"], false);
    assert_eq!(request(&app,Some(token),"POST",&format!("/workspaces/{b}/commands"),json!({"type":"publish_text","id":"x","base_revision":0,"text":"forbidden","after":null})).await.0,StatusCode::FORBIDDEN);
    let own = room(&app, token, "Peer owned").await;
    assert_eq!(
        request(
            &app,
            Some("root-token"),
            "GET",
            &format!("/workspaces/{own}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (_, own_snap) = request(
        &app,
        Some(token),
        "GET",
        &format!("/workspaces/{own}"),
        Value::Null,
    )
    .await;
    assert_eq!(
        own_snap["access"],
        json!({"role":"owner","can_execute":false})
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "POST",
            &format!("/workspaces/{own}/commands"),
            json!({"type":"open_terminal","id":"unsafe","after":null})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "POST",
            &format!("/workspaces/{own}/invitations"),
            json!({"name":"Unsafe","role":"executor"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "POST",
            &format!("/workspaces/{own}/commands"),
            json!({"type":"restore_chronological_order"})
        )
        .await
        .0,
        StatusCode::OK
    );
    s.shutdown().await;
}
#[tokio::test]
async fn friends_require_recipient_consent_and_do_not_grant_access_until_explicitly_added() {
    let (_dir, s, app) = setup().await;
    let a = room(&app, "root-token", "Shared invitation").await;
    let b = room(&app, "root-token", "New workspace").await;
    let inv = invite(&app, &a, "editor").await;
    let accepted = claim(&app, &inv, None).await;
    let token = accepted["login_token"].as_str().unwrap();
    let id = accepted["member"]["id"].as_str().unwrap();
    let add = json!({"member_id":id,"role":"editor"});
    let target = format!("/workspaces/{b}/members");
    assert_eq!(
        request(&app, Some("root-token"), "POST", &target, add.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "POST",
            "/friends/request",
            json!({"member_id":"owner"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "POST",
            "/friends/accept",
            json!({"member_id":"owner"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, incoming) = request(&app, Some("root-token"), "GET", "/friends", Value::Null).await;
    assert_eq!(incoming[0]["status"], "incoming");
    assert_eq!(incoming[0]["peer"]["id"], id);
    assert_eq!(
        request(
            &app,
            Some("root-token"),
            "POST",
            "/friends/accept",
            json!({"member_id":id})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "GET",
            &format!("/workspaces/{b}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, Some("root-token"), "POST", &target, add)
            .await
            .0,
        StatusCode::OK
    );
    let (_, snap) = request(
        &app,
        Some(token),
        "GET",
        &format!("/workspaces/{b}"),
        Value::Null,
    )
    .await;
    assert_eq!(snap["access"], json!({"role":"editor","can_execute":false}));
    assert_eq!(snap["collaboration"]["reply_mode"], "mentions_only");
    assert_eq!(
        request(
            &app,
            Some("root-token"),
            "POST",
            &target,
            json!({"member_id":id,"role":"viewer"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Some("root-token"),
            "POST",
            &target,
            json!({"member_id":id,"role":"editor"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Some(token),
            "POST",
            &target,
            json!({"member_id":"owner","role":"editor"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    s.shutdown().await;
}
