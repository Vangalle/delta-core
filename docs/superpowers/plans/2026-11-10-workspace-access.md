# Workspace Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope invitation/access to one workspace and provide consent-based friends that owners can add with one action.
**Architecture:** Kernel computes scoped role/execution intersection. SQLite is authoritative for membership, invitation capabilities and reciprocal relationships; Host validates every entry point. SDK and browser consume native contracts.
**Tech Stack:** Existing Rust/SQLite/Axum, standalone TypeScript client, Tiptap browser, Playwright. No new dependencies or paid inference.
**Spec:** docs/superpowers/specs/2026-11-10-workspace-access-design.md

## Global Constraints
- Preserve vision.md, content, IDs, execution history and private drafts.
- Execution requires Host trust AND workspace rights; no grants from friendship or ordinary membership.
- Running user Host is not restarted; use isolated fixture Hosts/databases.
- Old workspace fallback and participation-based membership migration are explicitly approved.
- Current conversation executes implementation; no obsolete role/model routing.

## Review Focus
- A copied workspace ID, reference or SSE URL must not bypass membership: Task 1 HTTP denials.
- A scoped owner without Host execution must not mint an Executor: Task 1 role ceiling tests.
- Reusing an invitation or accepting while logged in must not impersonate someone: Task 2 tests.
- Reciprocal requests must not silently become consent: Task 2 recipient-only accept.
- A migrated dormant account may have no rooms; UI must remain usable: Task 3 empty state.

### Task 1: Native access and migration
**Files:** crates/protocol/src/lib.rs; crates/kernel/src/access.rs and lib.rs; crates/adapters/src/access.rs and journal.rs; crates/host/src/access.rs, service.rs and http.rs; crates/host/tests/access.rs; existing native tests.
**Interfaces:** `WorkspaceAccess { role: Role, can_execute: bool }`; `Workspace::decide_scoped(&Member, WorkspaceAccess, Command)`; actor-required `Service::{workspaces,members,snapshot,subscribe}`. Journal membership lookups return scoped Member records. Snapshot adds optional access/roster.
- [ ] Write real HTTP tests whose initial 200 cross-room visibility and global POST /members must become 404/405.
```rust
assert_eq!(get_as(peer, private_snapshot).status(), StatusCode::NOT_FOUND);
```
- [ ] Run `cargo test -p delta-host --test access`; confirm intended red behavior.
- [ ] Implement pure execution intersection, SQLite migration/backup and actor-required service entry points. Protect reference/quote/context paths, preserve explicit PublishText insertion.
```rust
let access = workspace_access(actor, scoped_role);
workspace.decide_scoped(actor, access, command)
```
- [ ] Prove one-time migration via a hand-built old SQLite journal with an active writer and dormant member, then reopening twice. Run all Rust tests and Clippy; update existing callsites with explicit actors rather than bypass helpers.

### Task 2: Invitation and friendship lifecycle
**Files:** same access modules; native DTO Contract; packages/client/src/index.ts, schema.json and generated.ts; packages/client/tests/client.test.ts; native access tests.
**Interfaces:** `create_invitation(actor, workspace, InviteMember) -> WorkspaceInvitation`; `accept_invitation(Option<&Member>, AcceptInvitation) -> AcceptedInvitation`; `friends(actor) -> Vec<Friend>`; `request_friend(actor, member_id)`; `accept_friend(actor, member_id)`; `add_friend(actor, workspace, AddFriend)`. SDK `invite(workspace,body)`, `acceptInvitation`, `friends`, `requestFriend`, `acceptFriend`, `addFriend`.
- [ ] Write HTTP tests for invitation preview, claim-once, anonymous credentials, authenticated identity preservation and forbidden Owner/Executor escalations; observe red missing routes.
```rust
assert_eq!(claim_twice.status(), StatusCode::NOT_FOUND);
assert_eq!(accepted_existing.member.id, original.id);
```
- [ ] Implement transactional claim plus member/collaboration events and hash-only secret storage. Disable global member creation/directory; regenerate contracts.
- [ ] Write and run red consent tests: outgoing self-accept forbidden, friendship alone cannot read the other room, only accepted friends can be added by its Owner.
```rust
assert_eq!(before_add.status(), StatusCode::NOT_FOUND);
assert_eq!(after_add.status(), StatusCode::OK);
```
- [ ] Implement canonical relationship persistence and scoped Add default Editor. Run native/SDK tests; update fixture invitations to use real create+claim utilities, not privileged production-only setup methods.

### Task 3: Usable client acceptance
**Files:** apps/layer/src/people.ts; main.ts; index.html; scoped component styles; tests/access.spec.ts; tests/invitation.ts; existing browser/live test callsites.
**Interfaces:** People dialog consumes SDK plus identity/current workspace callbacks; invitation landing accepts a capability and connects with returned or existing credential; workspace snapshots provide roster and access, not global directory.
- [ ] Write browser tests for fresh-browser invitation acceptance and denied unrelated room, reciprocal request/accept then one-click Add in a newly created workspace; first run must fail on absent UI/flows.
```ts
await page.getByRole('button', {name:'Accept invitation', exact:true}).click();
await expect(page.getByRole('navigation', {name:'Workspaces'})).not.toContainText('Unrelated');
```
- [ ] Implement invitation landing, scoped member/friend dialog and effective role UI. Handle zero-room accounts without indexing workspaces[0]. Keep existing document styling/private editing.
- [ ] Update old tests to create/claim actual scoped invites; record any intentional earlier shared-mode switch (membership rather than first opening).
- [ ] Run fmt, Clippy, Rust, SDK, typecheck, full browser, build, diff check. Final review-only gate, resolve blockers via red/green regressions, then checkpoint commit without push/restart.
