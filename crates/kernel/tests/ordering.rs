use delta_kernel::{KernelError, Workspace};
use delta_protocol::{Command, Member, Role};
use serde_json::{Value, json};
fn member(id: &str, role: Role) -> Member {
    Member {
        id: id.into(),
        name: id.into(),
        role,
    }
}
fn apply(workspace: &mut Workspace, actor: &Member, value: Value) -> Vec<delta_protocol::Change> {
    let command: Command = serde_json::from_value(value).unwrap();
    let decision = workspace.decide(actor, command).unwrap();
    assert!(decision.effect.is_none());
    for change in &decision.changes {
        workspace.apply(change.clone());
    }
    decision.changes
}
fn ids(workspace: &Workspace) -> Vec<&str> {
    workspace
        .entries
        .iter()
        .map(|entry| entry.id.as_str())
        .collect()
}
#[test]
fn ordinary_submissions_append_in_server_order_even_with_a_stale_client_anchor() {
    let a = member("a", Role::Owner);
    let b = member("b", Role::Editor);
    let mut w = Workspace::new("w".into(), "Messages".into());
    apply(
        &mut w,
        &a,
        json!({"type":"set_reply_mode","mode":"mentions_only"}),
    );
    for (actor, id, text, after) in [
        (&a, "first", "first", None),
        (&b, "second", "second", None),
        (&a, "third", "third", Some("first")),
    ] {
        apply(
            &mut w,
            actor,
            json!({"type":"submit_message","id":id,"text":text,"backend":"pi","after":after}),
        );
    }
    assert_eq!(ids(&w), ["first", "second", "third"]);
}
#[test]
fn restoring_creation_order_preserves_contents_and_replays_without_rewriting_old_events() {
    let a = member("a", Role::Owner);
    let b = member("b", Role::Editor);
    let mut w = Workspace::new("w".into(), "Existing messages".into());
    let mut history = Vec::new();
    for (actor, id, text, after) in [
        (&a, "first", "what's the pwd?", None),
        (&b, "second", "an earlier reply", None),
        (&a, "third", "thx", Some("first")),
    ] {
        history.extend(apply(
            &mut w,
            actor,
            json!({"type":"publish_text","id":id,"base_revision":0,"text":text,"after":after}),
        ));
    }
    assert_eq!(ids(&w), ["first", "third", "second"]);
    let original = w
        .entries
        .iter()
        .map(|entry| (entry.id.clone(), serde_json::to_value(entry).unwrap()))
        .collect::<std::collections::HashMap<_, _>>();
    history.extend(apply(
        &mut w,
        &a,
        json!({"type":"restore_chronological_order"}),
    ));
    assert_eq!(ids(&w), ["first", "second", "third"]);
    for entry in &w.entries {
        assert_eq!(serde_json::to_value(entry).unwrap(), original[&entry.id]);
    }
    let mut restored = Workspace::new("w".into(), "Existing messages".into());
    for change in history {
        restored.apply(change);
    }
    assert_eq!(ids(&restored), ["first", "second", "third"]);
    let command = serde_json::from_value(json!({"type":"restore_chronological_order"})).unwrap();
    assert_eq!(w.decide(&b, command).unwrap_err(), KernelError::Forbidden);
}
