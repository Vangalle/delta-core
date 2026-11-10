use delta_protocol::{Member, Role, WorkspaceAccess};
pub fn workspace_access(account: &Member, role: Role) -> WorkspaceAccess {
    WorkspaceAccess {
        role,
        can_execute: account.role.can_execute() && role.can_execute(),
    }
}
