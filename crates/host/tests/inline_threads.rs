mod common;
use delta_host::{Service, ServiceError};
use delta_protocol::*;
use serde_json::json;
fn command(value: serde_json::Value) -> Command {
    serde_json::from_value(value).unwrap()
}
#[tokio::test]
async fn inline_thread_mentions_have_native_identity_and_require_source_membership() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = service.authenticate("owner").await.unwrap();
    let a = service
        .create_workspace(&owner, "Shared".into())
        .await
        .unwrap();
    let b = service
        .create_workspace(&owner, "Related".into())
        .await
        .unwrap();
    let editor = common::invite(&service, &owner, &a.id, "Editor", Role::Editor)
        .await
        .member;
    let text = format!("Before [@Related](delta-thread:{}) after", b.id);
    service.command(&owner,&a.id,command(json!({"type":"publish_text","id":"source","base_revision":0,"text":text,"after":null}))).await.unwrap();
    let snapshot = serde_json::to_value(service.snapshot(&owner, &a.id).await.unwrap()).unwrap();
    assert_eq!(snapshot["entries"][0]["mentions"][0]["kind"], "thread");
    assert_eq!(snapshot["entries"][0]["mentions"][0]["target"], b.id);
    for kind in ["publish_text", "submit_message", "prompt_agent"] {
        let value = match kind {
            "publish_text" => {
                json!({"type":kind,"id":"denied","base_revision":0,"text":text,"after":null})
            }
            "submit_message" => {
                json!({"type":kind,"id":"denied","text":text,"backend":"pi","after":null})
            }
            _ => json!({"type":kind,"id":"denied","prompt":text,"backend":"pi","after":null}),
        };
        assert!(
            matches!(
                service.command(&editor, &a.id, command(value)).await,
                Err(ServiceError::NotFound)
            ),
            "{kind} bypassed source access"
        );
    }
    assert_eq!(
        service.snapshot(&owner, &a.id).await.unwrap().entries.len(),
        1
    );
    service.shutdown().await;
}
#[tokio::test]
async fn inline_thread_context_is_expanded_only_for_the_whole_destination_audience() {
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
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = s.authenticate("owner").await.unwrap();
    let a = s
        .create_workspace(&owner, "Destination".into())
        .await
        .unwrap();
    let b = s.create_workspace(&owner, "Source".into()).await.unwrap();
    s.command(&owner,&b.id,command(json!({"type":"publish_text","id":"secret","base_revision":0,"text":"THREAD_CONTEXT_NONCE","after":null}))).await.unwrap();
    let capture = Arc::new(Mutex::new(Vec::new()));
    s.register_backend("capture".into(), Arc::new(Capture(capture.clone())))
        .await;
    let prompt = format!("Use [@Source](delta-thread:{})", b.id);
    for turn in 0..2 {
        if turn == 1 {
            common::invite(&s, &owner, &a.id, "Private source outsider", Role::Editor).await;
        }
        s.command(&owner,&a.id,command(json!({"type":"prompt_agent","id":"agent","backend":"capture","prompt":prompt,"after":null}))).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if capture.lock().unwrap().len() > turn
                    && matches!(
                        &s.snapshot(&owner, &a.id).await.unwrap().entries[0].content,
                        Content::Agent {
                            status: SessionStatus::Idle,
                            ..
                        }
                    )
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    {
        let prompts = capture.lock().unwrap();
        assert!(prompts[0].contains("THREAD_CONTEXT_NONCE"));
        assert!(!prompts[1].contains("THREAD_CONTEXT_NONCE"));
    }
    s.shutdown().await;
}
#[tokio::test]
async fn manual_followups_expand_threads_even_if_the_agent_session_started_from_submission() {
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
            let prompts = self.0.clone();
            tokio::spawn(async move {
                while let Some(command) = input.recv().await {
                    match command {
                        AgentCommand::Prompt(text) => {
                            prompts.lock().unwrap().push(text);
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
    let dir = tempfile::tempdir().unwrap();
    let s = Service::open(dir.path(), dir.path(), "owner").unwrap();
    let owner = s.authenticate("owner").await.unwrap();
    let a = s
        .create_workspace(&owner, "Native session".into())
        .await
        .unwrap();
    let b = s
        .create_workspace(&owner, "Followup source".into())
        .await
        .unwrap();
    s.command(&owner,&b.id,command(json!({"type":"publish_text","id":"source","base_revision":0,"text":"FOLLOWUP_THREAD_CONTEXT","after":null}))).await.unwrap();
    let prompts = Arc::new(Mutex::new(Vec::new()));
    s.register_backend("capture".into(), Arc::new(Capture(prompts.clone())))
        .await;
    s.command(&owner,&a.id,command(json!({"type":"submit_message","id":"initial","text":"Start a native response","backend":"capture","after":null}))).await.unwrap();
    let agent = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = s.snapshot(&owner, &a.id).await.unwrap();
            if let Some(entry) = snapshot.entries.iter().find(|e| {
                matches!(
                    &e.content,
                    Content::Agent {
                        status: SessionStatus::Idle,
                        source_entry: Some(_),
                        ..
                    }
                )
            }) {
                break entry.id.clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    s.command(&owner,&a.id,command(json!({"type":"prompt_agent","id":agent,"backend":"capture","prompt":format!("Now use [@Source](delta-thread:{})",b.id),"after":null}))).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while prompts.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(prompts.lock().unwrap()[1].contains("FOLLOWUP_THREAD_CONTEXT"));
    s.shutdown().await;
}
#[test]
fn inline_thread_links_in_code_quotes_and_urls_are_not_context_references() {
    let normal = delta_kernel::parse_mentions("x [@Related](delta-thread:ws) y", "pi");
    assert_eq!(
        serde_json::to_value(&normal).unwrap(),
        json!([{"kind":"thread","target":"ws","label":"@Related"}])
    );
    for text in [
        "`[@Related](delta-thread:ws)`",
        "> [@Related](delta-thread:ws)",
        "https://example.com/[@Related](delta-thread:ws)",
    ] {
        assert!(
            delta_kernel::parse_mentions(text, "pi").is_empty(),
            "parsed {text}"
        );
    }
}
