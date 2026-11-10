mod common;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use delta_host::{Service, router};
use delta_protocol::*;
use tower::ServiceExt;
async fn open(app: &Router, token: &str, id: &str, body: &str) -> StatusCode {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/workspaces/{id}/desktop-terminal"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_owned()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
#[cfg(unix)]
#[tokio::test]
async fn an_enabled_fake_launcher_is_owner_only_and_accepts_no_browser_command() {
    use delta_adapters::{AdapterResult, desktop_terminal::DesktopTerminalBackend};
    use std::{path::Path, sync::Arc};
    struct Fake;
    impl DesktopTerminalBackend for Fake {
        fn command(&self, cwd: &Path) -> AdapterResult<tokio::process::Command> {
            let mut command = tokio::process::Command::new("/usr/bin/touch");
            command.arg(cwd.join("fake-desktop.marker"));
            Ok(command)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner")
        .unwrap()
        .with_desktop_terminal(Arc::new(Fake));
    let owner = s.authenticate("owner").await.unwrap();
    let w = s
        .create_workspace(&owner, "Fake desktop".into())
        .await
        .unwrap();
    let guest = common::invite(&s, &owner, &w.id, "Executor", Role::Executor).await;
    let app = router(s.clone(), None);
    let marker = dir.path().join("fake-desktop.marker");
    assert!(
        s.snapshot(&owner, &w.id)
            .await
            .unwrap()
            .capabilities
            .contains(&"desktop_terminal".into())
    );
    assert_eq!(
        open(&app, &guest.token, &w.id, "{}").await,
        StatusCode::FORBIDDEN
    );
    assert!(!marker.exists());
    assert_eq!(
        open(&app, "owner", &w.id, r#"{"command":"untrusted"}"#).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(!marker.exists());
    assert_eq!(open(&app, "owner", &w.id, "{}").await, StatusCode::OK);
    assert!(marker.exists());
    assert!(s.snapshot(&owner, &w.id).await.unwrap().entries.is_empty());
    s.shutdown().await;
}
#[cfg(target_os = "macos")]
#[test]
fn desktop_script_keeps_directory_data_outside_its_source() {
    use delta_adapters::desktop_terminal::{DesktopTerminalBackend, MacTerminal};
    let path = std::path::Path::new("/tmp/a 'quote' ; injected \"name\"");
    let command = MacTerminal.command(path).unwrap();
    let args = command
        .as_std()
        .get_args()
        .map(|v| v.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(args[0], "-e");
    assert!(args[1].contains("quoted form of targetDirectory"));
    assert!(!args[1].contains("injected"));
    assert_eq!(args[2], path.to_string_lossy());
}
#[tokio::test]
async fn desktop_terminal_is_disabled_by_default_and_cannot_be_used_by_invitees() {
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = s.authenticate("owner").await.unwrap();
    let w = s
        .create_workspace(&owner, "Experimental desktop".into())
        .await
        .unwrap();
    let guest = common::invite(&s, &owner, &w.id, "Executor", Role::Executor).await;
    let app = router(s.clone(), None);
    assert_eq!(
        open(&app, "owner", &w.id, "{}").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        open(&app, &guest.token, &w.id, "{}").await,
        StatusCode::FORBIDDEN
    );
    assert!(s.snapshot(&owner, &w.id).await.unwrap().entries.is_empty());
    assert!(
        !s.snapshot(&owner, &w.id)
            .await
            .unwrap()
            .capabilities
            .contains(&"desktop_terminal".to_owned())
    );
    s.shutdown().await;
}
