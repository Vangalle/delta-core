use crate::AdapterResult;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    io::{Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc as sync_mpsc,
    },
};
use tokio::sync::mpsc;

pub enum TerminalEvent {
    Output(Vec<u8>),
    Exited,
    InputFailed(String),
}

pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    input: sync_mpsc::SyncSender<Vec<u8>>,
    closed: Arc<AtomicBool>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Terminal {
    pub fn spawn(cwd: &Path, shell: &str) -> AdapterResult<(Self, mpsc::Receiver<TerminalEvent>)> {
        let pair = native_pty_system().openpty(PtySize {
            rows: 12,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(shell);
        command.arg("-i");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("HISTFILE", "/dev/null");
        let mut child = pair.slave.spawn_command(command)?;
        let killer = child.clone_killer();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (tx, rx) = mpsc::channel(64);
        let (input, queued) = sync_mpsc::sync_channel::<Vec<u8>>(16);
        let closed = Arc::new(AtomicBool::new(false));
        let writer_closed = closed.clone();
        let writer_events = tx.clone();
        std::thread::spawn(move || {
            while let Ok(bytes) = queued.recv() {
                if writer_closed.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
                    if !writer_closed.load(Ordering::Acquire) {
                        let _ = writer_events
                            .blocking_send(TerminalEvent::InputFailed(error.to_string()));
                    }
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx
                            .blocking_send(TerminalEvent::Output(buf[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = child.wait();
            let _ = tx.blocking_send(TerminalEvent::Exited);
        });
        Ok((
            Self {
                master: pair.master,
                input,
                closed,
                killer,
            },
            rx,
        ))
    }

    pub fn input(&mut self, data: &str) -> AdapterResult<()> {
        if data.len() > 16_384 || self.closed.load(Ordering::Acquire) {
            return Err("terminal input is too large or closed".into());
        }
        self.input
            .try_send(data.as_bytes().to_vec())
            .map_err(|_| "terminal input queue is full or closed".into())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AdapterResult<()> {
        self.master.resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&mut self) -> AdapterResult<()> {
        self.closed.store(true, Ordering::Release);
        self.killer.kill()?;
        Ok(())
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.killer.kill();
    }
}
