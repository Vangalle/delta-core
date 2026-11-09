use delta_adapters::{
    agent::{AgentBackend, AgentCommand},
    pi::{PiBackend, PiMapper},
};
use delta_protocol::{Activity, InteractionKind, InteractionResponse};
use serde_json::json;
#[test]
fn pi_dialog_requests_are_normalized_without_treating_notifications_as_blocking() {
    let mut mapper = PiMapper::default();
    assert!(
        matches!(mapper.map(json!({"type":"extension_ui_request","id":"r","method":"confirm","title":"Confirm","message":"Proceed?"})), Some(Activity::InteractionRequested { request_id, kind: InteractionKind::Confirm, .. }) if request_id == "r")
    );
    assert!(matches!(
        mapper.map(
            json!({"type":"extension_ui_request","id":"n","method":"notify","message":"Notice"})
        ),
        Some(Activity::Backend { .. })
    ));
}
#[tokio::test]
async fn a_declined_confirmation_is_sent_back_through_the_real_rpc_transport() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("dialog.py");
    std::fs::write(&script, "import sys,json\nfor line in sys.stdin:\n c=json.loads(line)\n if c['type']=='prompt': print(json.dumps({'type':'extension_ui_request','id':'confirm','method':'confirm','title':'Confirm'}),flush=True)\n elif c['type']=='extension_ui_response':\n  if c.get('id')=='confirm' and c.get('confirmed') is False: print(json.dumps({'type':'agent_settled','aborted':False}),flush=True)\n").unwrap();
    let backend = PiBackend {
        executable: "python3".into(),
        args: vec![script.to_string_lossy().into_owned()],
    };
    let mut connection = backend.start(dir.path()).unwrap();
    connection
        .commands
        .send(AgentCommand::Prompt("fixture".into()))
        .await
        .unwrap();
    let requested =
        tokio::time::timeout(std::time::Duration::from_secs(2), connection.events.recv())
            .await
            .unwrap()
            .unwrap();
    assert!(matches!(requested, Activity::InteractionRequested { .. }));
    connection
        .commands
        .send(AgentCommand::Respond {
            request_id: "confirm".into(),
            response: InteractionResponse::Confirm { confirmed: false },
        })
        .await
        .unwrap();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), connection.events.recv())
            .await
            .unwrap()
            .unwrap(),
        Activity::Settled { aborted: false }
    ));
    connection
        .commands
        .send(AgentCommand::Shutdown)
        .await
        .unwrap();
}
