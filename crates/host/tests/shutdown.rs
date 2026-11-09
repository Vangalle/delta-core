use axum::{body::Body, http::Request};
use delta_host::{Service, router};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn host_shutdown_terminates_live_event_streams() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let workspace = service.workspaces().await.unwrap().remove(0);
    let response = router(service.clone(), None)
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/workspaces/{}/events", workspace.id))
                .header("Authorization", "Bearer owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    service.shutdown().await;
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        response.into_body().collect(),
    )
    .await;
    assert!(result.is_ok(), "active SSE clients prevented host shutdown");
}
