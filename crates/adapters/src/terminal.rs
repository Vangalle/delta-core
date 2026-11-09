use crate::AdapterResult;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{io::{Read, Write}, path::Path};
use tokio::sync::mpsc;

pub enum TerminalEvent { Output(Vec<u8>), Exited }

pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Terminal {
    pub fn spawn(cwd: &Path, shell: &str) -> AdapterResult<(Self, mpsc::Receiver<TerminalEvent>)> {
        let pair = native_pty_system().openpty(PtySize { rows: 12, cols: 100, pixel_width: 0, pixel_height: 0 })?;
        let mut command = CommandBuilder::new(shell);
        command.arg("-i");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("HISTFILE", "/dev/null");
        let mut child = pair.slave.spawn_command(command)?;
        let killer = child.clone_killer();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (tx, rx) = mpsc::channel(64);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => if tx.blocking_send(TerminalEvent::Output(buf[..n].to_vec())).is_err() { break; },
                }
            }
            let _ = child.wait();
            let _ = tx.blocking_send(TerminalEvent::Exited);
        });
        Ok((Self { master: pair.master, writer, killer }, rx))
    }

    pub fn input(&mut self, data: &str) -> AdapterResult<()> {
        self.writer.write_all(data.as_bytes())?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AdapterResult<()> {
        self.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn close(&mut self) -> AdapterResult<()> { self.killer.kill()?; Ok(()) }
}

impl Drop for Terminal {
    fn drop(&mut self) { let _ = self.killer.kill(); }
}
