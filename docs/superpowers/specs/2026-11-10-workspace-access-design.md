# Workspace access and friends

## Approved outcome
Account identity is Host-wide; workspace membership/roles are independent. Workspace invitations grant only their selected workspace. Friends require reciprocal consent and grant no workspace access. An owner can add an accepted friend to a new workspace with one Add action, default Editor. Execution trust never increases from friendship or ordinary membership.

The user explicitly approved legacy migration: Host administrator owns old workspaces; preserve members with explicit participation or authorship, remove implicit access for other accounts. Preserve text, source identities, event history and credentials. No automatic restart or mutation of the running Host/data; exercise migration using isolated databases. API isolation is not an OS sandbox against trusted Host executors.

## Model and boundaries
- `Member.role` retains Host execution eligibility (Owner/Executor) and legacy account constraints. `WorkspaceAccess { role, can_execute }` expresses the intersection with workspace membership. Workspace ownership permits member management and recovery without granting Host execution.
- Kernel exposes scoped decisions; legacy unscoped decisions remain for pure existing tests. Host calls only scoped decisions after checking authoritative SQLite membership.
- Separate SQLite access tables: memberships, one-time expiring invitation hashes, canonical reciprocal friendships, migration marker. Adapter operations use transactions. Membership additions, collaboration events and invitation consumption commit atomically.
- Inviter receives an invitation capability, never another person's login token. Anonymous acceptance creates its own account credential, returned only to the claimant; authenticated acceptance retains identity and credential. Invitations last seven days and are consumed once. Executor invitations can originate only from the Host administrator. No Owner invitation/ownership transfer.
- New workspaces belong to their creator. No Host-admin API bypass for unrelated new workspaces. Legacy ownership fallback applies only once.

## Authorization
Lists, snapshots, event replay/live subscription, every command and source validation require workspace membership. `JoinWorkspace` records participation, never grants access. User mentions refer only to current members. Thread references require caller access; automatic Agent context includes referenced workspaces only if all current destination members also have source access. Explicit selected quotation snapshots may be shared by a caller who can access the source; navigation still requires separate access.

A new member makes the workspace shared immediately: seed its existing members into participation and retain the existing sticky/default policy semantics. Explicit policy remains untouched. No inference follows invitations, friend requests, acceptance or member additions.

## Migration
Before the first legacy access migration, create an SQLite-consistent backup beside the journal without overwriting existing backups. Transactionally populate memberships from Host Owners plus inserted authors/controllers, text editors, interaction prompt actors and participant events; ignore nonexistent accounts. Mark migration complete so later accounts/workspaces never receive legacy broad access. Existing data is never re-sorted automatically; chronological recovery remains the explicit Owner command delivered in d59eab5.

## Interfaces and UI
Workspace `/members` and `/invitations` replace the global member directory/invitation endpoint. Public invitation preview/accept support fresh browsers; acceptance is deliberate and preserves logged-in accounts. Friend endpoints provide only the caller's relationships, exact-ID requests and recipient-only acceptance. No global people search, federation, membership removal or automatic execution grants in this slice.

Standalone SDK owns transport and event projection. Browser uses workspace roster/access from snapshots, derives effective editing/execution role, moves Invite into workspace actions, supplies friend request/accept/list and Add to workspace, handles identities with zero accessible workspaces, and renders invitation acceptance. Private drafts remain keyed by account/workspace; no formatting/UI redesign.

## Acceptance
Real SQLite/HTTP tests cover cross-workspace list/snapshot/SSE/command/source denial, account-preserving one-time invitations, role ceilings, friend consent/no implicit access, atomic/durable membership and one-time backup/migration. Browser tests cover separate identities accepting scoped invitations, reciprocal friendship and adding into a fresh workspace, namespaced roles and persistent login/drafts. Existing Rust/SDK/browser suites pass without paid inference; final independent read-only review precedes delivery.
