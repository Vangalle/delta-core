use crate::AdapterResult;
use std::path::Path;
use tokio::process::Command;
pub trait DesktopTerminalBackend: Send + Sync {
    fn command(&self, cwd: &Path) -> AdapterResult<Command>;
}
pub struct MacTerminal;
impl DesktopTerminalBackend for MacTerminal {
    fn command(&self, cwd: &Path) -> AdapterResult<Command> {
        if !cfg!(target_os = "macos") {
            return Err("Host desktop terminals are only available on macOS".into());
        }
        if !cwd.is_absolute() {
            return Err("desktop terminal directory must be absolute".into());
        }
        let script = "on run argv\nset targetDirectory to item 1 of argv\ntell application \"Terminal\"\ndo script (\"cd -- \" & quoted form of targetDirectory)\nend tell\nend run";
        let mut command = Command::new("/usr/bin/osascript");
        command.arg("-e").arg(script).arg(cwd);
        Ok(command)
    }
}
