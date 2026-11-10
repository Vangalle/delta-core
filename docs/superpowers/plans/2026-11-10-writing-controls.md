# Writing Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Each task uses RED → GREEN → regression; no implementation delegation or obsolete routing.

**Goal:** Deliver safe Tab/inline thread editing, Light/Dark, existing-member execution permissions and experimental real Host terminal controls.
**Architecture:** Keep contracts and permissions in native code; UI consumes native capabilities and transports through independent SDK. Existing component CSS remains tuneable. Desktop launch is a separate disabled-by-default Host adapter, never simulated as real acceptance.
**Tech Stack:** Existing Rust, SQLite, Axum, TS SDK, Tiptap, xterm, token CSS, Playwright; no new product dependencies.
**Spec:** docs/superpowers/specs/2026-11-10-writing-controls-design.md

## Global Constraints
- Preserve vision.md, current layout, private drafts, credentials, prior events and replaceable backends.
- Tab completes only, never submits or executes. Keep browser/shift/modified Tab intact.
- Host execution is unsandboxed and never granted implicitly; existing-session takeover forbidden.
- No real desktop activation, microphone/speaker use or paid inference in tests.
- Do not restart running Host without separate authorization. Preserve unrelated untracked .pi/.

## Review Focus
- Completing @terminal with Tab must not create a PTY: Task 1 browser command-count assertion.
- Inline thread inside code/URL must not expand hidden context: Task 1 native parser + audience tests.
- Old eligibility cached before downgrade must not execute: Task 2 native stale actor regression.
- Theme change must not reset PTY output or private formula/source text: Task 3 browser preservation tests.
- Disabled desktop feature or untrusted browser command must never spawn OS apps: Task 4 real request denial + fake launcher argument boundary.

### Task 1: Private completion and native inline threads
Files: mentions.ts, editor.ts, main.ts; protocol lib.rs; kernel collaboration.rs; host service.rs; SDK schema/projection; tests/completion.spec.ts, native thread tests.
Interfaces: MentionKind::Thread, delta-thread Markdown link, RichEditor.insertMention('thread',id,label); private palette choices expose completion independently from executable action.
- [ ] Write browser tests and native JSON-based parser/auth tests; observe red.
```ts
await draft.fill('@ter'); await draft.press('Tab');
await expect(draft).toHaveText('@terminal');
expect((await client.snapshot(id)).entries).toHaveLength(0);
```
- [ ] Add native parsing/target validation/context, regenerate schema. Replace block thread insertion with private atom. Implement selected-candidate Tab completion, arrow navigation and dismiss-key handling without modifiers.
- [ ] Assert same paragraph/suffix, explicit publish, rich clipboard and reload; old block references still render. Run native/SDK/focused browser regressions.

### Task 2: Existing-member execution rights
Files: kernel access.rs; adapters access.rs; host service/access.rs and service.rs/http.rs; protocol Snapshot/self identity + MemberRoleChanged; SDK; people.ts/main.ts; native/browser role tests.
Interfaces: setMemberRole(workspace,memberId,role) -> Receipt; authenticated snapshot self_id + capabilities; member_role_changed event includes scoped Member and effective execution boolean. Kernel pure role-change validation; adapter transactional role/account/event update. Host reader abort handles shut down backend streams on scope downgrade.
- [ ] Write tests: Owner can explicitly grant existing Editor; non-owner/Host-untrusted Owner cannot mint execution; stale actor denied after downgrade; current controlled PTY/Agent interrupted.
```rust
assert_eq!(grant_as_editor.status(),StatusCode::FORBIDDEN);
assert!(!snapshot.access.unwrap().can_execute);
```
- [ ] Implement canonical eligibility checks, transactional events and execution cleanup. Add existing-member role selector with Host-trust confirmation; update self UI from event without dropping cached private text.
- [ ] Run all native + SDK tests; verify invitee terminal control appears after promotion and disappears after downgrade.

### Task 3: Local appearance
Files: new theme.ts; tokens.css and component token references; index/main UI; terminal.ts; Mermaid CSS; tests/theme.spec.ts.
Interfaces: theme preference Light/Dark in localStorage; theme change listeners for xterm options, CSS variables for SVG; listener disposal.
- [ ] Write missing theme selector/persistence and editor/PTY preservation tests, observe red.
- [ ] Preserve Dark values, add neutral green Light values, replace fixed surfaces with semantic tokens; add chooser and live terminal restyle without resize/output clear.
```ts
await page.getByRole('combobox',{name:'Theme'}).selectOption('light');
await expect(page.locator('html')).toHaveAttribute('data-theme','light');
```
- [ ] Verify both real renders with headless screenshots; check contrast, narrow layout and theme persistence.

### Task 4: Host shell and opt-in desktop terminal
Files: main.rs config; service terminal configuration/endpoint; adapters desktop_terminal.rs and terminal.rs; native tests; browser feature affordance.
Interfaces: Host shell setup honors DELTA_SHELL then SHELL; login configurable, library remains safe. DELTA_ENABLE_DESKTOP_TERMINAL default false; Host Owner explicit endpoint opens new desktop terminal only on supported Host, fixed cwd and no command payload.
- [ ] Write disabled/unauthorized endpoint tests before implementation, shell args tests using temporary HOME/stub programs; no real GUI process.
- [ ] Implement adapter and native capability advertisement + explicit experimental UI warning. Keep no output-sharing claim for external windows. Never invoke external opener during verification.
- [ ] Run fmt, Clippy, Rust, SDK, typecheck, browser, production build, audit and diff check. One final read-only delivery review, resolve blockers by RED/GREEN. Commit only task files, not .pi/ or private artifacts.
