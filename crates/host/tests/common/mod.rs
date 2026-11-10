use delta_host::Service;
use delta_protocol::*;
pub async fn invite(
    service: &Service,
    owner: &Member,
    workspace: &str,
    name: &str,
    role: Role,
) -> Invitation {
    let capability = service
        .create_invitation(
            owner,
            workspace,
            InviteMember {
                name: name.into(),
                role,
            },
        )
        .await
        .unwrap();
    let accepted = service
        .accept_invitation(
            None,
            AcceptInvitation {
                token: capability.token,
                name: name.into(),
            },
        )
        .await
        .unwrap();
    Invitation {
        member: accepted.member,
        token: accepted.login_token.unwrap(),
    }
}
