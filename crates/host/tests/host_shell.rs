#[cfg(unix)]
#[tokio::test]
async fn executable_uses_the_hosts_user_shell_and_login_configuration() {
    use serde_json::{Value, json};
    use std::{os::unix::fs::PermissionsExt, process::Stdio};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpStream,
    };
    async fn request(address: &str, method: &str, path: &str, body: Value) -> Value {
        let data = if method == "GET" {
            String::new()
        } else {
            body.to_string()
        };
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(format!("{method} /api/v1{path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer owner\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len()).as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
        assert!(String::from_utf8_lossy(&bytes[..split]).contains("200 OK"));
        serde_json::from_slice(&bytes[split + 4..]).unwrap()
    }
    let dir = tempfile::tempdir().unwrap();
    let args = dir.path().join("shell-args");
    let shell = dir.path().join("host-shell");
    std::fs::write(
        &shell,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec /bin/sh -i\n",
            args.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    std::fs::write(data.join("owner-token"), "owner").unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_delta-host"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", dir.path())
        .env("SHELL", &shell)
        .env("DELTA_DATA", &data)
        .env("DELTA_CWD", dir.path())
        .env("DELTA_LISTEN", "127.0.0.1:0")
        .env("DELTA_TERMINAL_LOGIN", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let address = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("Host exited during startup");
            if let Some(address) = line.strip_prefix("Delta Core: http://") {
                break address.to_owned();
            }
        }
    })
    .await
    .unwrap();
    let rooms = request(&address, "GET", "/workspaces", Value::Null).await;
    let id = rooms[0]["id"].as_str().unwrap();
    request(
        &address,
        "POST",
        &format!("/workspaces/{id}/commands"),
        json!({"type":"open_terminal","id":"terminal","after":null}),
    )
    .await;
    let found = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while std::fs::read_to_string(&args)
            .unwrap_or_default()
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(found.is_ok(), "Host ignored its SHELL configuration");
    assert_eq!(
        std::fs::read_to_string(&args)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["-l", "-i"]
    );
    request(
        &address,
        "POST",
        &format!("/workspaces/{id}/commands"),
        json!({"type":"close_terminal","id":"terminal"}),
    )
    .await;
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}
