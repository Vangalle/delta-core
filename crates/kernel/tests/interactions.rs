use delta_kernel::{KernelError, Workspace};
use delta_protocol::*;
fn actor(id: &str) -> Member {
    Member {
        id: id.into(),
        name: id.into(),
        role: Role::Executor,
    }
}
fn pending() -> Workspace {
    let mut workspace = Workspace::new("w".into(), "Work".into());
    let decision = workspace
        .decide(
            &actor("alice"),
            Command::PromptAgent {
                id: "agent".into(),
                backend: "pi".into(),
                prompt: "request".into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .unwrap();
    for change in decision.changes {
        workspace.apply(change);
    }
    workspace.apply(Change::AgentActivity {
        id: "agent".into(),
        activity: Activity::InteractionRequested {
            request_id: "confirmation".into(),
            kind: InteractionKind::Confirm,
            title: "Confirm?".into(),
            message: "An explicit decision is required".into(),
            options: vec![],
            initial_value: None,
        },
    });
    workspace
}
#[test]
fn only_the_controller_can_answer_a_pending_interaction_and_replies_are_single_use() {
    let mut workspace = pending();
    let reply = Command::RespondAgent {
        id: "agent".into(),
        request_id: "confirmation".into(),
        response: InteractionResponse::Confirm { confirmed: false },
    };
    assert_eq!(
        workspace.decide(&actor("bob"), reply.clone()).unwrap_err(),
        KernelError::Forbidden
    );
    let decision = workspace.decide(&actor("alice"), reply.clone()).unwrap();
    for change in decision.changes {
        workspace.apply(change);
    }
    assert_eq!(
        workspace.decide(&actor("alice"), reply).unwrap_err(),
        KernelError::NotFound
    );
}
#[test]
fn replies_are_validated_and_private_values_do_not_enter_shared_changes() {
    let mut workspace = pending();
    let invalid = Command::RespondAgent {
        id: "agent".into(),
        request_id: "confirmation".into(),
        response: InteractionResponse::Value {
            value: "wrong kind".into(),
        },
    };
    assert_eq!(
        workspace.decide(&actor("alice"), invalid).unwrap_err(),
        KernelError::Invalid
    );
    workspace.apply(Change::AgentActivity {
        id: "agent".into(),
        activity: Activity::InteractionRequested {
            request_id: "input".into(),
            kind: InteractionKind::Input,
            title: "Input".into(),
            message: "".into(),
            options: vec![],
            initial_value: None,
        },
    });
    let decision = workspace
        .decide(
            &actor("alice"),
            Command::RespondAgent {
                id: "agent".into(),
                request_id: "input".into(),
                response: InteractionResponse::Value {
                    value: "PRIVATE-REPLY".into(),
                },
            },
        )
        .unwrap();
    assert!(!format!("{:?}", decision.changes).contains("PRIVATE-REPLY"));
    assert!(format!("{:?}", decision.effect).contains("PRIVATE-REPLY"));
}
