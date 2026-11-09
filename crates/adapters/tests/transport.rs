use delta_adapters::{
    agent::{AgentBackend, AgentCommand},
    pi::PiBackend,
};
use delta_protocol::Activity;
use std::time::Duration;

#[tokio::test]
async fn stdout_is_drained_while_a_large_prompt_is_being_written() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fixture.py");
    std::fs::write(&script,"import sys,json\nprint(json.dumps({'type':'diagnostic','text':'x'*262144}),flush=True)\nfor line in sys.stdin:\n c=json.loads(line)\n if c['type']=='prompt':\n  print(json.dumps({'type':'agent_settled','aborted':False}),flush=True)\n").unwrap();
    let backend = PiBackend {
        executable: "python3".into(),
        args: vec![script.to_string_lossy().into_owned()],
    };
    let mut connection = backend.start(dir.path()).unwrap();
    connection
        .commands
        .send(AgentCommand::Prompt("p".repeat(262144)))
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(event) = connection.events.recv().await {
            if matches!(event, Activity::Settled { .. }) {
                return true;
            }
        }
        false
    })
    .await;
    assert!(
        result.unwrap_or(false),
        "Pi stdout and stdin deadlocked under backpressure"
    );
}
