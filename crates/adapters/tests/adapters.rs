use delta_adapters::{
    journal::Journal,
    pi::PiMapper,
    terminal::{Terminal, TerminalEvent},
};
use delta_protocol::*;
use serde_json::json;
use std::time::Duration;

#[test]
fn reopening_journal_preserves_publication_order_and_structure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    {
        let mut j = Journal::open(&path).unwrap();
        j.create_workspace(&WorkspaceInfo {
            id: "w".into(),
            title: "Work".into(),
        })
        .unwrap();
        let events = j
            .append(
                "w",
                &[Change::SessionState {
                    id: "t".into(),
                    status: SessionStatus::Interrupted,
                }],
            )
            .unwrap();
        assert_eq!(events[0].sequence, 1);
    }
    let j = Journal::open(&path).unwrap();
    assert_eq!(j.workspaces().unwrap()[0].title, "Work");
    let events = j.load("w", 0).unwrap();
    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0].change,
        Change::SessionState {
            status: SessionStatus::Interrupted,
            ..
        }
    ));
    assert!(j.load("w", 1).unwrap().is_empty());
}

#[tokio::test]
async fn real_terminal_preserves_shell_state_and_reports_child_exit() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("nested")).unwrap();
    let (mut terminal, mut events) = Terminal::spawn(dir.path(), "/bin/sh").unwrap();
    terminal
        .input("cd nested\rprintf 'CWD:'; pwd\rexit\r")
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(8), async {
        let mut output = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                TerminalEvent::Output(data) => output.extend(data),
                TerminalEvent::Exited => return String::from_utf8_lossy(&output).to_string(),
            }
        }
        panic!("missing child exit");
    })
    .await
    .unwrap();
    assert!(
        output.contains(&format!(
            "CWD:{}/nested",
            dir.path().canonicalize().unwrap().display()
        )),
        "{output}"
    );
}

#[test]
fn pi_mapping_keeps_results_structured_and_waits_for_settled() {
    let mut m = PiMapper::default();
    assert!(
        m.map(json!({"type":"agent_end","willRetry":true}))
            .is_none()
    );
    assert!(matches!(
        m.map(json!({"type":"agent_settled","aborted":false})),
        Some(Activity::Settled { aborted: false })
    ));
    let start = m.map(json!({"type":"tool_execution_start","toolCallId":"c","toolName":"bash","args":{"command":"pwd"}})).unwrap();
    assert!(
        matches!(start, Activity::ToolStart { call_id, name, args } if call_id == "c" && name == "bash" && args["command"] == "pwd")
    );
    let end = m.map(json!({"type":"tool_execution_end","toolCallId":"c","toolName":"bash","result":{"content":[{"type":"text","text":"/tmp"}],"details":{"exitCode":0}},"isError":false})).unwrap();
    assert!(
        matches!(end, Activity::ToolEnd { call_id, result, is_error: false } if call_id == "c" && result["details"]["exitCode"] == 0)
    );
}

#[test]
fn final_pi_message_replaces_streamed_text_with_authoritative_content() {
    let mut m = PiMapper::default();
    let _ = m.map(json!({"type":"message_start","message":{"role":"assistant","content":[]}}));
    assert!(
        matches!(m.map(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"draft"}})), Some(Activity::TextDelta { text, .. }) if text == "draft")
    );
    assert!(
        matches!(m.map(json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}],"stopReason":"stop"}})), Some(Activity::MessageEnd { text, .. }) if text == "final")
    );
    assert!(
        matches!(m.map(json!({"type":"response","command":"prompt","success":false,"error":"No model"})), Some(Activity::Failed { message }) if message == "No model")
    );
}

#[tokio::test]
async fn rpc_fixture_process_surfaces_eof_and_does_not_call_a_model() {
    use delta_adapters::{
        agent::{AgentBackend, AgentCommand},
        pi::PiBackend,
    };
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fixture.py");
    std::fs::write(&script, "import sys,json\nfor line in sys.stdin:\n c=json.loads(line)\n if c['type']=='prompt':\n  print(json.dumps({'type':'tool_execution_start','toolCallId':'fixture','toolName':'read','args':{'path':'x'}}),flush=True)\n  break\n").unwrap();
    let backend = PiBackend {
        executable: "python3".into(),
        args: vec![script.to_string_lossy().into_owned()],
    };
    let mut connection = backend.start(dir.path()).unwrap();
    connection
        .commands
        .send(AgentCommand::Prompt("fixture only".into()))
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut tool = false;
        while let Some(event) = connection.events.recv().await {
            if matches!(event, Activity::ToolStart { .. }) {
                tool = true;
            }
            if matches!(event, Activity::Failed { .. }) {
                return tool;
            }
        }
        false
    })
    .await
    .unwrap();
    assert!(result);
}
