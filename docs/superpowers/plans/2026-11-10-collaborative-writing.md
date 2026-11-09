# Collaborative Writing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver inline mentions, unobtrusive Markdown/math editing, author avatars and server-authoritative workspace reply modes.

**Architecture:** Extend protocol/kernel with explicit participation, policy and message submission; preserve legacy document publication. The Host executes only kernel effects; the public SDK projects collaboration events. The browser composes focused editor, math, mention and identity modules.

**Tech Stack:** Rust / serde / pulldown-cmark; TypeScript / Tiptap 3.33 / KaTeX / Playwright.

**Spec:** docs/superpowers/specs/2026-11-10-collaborative-writing.md; conversational approval `yes` after sticky per-workspace mention-only policy.

## Global Constraints

- Preserve vision.md, private drafts, explicit publication and continuous editable document.
- Enter inserts newline; Cmd/Ctrl+Enter submits.
- Owner/Executor execution grants remain mandatory; default policy never grants permission.
- Second distinct participant defaults to mentions_only unless mode explicitly chosen; disconnection never changes it.
- No user Host restart, no GUI activation, no real inference in ordinary tests.
- Keep generated public SDK/schema synchronized and old journal events readable.

## Review Focus

- @agent inside fenced/inline code, a quote, formula, escaped text or an ordinary URL must not run code.
- Repeated joins/reconnects and multiple tabs must not count as distinct humans or undo a manual policy.
- Reply failures must not cause duplicate publication or a misleading retained private draft.
- Mention insertion mid-paragraph preserves both text sides, focus, private state and undo boundaries.
- Removing buttons must not remove Markdown/Mermaid/math editing or revive private rendering leaks.

### Task 1: Native collaboration and execution policy

**Files:** protocol/src/lib.rs; kernel/src/{lib.rs,collaboration.rs}; host/src/{service.rs,main.rs}; kernel/tests/collaboration.rs; host/tests/collaboration.rs; packages/client/src/{index.ts,generated.ts}; packages/client/schema.json.

**Interfaces:** ReplyMode auto|mentions_only; Collaboration {reply_mode, mode_explicit, participants}; JoinWorkspace; SetReplyMode {mode}; SubmitMessage {id,text,after,quotes,backend}; Change ParticipantJoined/ReplyModeChanged; Mention {kind,target,label}; Content.Agent.source_entry.

- [ ] Add JSON-driven kernel tests before DTOs exist, and run `cargo test -p delta-kernel --test collaboration` to observe unknown-command failures:
```rust
let command = serde_json::from_value(json!({"type":"join_workspace"})).unwrap();
let d = workspace.decide(&owner, command).unwrap();
for change in d.changes { workspace.apply(change); }
assert_eq!(workspace.collaboration.participants, vec!["owner"]);
```
- [ ] Implement typed events/state and parsing; test default auto, second distinct member, manual override, observer joins, no permission bypass, code/quote/math/URL non-triggers, replay and duplicate submission.
- [ ] Add a deterministic recording backend host test, failing first, verifying exactly one execution for auto/@agent; restart policy persistence; legacy publish remains non-executing.
- [ ] Implement Host source checks/default policy config and execution failure publication semantics. Generate contracts with `npm run generate`.
- [ ] Add SDK projection tests for collaboration events and optional legacy fields; run Rust tests + `npm test` + typecheck.

### Task 2: Flow-preserving editor and math

**Files:** apps/layer/src/{editor.ts,mentions.ts,math.ts,content.ts,presentation.ts}; styles/components/{editor.css,math.css}; apps/layer/package.json; tests/writing.spec.ts; existing richtext and draft-privacy tests.

**Interfaces:** RichEditor.setTrigger(text:string) replaces only trigger; `insertMention(kind,target,label)` inserts an inline node with Markdown serialization; Math extensions serialize canonical dollar delimiters; renderMath(root) processes sanitized Markdown without touching code.

- [ ] Add browser tests: no formatting toolbar; typing `## ` / `**bold**` / list prefixes transforms; pasted Markdown parses; users selection preserves paragraph and sends no request; source shortcut works.
```ts
await draft.pressSequentially('Hello @users');
await page.getByRole('button', { name:'Mention Editor' }).click();
await page.keyboard.type(' keep writing');
await expect(draft.locator('p')).toHaveCount(1);
```
- [ ] Observe intended failures, remove toolbar creation and button-only actions, keep unobtrusive source shortcut and Markdown input/paste handling. Implement user/agent inline nodes without inserting shared entries.
- [ ] Add failing math tests for editable draft, source roundtrip, shared observer, Agent Markdown, invalid expressions, code exclusions, hostile links/macros; install compatible Tiptap math/KaTeX dependencies only after red.
- [ ] Implement formula views and source editing; sanitize rendering, keep CSP/image protections; adapt legacy tests to typing/source shortcut rather than deleted buttons.

### Task 3: Workspace controls and author identity

**Files:** apps/layer/src/{main.ts,identity.ts,agent.ts}; apps/layer/index.html; styles/components/{document.css,agent.css}; tests/collaboration.spec.ts; tests/serve.mjs.

**Interfaces:** SDK.joinWorkspace / setReplyMode / submitMessage; existing commands retained. Per-entry identity gutter uses actual member ID/name, local generated avatar, Agent source role; global policy selector reflects snapshot/events and enforces edit permission.

- [ ] Add failing two-browser tests for sticky policy synchronization, explicit override, no draft inference, only @agent in shared mode, automatic reply, and lack of execution rights.
- [ ] Add failing avatar tests that distinguish authors and Agent, include reload and quote/source navigation with new wrapping.
- [ ] Implement join before snapshot, synchronize policy on events, use native message submit for composer only, attach inline mentions and source-linked Agent responses, render compact identity gutters without bubbles.
- [ ] Configure ordinary fixture host default mentions_only; dedicated native tests prove product auto default. Run all browser tests, including terminal quoting/Escape, source safety, conflicts and navigation races.

### Task 4: Delivery gate

- [ ] Run `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `npm run generate`, `npm test`, `npm run typecheck`, `npm run test:e2e`, production build.
- [ ] Use one fresh-context review-only reviewer over all changes; resolve concrete blockers with red/green regression evidence.
- [ ] Commit task changes, preserve running service, explain actual interaction and deployment prerequisite directly in chat. Do not assign documentation reading to the user.
