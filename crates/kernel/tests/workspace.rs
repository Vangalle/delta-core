use delta_kernel::{KernelError, Workspace};
use delta_protocol::*;

fn member(id: &str, role: Role) -> Member {
    Member {
        id: id.into(),
        name: id.into(),
        role,
    }
}

fn publish(
    w: &mut Workspace,
    id: &str,
    base_revision: u64,
    text: &str,
    after: Option<&str>,
) -> Result<(), KernelError> {
    let d = w.decide(
        &member("alice", Role::Editor),
        Command::PublishText {
            id: id.into(),
            base_revision,
            text: text.into(),
            after: after.map(str::to_owned),
            quotes: Vec::new(),
        },
    )?;
    for c in d.changes {
        w.apply(c);
    }
    Ok(())
}

#[test]
fn stale_publication_cannot_overwrite_shared_text() {
    let mut w = Workspace::new("w".into(), "Work".into());
    publish(&mut w, "a", 0, "first", None).unwrap();
    assert_eq!(
        publish(&mut w, "a", 0, "stale", None).unwrap_err(),
        KernelError::Conflict
    );
    assert!(matches!(&w.entries[0].content, Content::Text { text } if text == "first"));
    publish(&mut w, "a", 1, "second", None).unwrap();
    assert_eq!(w.entries[0].revision, 2);
}

#[test]
fn insertion_is_in_document_order_not_a_chat_append_only_log() {
    let mut w = Workspace::new("w".into(), "Work".into());
    publish(&mut w, "a", 0, "top", None).unwrap();
    publish(&mut w, "b", 0, "bottom", Some("a")).unwrap();
    publish(&mut w, "c", 0, "middle", Some("a")).unwrap();
    assert_eq!(
        w.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        ["a", "c", "b"]
    );
    assert_eq!(
        publish(&mut w, "d", 0, "orphan", Some("missing")).unwrap_err(),
        KernelError::NotFound
    );
}

#[test]
fn drafts_are_not_shared_until_an_explicit_command_is_applied() {
    let mut w = Workspace::new("w".into(), "Work".into());
    let d = w
        .decide(
            &member("alice", Role::Editor),
            Command::PublishText {
                id: "a".into(),
                base_revision: 0,
                text: "private".into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .unwrap();
    assert!(w.entries.is_empty());
    for c in d.changes {
        w.apply(c);
    }
    assert_eq!(w.entries.len(), 1);
}

#[test]
fn execution_requires_a_grant_and_terminal_control_is_not_shared() {
    let mut w = Workspace::new("w".into(), "Work".into());
    let command = Command::OpenTerminal {
        id: "t".into(),
        after: None,
    };
    assert_eq!(
        w.decide(&member("alice", Role::Editor), command.clone())
            .unwrap_err(),
        KernelError::Forbidden
    );
    let d = w.decide(&member("alice", Role::Executor), command).unwrap();
    for c in d.changes {
        w.apply(c);
    }
    let input = Command::TerminalInput {
        id: "t".into(),
        data: "pwd\r".into(),
    };
    assert!(
        w.decide(&member("alice", Role::Executor), input.clone())
            .is_ok()
    );
    assert_eq!(
        w.decide(&member("bob", Role::Executor), input).unwrap_err(),
        KernelError::Forbidden
    );
}

#[test]
fn viewer_cannot_publish_and_invalid_commands_cannot_create_entries() {
    let w = Workspace::new("w".into(), "Work".into());
    let p = Command::PublishText {
        id: "a".into(),
        base_revision: 0,
        text: "text".into(),
        after: None,
        quotes: Vec::new(),
    };
    assert_eq!(
        w.decide(&member("viewer", Role::Viewer), p).unwrap_err(),
        KernelError::Forbidden
    );
    assert!(
        w.decide(
            &member("alice", Role::Executor),
            Command::OpenTerminal {
                id: "".into(),
                after: None
            }
        )
        .is_err()
    );
    assert!(w.entries.is_empty());
}

#[test]
fn structured_tool_results_remain_attached_to_the_agent_entry() {
    let mut w = Workspace::new("w".into(), "Work".into());
    let d = w
        .decide(
            &member("alice", Role::Executor),
            Command::PromptAgent {
                id: "a".into(),
                backend: "other".into(),
                prompt: "test".into(),
                after: None,
                quotes: Vec::new(),
            },
        )
        .unwrap();
    for c in d.changes {
        w.apply(c);
    }
    w.apply(Change::AgentActivity {
        id: "a".into(),
        activity: Activity::Settled { aborted: false },
    });
    assert!(matches!(
        &w.entries[0].content,
        Content::Agent {
            status: SessionStatus::Idle,
            ..
        }
    ));
}
