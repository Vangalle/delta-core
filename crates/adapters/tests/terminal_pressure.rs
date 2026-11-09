use delta_adapters::terminal::{Terminal, TerminalEvent};
use std::{sync::mpsc, time::Duration};

#[tokio::test]
async fn a_nonreading_terminal_has_bounded_input_without_blocking_its_controller() {
    let dir = tempfile::tempdir().unwrap();
    let (mut terminal, mut events) = Terminal::spawn(dir.path(), "/bin/sh").unwrap();
    terminal
        .input("stty raw -echo; printf '\\nREADY\\n'; sleep 2; exit\r")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut output = String::new();
        while let Some(event) = events.recv().await {
            if let TerminalEvent::Output(bytes) = event {
                output.push_str(&String::from_utf8_lossy(&bytes));
                if output.contains("\nREADY\n") {
                    return;
                }
            }
        }
        panic!("shell did not enter nonreading state");
    })
    .await
    .unwrap();
    let (done, finished) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut rejected = false;
        for _ in 0..128 {
            if terminal.input(&"x".repeat(16_384)).is_err() {
                rejected = true;
                break;
            }
        }
        let _ = done.send((terminal, rejected));
    });
    let result = finished.recv_timeout(Duration::from_millis(300));
    if result.is_err() {
        worker.join().unwrap();
        panic!("PTY backpressure blocked input instead of rejecting a full queue");
    }
    let (mut terminal, rejected) = result.unwrap();
    assert!(rejected, "input queue did not apply a finite bound");
    terminal.close().unwrap();
    worker.join().unwrap();
}
