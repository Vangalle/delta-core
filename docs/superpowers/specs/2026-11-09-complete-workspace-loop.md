# Complete the actual workspace loop

## User-required outcome

The previous slice was not an accepted product closure: a handshake and protocol fixtures do not verify a real Pi tool task, and static text is not rich-document or Mermaid editing. The user explicitly requires those working paths, plus Escape from an inline terminal back into the document without terminating execution.

This follow-up supersedes the earlier first-slice exclusions for rich text, Mermaid, real inference verification and Pi extension-dialog replies. It preserves the Rust core / independent TS SDK / replaceable browser layer boundary and publication-based draft privacy.

## Implemented path

The layer uses a real contenteditable Tiptap editor with headings, bold/italic, lists, quotes, links, tables and code. Markdown is the loss-minimizing wire/storage representation, not a replacement textarea passed off as rich editing. Source mode is available explicitly. Mermaid code blocks have editable source and an inline SVG preview; published content and authoritative agent results render Markdown and Mermaid. Invalid diagrams retain editable source and show a local error; HTML/SVG sanitization and bounded strict Mermaid rendering prevent active markup and embedded configuration.

A completed agent result can be opened as a private rich document draft. Publication inserts the human revision after the execution record; it never rewrites authoritative tool results or another client's unsent draft. Editor undo state is reset at workspace boundaries so a delayed undo cannot import a different workspace's private draft.

Pi's actual installed extensions exposed an interaction blocker: the model-collaboration extension waited for a confirmation. The adapter now normalizes confirm/select/input/editor requests into backend-neutral interaction events; only the session controller with execution permission can answer. Private reply values go to the backend, while only a resolution marker enters shared history. The live test explicitly declines model collaboration; no planner/worker/reviewer assignment is accepted in the tested Pi session. Terminal-title spinner updates are ignored and remaining backend diagnostics are collapsed into one disclosure, rather than flooding the document.

Escape is consumed by the inline terminal and returns focus to the document insertion point after that terminal. It does not send an escape byte to the shell, close the PTY, or interrupt a command.

## Evidence and limits

`npm run test:live` is an explicitly opt-in real-model test, separate from repeatable fixture tests. It starts the real Rust host and installed `pi`, creates one synthetic file with a fresh nonce absent from the prompt, and drives two real browser clients. Pi reads that file with its real `read` tool; the observer opens and closes the real result; the generated rich Markdown and Mermaid render; the author privately edits the generated Mermaid and publishes; the observer reloads and sees both the original execution result and human revision.

Latest completed run: selected `openai-codex/gpt-6-sol`, one real `read` tool call, 14,798 ms from user execution to checked publication/replay path. Evidence is bounded to this configured provider and task, not universal backend compatibility or a performance benchmark. Raw acceptance artifacts are in the ignored `.superpowers/acceptance` directory. The regular suite remains fixture-based only for Pi transport/lifecycle cases; real PTY, rich editor, publication, authorization and browser rendering use actual components.

## Delivery review and corrections

The independent read-only review accepted the real inference/tool/edit/publication/replay evidence and the Escape behavior, but found a private-preview image request leak and source-mode toolbar edits that could be discarded. Both were reproduced before changes. The host now uses a data-only image CSP, blocking Mermaid's native image prefetch before unpublished URLs reach the host; the browser request-spy regression verifies zero same-origin requests and successful recovery to an ordinary diagram. Rich formatting controls are disabled while editing Markdown source and reenabled on returning to rich mode. Both new tests passed RED→GREEN; the complete final regular suite is 28 Rust, 3 SDK and 18 browser tests, with the separately executed real inference acceptance also passing. No review findings remain open.

Non-goals remain sandboxing, untrusted public multi-tenant hosting, distributed execution and full desktop packaging. The production build warns about large lazy Mermaid/editor chunks; functionality and typechecking pass, but bundle optimization is not measured here.
