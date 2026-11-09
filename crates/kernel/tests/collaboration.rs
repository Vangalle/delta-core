use delta_kernel::{Effect, KernelError, Workspace};
use delta_protocol::{Command, Member, Role};
use serde_json::{Value, json};
fn member(id: &str, role: Role) -> Member {
    Member {
        id: id.into(),
        name: id.into(),
        role,
    }
}
fn apply(w: &mut Workspace, who: &Member, value: Value) -> delta_kernel::Decision {
    let command: Command = serde_json::from_value(value).unwrap();
    let decision = w.decide(who, command).unwrap();
    for c in &decision.changes {
        w.apply(c.clone());
    }
    decision
}
fn send(id: &str, text: &str) -> Value {
    json!({"type":"submit_message","id":id,"text":text,"backend":"pi","after":null})
}
#[test]
fn distinct_participants_quiet_the_workspace_and_manual_override_survives_more_joins() {
    let mut w = Workspace::new("w".into(), "Writing".into());
    let a = member("a", Role::Owner);
    apply(&mut w, &a, json!({"type":"join_workspace"}));
    assert!(
        apply(&mut w, &a, json!({"type":"join_workspace"}))
            .changes
            .is_empty()
    );
    assert!(matches!(
        apply(&mut w, &a, send("one", "Hello")).effect,
        Some(Effect::PromptAgent { .. })
    ));
    let joined = apply(
        &mut w,
        &member("b", Role::Viewer),
        json!({"type":"join_workspace"}),
    );
    assert!(
        serde_json::to_string(&joined.changes)
            .unwrap()
            .contains("mentions_only")
    );
    assert!(
        apply(&mut w, &a, send("two", "Human conversation"))
            .effect
            .is_none()
    );
    assert!(matches!(
        apply(&mut w, &a, send("three", "@agent help")).effect,
        Some(Effect::PromptAgent { .. })
    ));
    apply(&mut w, &a, json!({"type":"set_reply_mode","mode":"auto"}));
    apply(
        &mut w,
        &member("c", Role::Editor),
        json!({"type":"join_workspace"}),
    );
    assert!(matches!(
        apply(&mut w, &a, send("four", "Automatically reply")).effect,
        Some(Effect::PromptAgent { .. })
    ));
}
#[test]
fn only_real_agent_mentions_trigger_and_editors_never_gain_execution() {
    let mut w = Workspace::new("w".into(), "Writing".into());
    let a = member("a", Role::Owner);
    apply(
        &mut w,
        &a,
        json!({"type":"set_reply_mode","mode":"mentions_only"}),
    );
    for (i, text) in [
        "```text\n@agent\n```",
        "`@agent`",
        "<code>@agent</code>",
        "<a href=\"https://example.com\">@agent</a>",
        "> @agent",
        r"\@agent hi",
        "https://example.com/@agent",
        "See https://example.com/?q=(@agent)",
        "See https://example.com/?q=(*@agent*)",
        "See www.example.com/?q=(@agent)",
        "See example.com/?q=(@agent)",
        "See https://example.com/[@agent](delta-agent:pi)",
        "See data:text/plain,(@agent)",
        "foo@agent.test",
        "$@agent$",
        r"\(@agent\)",
        r"\[@agent\]",
        "[quoted](https://example.com/@agent)",
        "[@agent](https://example.com)",
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            apply(&mut w, &a, send(&format!("n{i}"), text))
                .effect
                .is_none(),
            "false trigger {text}"
        );
    }
    assert!(matches!(
        apply(
            &mut w,
            &a,
            send(
                "after-url",
                "See https://example.com first, then @agent help"
            )
        )
        .effect,
        Some(Effect::PromptAgent { .. })
    ));
    assert!(matches!(
        apply(
            &mut w,
            &a,
            send("wrapped", "([@agent](delta-agent:pi)) explain")
        )
        .effect,
        Some(Effect::PromptAgent { .. })
    ));
    assert!(matches!(
        apply(
            &mut w,
            &a,
            send("real", "Please [@agent](delta-agent:pi) explain")
        )
        .effect,
        Some(Effect::PromptAgent { .. })
    ));
    assert!(
        apply(
            &mut w,
            &member("editor", Role::Editor),
            send("editor", "@agent run tools")
        )
        .effect
        .is_none()
    );
    let command = serde_json::from_value(json!({"type":"set_reply_mode","mode":"auto"})).unwrap();
    assert_eq!(
        w.decide(&member("editor", Role::Editor), command)
            .unwrap_err(),
        KernelError::Forbidden
    );
}
#[test]
fn existing_document_contributors_are_counted_when_a_workspace_is_joined() {
    let mut w = Workspace::new("w".into(), "Legacy shared writing".into());
    let a = member("a", Role::Owner);
    let b = member("b", Role::Editor);
    for (who, id) in [(&a, "old-a"), (&b, "old-b")] {
        apply(
            &mut w,
            who,
            json!({"type":"publish_text","id":id,"base_revision":0,"text":"Previously shared text","after":null}),
        );
    }
    apply(&mut w, &a, json!({"type":"join_workspace"}));
    assert!(
        apply(&mut w, &a, send("new", "Do not unexpectedly wake an Agent"))
            .effect
            .is_none()
    );
}

#[test]
fn submitted_messages_are_atomic_nonduplicating_and_document_edits_stay_nonexecuting() {
    let mut w = Workspace::new("w".into(), "Writing".into());
    let a = member("a", Role::Owner);
    let d = apply(&mut w, &a, send("message", "Question"));
    assert_eq!(
        d.changes
            .iter()
            .filter(|c| matches!(c, delta_protocol::Change::Inserted { .. }))
            .count(),
        2
    );
    assert_eq!(
        serde_json::to_value(&w.entries[1]).unwrap()["content"]["source_entry"],
        "message"
    );
    let repeated = serde_json::from_value(send("message", "Question")).unwrap();
    assert_eq!(w.decide(&a, repeated).unwrap_err(), KernelError::Conflict);
    let edited = apply(
        &mut w,
        &a,
        json!({"type":"publish_text","id":"message","base_revision":1,"text":"Edited @agent","after":null}),
    );
    assert!(edited.effect.is_none());
    assert_eq!(w.entries.len(), 2);
}
