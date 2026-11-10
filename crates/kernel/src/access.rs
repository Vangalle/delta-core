use crate::KernelError;
use delta_protocol::{Member, Role, WorkspaceAccess};
pub fn member_role_change(
    actor: &Member,
    access: WorkspaceAccess,
    target: &Member,
    current: Role,
    requested: Role,
) -> Result<Role, KernelError> {
    if access.role != Role::Owner {
        return Err(KernelError::Forbidden);
    }
    if current == Role::Owner || requested == Role::Owner {
        return Err(KernelError::Invalid);
    }
    if requested == Role::Executor && !target.role.can_execute() {
        if actor.role != Role::Owner {
            return Err(KernelError::Forbidden);
        }
        return Ok(Role::Executor);
    }
    Ok(target.role)
}
pub fn workspace_access(account: &Member, role: Role) -> WorkspaceAccess {
    WorkspaceAccess {
        role,
        can_execute: account.role.can_execute() && role.can_execute(),
    }
}
