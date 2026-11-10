use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use delta_host::{Service, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> axum::response::Response {
    let mut r = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        r = r.header("Authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        r = r.header("Content-Type", "application/json");
    }
    app.clone()
        .oneshot(
            r.body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn setup() -> (tempfile::TempDir, Service, Router, String) {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner-secret").unwrap();
    let app = router(service.clone(), None);
    let workspaces = json_body(
        request(
            &app,
            "GET",
            "/api/v1/workspaces",
            Some("owner-secret"),
            None,
        )
        .await,
    )
    .await;
    let id = workspaces[0]["id"].as_str().unwrap().to_owned();
    (dir, service, app, id)
}

#[tokio::test]
async fn anonymous_access_and_ungranted_execution_are_rejected() {
    let (_dir, _service, app, id) = setup().await;
    assert_eq!(
        request(&app, "GET", "/api/v1/workspaces", None, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let invite = json_body(
        request(
            &app,
            "POST",
            &format!("/api/v1/workspaces/{id}/invitations"),
            Some("owner-secret"),
            Some(json!({"name":"Bob","role":"editor"})),
        )
        .await,
    )
    .await;
    let accepted = json_body(
        request(
            &app,
            "POST",
            "/api/v1/invitations/accept",
            None,
            Some(json!({"token":invite["token"],"name":"Bob"})),
        )
        .await,
    )
    .await;
    let token = accepted["login_token"].as_str().unwrap();
    let path = format!("/api/v1/workspaces/{id}/commands");
    assert_eq!(
        request(
            &app,
            "POST",
            &path,
            Some(token),
            Some(json!({"type":"open_terminal","id":"t","after":null}))
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/v1/workspaces/{id}/invitations"),
            Some(token),
            Some(json!({"name":"Mallory","role":"executor"}))
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert!(
        json_body(
            request(
                &app,
                "GET",
                &format!("/api/v1/workspaces/{id}"),
                Some(token),
                None
            )
            .await
        )
        .await["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn stale_publication_is_conflict_and_shared_content_survives_restart() {
    let (dir, _service, app, id) = setup().await;
    let path = format!("/api/v1/workspaces/{id}/commands");
    let body =
        json!({"type":"publish_text","id":"a","base_revision":0,"text":"published","after":null});
    assert_eq!(
        request(
            &app,
            "POST",
            &path,
            Some("owner-secret"),
            Some(body.clone())
        )
        .await
        .status(),
        StatusCode::OK
    );
    let mut stale = body;
    stale["text"] = json!("overwrite");
    assert_eq!(
        request(&app, "POST", &path, Some("owner-secret"), Some(stale))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let reopened = Service::open(dir.path(), dir.path(), "owner-secret").unwrap();
    let snapshot = reopened
        .snapshot(&reopened.authenticate("owner-secret").await.unwrap(), &id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap()["entries"][0]["content"]["text"],
        "published"
    );
    assert_eq!(snapshot.cursor, 1);
}

#[tokio::test]
async fn subscriber_replays_only_events_after_its_cursor() {
    let (_dir, service, app, id) = setup().await;
    let path = format!("/api/v1/workspaces/{id}/commands");
    for (revision, text) in [(0, "one"), (1, "two")] {
        assert_eq!(request(&app,"POST",&path,Some("owner-secret"),Some(json!({"type":"publish_text","id":"a","base_revision":revision,"text":text,"after":null}))).await.status(), StatusCode::OK);
    }
    let (events, mut rx) = service
        .subscribe(&service.authenticate("owner-secret").await.unwrap(), &id, 1)
        .await
        .unwrap();
    assert_eq!(events.iter().map(|e| e.sequence).collect::<Vec<_>>(), [2]);
    request(
        &app,
        "POST",
        &path,
        Some("owner-secret"),
        Some(json!({"type":"publish_text","id":"a","base_revision":2,"text":"three","after":null})),
    )
    .await;
    let (workspace, event) = rx.recv().await.unwrap();
    assert_eq!(workspace, id);
    assert_eq!(event.sequence, 3);
    let response = request(
        &app,
        "GET",
        &format!("/api/v1/workspaces/{id}/events?after=2"),
        Some("owner-secret"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert!(String::from_utf8_lossy(&frame).contains("\"sequence\":3"));
}

#[tokio::test]
async fn restart_marks_prior_terminal_interrupted_without_rerunning_it() {
    let (dir, _service, app, id) = setup().await;
    let path = format!("/api/v1/workspaces/{id}/commands");
    assert_eq!(
        request(
            &app,
            "POST",
            &path,
            Some("owner-secret"),
            Some(json!({"type":"open_terminal","id":"t","after":null}))
        )
        .await
        .status(),
        StatusCode::OK
    );
    let reopened = Service::open(dir.path(), dir.path(), "owner-secret").unwrap();
    let snapshot = serde_json::to_value(
        reopened
            .snapshot(&reopened.authenticate("owner-secret").await.unwrap(), &id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot["entries"][0]["content"]["status"], "interrupted");
    request(
        &app,
        "POST",
        &path,
        Some("owner-secret"),
        Some(json!({"type":"close_terminal","id":"t"})),
    )
    .await;
}

#[tokio::test]
async fn references_must_resolve_and_backend_choice_is_validated_before_insertion() {
    let (_dir, _service, app, id) = setup().await;
    let path = format!("/api/v1/workspaces/{id}/commands");
    assert_eq!(request(&app,"POST",&path,Some("owner-secret"),Some(json!({"type":"insert_reference","id":"r","kind":"thread","target":"missing","label":"missing","after":null}))).await.status(),StatusCode::NOT_FOUND);
    assert_eq!(request(&app,"POST",&path,Some("owner-secret"),Some(json!({"type":"prompt_agent","id":"p","backend":"missing","prompt":"test","after":null}))).await.status(),StatusCode::BAD_REQUEST);
}
