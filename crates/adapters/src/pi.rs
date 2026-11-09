use crate::{
    AdapterResult,
    agent::{AgentBackend, AgentCommand, AgentConnection},
};
use delta_protocol::{Activity, InteractionKind, InteractionResponse};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};

#[derive(Default)]
pub struct PiMapper {
    message: u64,
}

impl PiMapper {
    pub fn map(&mut self, event: Value) -> Option<Activity> {
        let text = |v: &Value, key: &str| v[key].as_str().unwrap_or_default().to_owned();
        match event["type"].as_str()? {
            "message_start" if event["message"]["role"] == "assistant" => {
                self.message += 1;
                Some(Activity::MessageStart {
                    message_id: self.message.to_string(),
                })
            }
            "message_update" if event["assistantMessageEvent"]["type"] == "text_delta" => {
                let update = &event["assistantMessageEvent"];
                Some(Activity::TextDelta {
                    message_id: self.message.to_string(),
                    index: update["contentIndex"].as_u64().unwrap_or(0),
                    text: text(update, "delta"),
                })
            }
            "message_end" if event["message"]["role"] == "assistant" => {
                let m = &event["message"];
                if matches!(m["stopReason"].as_str(), Some("error" | "aborted"))
                    && m["errorMessage"].is_string()
                {
                    return Some(Activity::Failed {
                        message: text(m, "errorMessage"),
                    });
                }
                let content = m["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|b| b["type"] == "text")
                            .map(|b| text(b, "text"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                Some(Activity::MessageEnd {
                    message_id: self.message.to_string(),
                    text: content,
                })
            }
            "tool_execution_start" => Some(Activity::ToolStart {
                call_id: text(&event, "toolCallId"),
                name: text(&event, "toolName"),
                args: event["args"].clone(),
            }),
            "tool_execution_update" => Some(Activity::ToolUpdate {
                call_id: text(&event, "toolCallId"),
                result: event["partialResult"].clone(),
            }),
            "tool_execution_end" => Some(Activity::ToolEnd {
                call_id: text(&event, "toolCallId"),
                result: event["result"].clone(),
                is_error: event["isError"].as_bool().unwrap_or(false),
            }),
            "extension_ui_request" if event["method"] == "setTitle" => None,
            "extension_ui_request"
                if matches!(
                    event["method"].as_str(),
                    Some("confirm" | "select" | "input" | "editor")
                ) =>
            {
                Some(Activity::InteractionRequested {
                    request_id: text(&event, "id"),
                    kind: match event["method"].as_str() {
                        Some("confirm") => InteractionKind::Confirm,
                        Some("select") => InteractionKind::Select,
                        Some("editor") => InteractionKind::Editor,
                        _ => InteractionKind::Input,
                    },
                    title: text(&event, "title"),
                    message: event["message"]
                        .as_str()
                        .or(event["placeholder"].as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    options: event["options"]
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default(),
                    initial_value: event["prefill"].as_str().map(str::to_owned),
                })
            }
            "agent_settled" => Some(Activity::Settled {
                aborted: event["aborted"].as_bool().unwrap_or(false),
            }),
            "response" if event["command"] == "get_state" && event["success"] == true => {
                Some(Activity::Backend {
                    data: json!({"type":"model_selected", "provider": event["data"]["model"]["provider"], "model": event["data"]["model"]["id"]}),
                })
            }
            "response" if event["success"] == false => Some(Activity::Failed {
                message: text(&event, "error"),
            }),
            "response"
                if event["command"] == "prompt" && event["data"]["disposition"] == "handled" =>
            {
                Some(Activity::Settled { aborted: false })
            }
            "agent_end" | "agent_start" | "turn_start" | "turn_end" | "message_start"
            | "message_end" | "message_update" | "response" => None,
            _ => Some(Activity::Backend { data: event }),
        }
    }
}

pub struct PiBackend {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

impl Default for PiBackend {
    fn default() -> Self {
        Self {
            executable: "pi".into(),
            args: ["--mode", "rpc", "--no-session", "--no-approve"]
                .map(str::to_owned)
                .into(),
        }
    }
}

impl AgentBackend for PiBackend {
    fn start(&self, cwd: &Path) -> AdapterResult<AgentConnection> {
        let mut child = Command::new(&self.executable)
            .args(&self.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().ok_or("missing Pi stdin")?;
        let stdout = child.stdout.take().ok_or("missing Pi stdout")?;
        let stderr = child.stderr.take().ok_or("missing Pi stderr")?;
        let (commands, mut input) = mpsc::channel(32);
        let (tx, events) = mpsc::channel(128);
        let diagnostics = tx.clone();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            loop {
                let mut bytes = Vec::new();
                match (&mut reader)
                    .take(65_536)
                    .read_until(b'\n', &mut bytes)
                    .await
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let message = String::from_utf8_lossy(&bytes).into_owned();
                        if diagnostics
                            .send(Activity::Backend {
                                data: json!({"type":"diagnostic", "text":message}),
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });
        let writer_events = tx.clone();
        let mut writer_task = tokio::spawn(async move {
            if let Err(error) = stdin
                .write_all(b"{\"id\":\"delta-model\",\"type\":\"get_state\"}\n")
                .await
            {
                let _ = writer_events
                    .send(Activity::Failed {
                        message: format!("Pi startup handshake failed: {error}"),
                    })
                    .await;
                return;
            }
            let mut request = 0u64;
            while let Some(command) = input.recv().await {
                let value = match command {
                    AgentCommand::Prompt(message) => {
                        request += 1;
                        json!({"id":format!("p-{request}"), "type":"prompt", "message":message})
                    }
                    AgentCommand::Abort => json!({"type":"abort"}),
                    AgentCommand::Respond {
                        request_id,
                        response,
                    } => match response {
                        InteractionResponse::Confirm { confirmed } => {
                            json!({"type":"extension_ui_response", "id":request_id, "confirmed":confirmed})
                        }
                        InteractionResponse::Value { value } => {
                            json!({"type":"extension_ui_response", "id":request_id, "value":value})
                        }
                        InteractionResponse::Cancel => {
                            json!({"type":"extension_ui_response", "id":request_id, "cancelled":true})
                        }
                    },
                    AgentCommand::Shutdown => break,
                };
                let mut bytes = serde_json::to_vec(&value).unwrap_or_default();
                bytes.push(b'\n');
                if let Err(error) = stdin.write_all(&bytes).await {
                    let _ = writer_events
                        .send(Activity::Failed {
                            message: format!("Pi write failed: {error}"),
                        })
                        .await;
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut mapper = PiMapper::default();
            let mut line = Vec::new();
            loop {
                let mut capped = (&mut reader).take(8_388_608u64.saturating_sub(line.len() as u64));
                tokio::select! {
                    _ = tx.closed() => break,
                    _ = &mut writer_task => break,
                    result = capped.read_until(b'\n', &mut line) => {
                        let event = match result {
                            Ok(0) => { let _ = tx.send(Activity::Failed { message: "Pi process disconnected".into() }).await; break; },
                            Ok(_) if line.last() == Some(&b'\n') => serde_json::from_slice::<Value>(&line),
                            _ => { let _ = tx.send(Activity::Failed { message: "Pi protocol read failed or record exceeds 8 MiB".into() }).await; break; },
                        };
                        line.clear();
                        match event {
                            Ok(value) => {
                                let sent = match mapper.map(value) {
                                    Some(activity) => tx.send(activity).await.is_ok(),
                                    None => true,
                                };
                                if !sent { break; }
                            }
                            Err(error) => { let _ = tx.send(Activity::Failed { message: format!("Invalid Pi JSONL: {error}") }).await; break; },
                        }
                    }
                }
            }
            writer_task.abort();
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_task.abort();
        });
        Ok(AgentConnection { commands, events })
    }
}
