use delta_adapters::pi::PiMapper;
use delta_protocol::Activity;
use serde_json::json;

#[test]
fn terminal_title_animation_does_not_pollute_the_shared_document() {
    let mut mapper = PiMapper::default();
    assert!(mapper.map(json!({"type":"extension_ui_request","id":"spinner","method":"setTitle","title":"π working"})).is_none());
}

#[test]
fn pi_selected_model_is_reported_without_leaking_configuration_or_credentials() {
    let mut mapper = PiMapper::default();
    let activity = mapper.map(json!({"type":"response","command":"get_state","success":true,"data":{"model":{"id":"real-model","provider":"provider","baseUrl":"https://private.example","apiKey":"not-for-the-client"},"sessionFile":"/private/session.jsonl"}}));
    let Some(Activity::Backend { data }) = activity else {
        panic!("selected model metadata was discarded");
    };
    assert_eq!(
        data,
        json!({"type":"model_selected","provider":"provider","model":"real-model"})
    );
}
