# Delta Core — approved product direction

## Outcome and boundaries

Build a Rust collaboration kernel for people and agents working in one clean, continuous, indefinitely extensible document-like workspace. This is not a chat transcript or a two-dimensional whiteboard. The experimental browser layer is replaceable; independent TypeScript clients use a versioned public protocol and a framework-free SDK.

The user's `vision.md` remains the source of product intent. The conversation confirms: document-first editing; inline `@terminal`; `@threads` references other workspaces; `@users` mentions people; Pi is the first full agent backend; structured tool activity supports layer-owned collapse/expand; other agent implementations have an open interface.

## Collaboration mechanism

Unsubmitted text is local private draft state. Explicit publication makes text visible to others. Executed terminal commands, agent activities and outputs are immediately shared. Publication is not an execution authorization or rollback boundary. Concurrent publications detect stale revisions rather than silently overwriting another person's changes.

One host owns execution for the workspace. The host may be the creator's computer; cloud deployment is not required. Multiple terminals and agent sessions may exist, each with an explicit controlling member. Observing a session grants no execution rights. Host-granted execution is arbitrary host-code execution, not a sandbox.

## First implementation

- A Rust protocol crate defines commands, snapshots and sequenced events and exports JSON Schema for generated TS types.
- A pure Rust domain crate owns published flow entries, revision checks and permission rules. It imports no HTTP, persistence, Pi or browser implementation.
- Rust adapters provide a durable SQLite event journal, real persistent PTY terminals and a long-lived Pi RPC adapter. A backend trait exposes structured events without requiring Pi-specific wire shapes from other backends.
- A Rust HTTP host composes the kernel and adapters, authenticates opaque capability tokens, exposes commands and resumable SSE, and serves a separately built experimental browser layer.
- The framework-independent TS SDK handles protocol commands, authenticated subscriptions, cursor-based reconnect and typed errors.
- The browser layer shows a continuous document with inline editable text, references, PTY terminals and agent output; tools use native details/summary disclosure. A separate minimal TS client verifies that SDK use does not import browser-layer internals.

## Security and operating constraints

Bind to loopback by default. Opening a listener to other machines is an explicit operator choice; remote use requires TLS through a trusted reverse proxy. Owner creates named member tokens, with editor or executor permissions. Tokens are never put in URLs. No unauthenticated read or execution endpoint. Validate resource ownership and payload limits. New browsers do not receive private drafts. Data and host credentials are ignored by Git.

Do not invoke model inference during automated verification. Pi protocol fixture tests are explicitly fixture-only. A real installed Pi handshake may test transport without prompting a model. Tests of terminal behavior use temporary directories and harmless commands. GUI verification runs headlessly and never activates windows or devices.

## Acceptance

1. Two authenticated clients see published text and streamed execution; an unpublished edit stays private.
2. Stale edits fail with a conflict and the local draft remains recoverable.
3. `@terminal` inserts a real, persistent shell, with sequential commands retaining shell state and output retained in the shared flow.
4. Pi tool starts, partial results and authoritative ends retain IDs and structure; a result can be folded/unfolded by the layer.
5. The public interface supports a non-Pi test backend, and the standalone TS example operates without importing layer code.
6. Events and published content survive host restart; old execution sessions are marked interrupted and never rerun automatically.
7. Unauthorized execution fails before process creation; terminal input is restricted to its controller.

## Explicit limits

The first implementation does not promise a sandbox, public multi-tenant hosting, automatic file merging, distributed execution, live draft synchronization, desktop packaging, or runtime process restoration after host restart. Workspace files on the same execution host remain shared and may conflict if multiple authorized sessions modify them. Reference and mention semantics do not imply push notifications. The browser layer is experimental, not a finished recreation of Delta.
