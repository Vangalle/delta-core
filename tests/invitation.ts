import { DeltaClient, type InviteMember } from "@delta-core/client";
export async function inviteMember(
  client: DeltaClient,
  workspace: string,
  body: InviteMember,
) {
  const invitation = await client.invite(workspace, body);
  const base =
    process.env.DELTA_LIVE === "1"
      ? "http://127.0.0.1:47834"
      : "http://127.0.0.1:47832";
  const accepted = await new DeltaClient(base, "").acceptInvitation({
    token: invitation.token,
    name: body.name,
  });
  if (!accepted.login_token)
    throw new Error("A new claimant did not receive its own credential");
  return { member: accepted.member, token: accepted.login_token };
}
