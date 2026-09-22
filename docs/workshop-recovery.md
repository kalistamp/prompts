# Workshop session recovery

Apply `docs/workshop-recovery.sql` to the existing Supabase `prompts` schema before deploying the frontend. The migration adds an owner-protected sessions table and an atomic compare-and-swap RPC. It does not change prompt items, run receipts, or retention behavior. Without the migration, local recovery works, but Workshop reports cloud unavailable and cannot sync sessions.

## Why work disappeared

`state.thread`, the composer textarea, the selected meta-prompt, and in-flight output were held in memory. History stored a separate receipt after each API call. Those rows did not contain the assembled system prompt, the full message list, unsent changes, or settings. Refreshing or iOS discarding the page destroyed the working state. A failed History write could also leave a completed answer without a durable receipt.

## What is saved

Each session snapshot contains the unsent composer text and selection, the selected meta-prompt snapshot, assembled system message and conversation turns, generated answers, available run receipts, retry request snapshots, provider/model choices, effort, max tokens, output mode, preview state, and the current request plus partial output. Provider API keys are never included in these snapshots; existing credential storage remains responsible for keys.

The composer saves after a 250 ms pause. A one-second checkpoint covers continuous typing, settings changes and streaming output. Sending, finishing, clearing and opening another session checkpoint immediately. `pagehide` and `visibilitychange` checkpoint synchronously to localStorage; recovery does not depend on unload handlers or a network request completing during iOS suspension. Unchanged snapshots do not cause writes. Cloud sync is attempted every ten seconds, on returning to the page and on reconnect.

Local records are scoped to the signed-in account and tab. Old pending local records are offered for recovery; recovering one adopts its pending upload. They are not silently applied over the current composer. Clear ends the working conversation while keeping its last snapshot in history. Session records are separate from Library and run receipts, so resuming does not create another prompt or receipt. Repeated autosaves update the same session.

## Resume, duplicate and view

Workshop displays a recovery button when previous work exists. History lists conversations and drafts above the existing API receipts. Resume opens the complete saved state for editing and keeps its session identity. Opening another conversation first preserves the current draft and confirms the switch. A newer local version takes precedence over its cached cloud base.

Duplicate creates an independent session. From a run receipt it truncates the saved conversation at that turn; from a session it copies that session's current working state. View history only opens a read-only transcript and never changes the active Workshop state.

New run receipts link to their session through saved turn receipts. Pre-feature receipts cannot be exactly resumed: their missing context was never recorded. Their Duplicate action starts a fresh draft from the output (or input on failure), using the existing meta-prompt when available. A deleted meta-prompt does not prevent resuming a new-format session because its snapshot is preserved.

## Cross-device and conflict behavior

Cloud sync uses the existing authenticated Supabase account. A device only updates the server version it actually read. Retrying a request whose response was lost is idempotent, including when more local edits arrive before acknowledgement. A concurrent edit creates a clearly labeled recovery copy and preserves the original server conversation. Both appear in History; the system does not merge prompt text automatically or overwrite the active editor when a cloud pull arrives.

Network errors leave local pending work intact and retry later. A refreshed page offers its local pending drafts for recovery. Work saved only on an offline device becomes available elsewhere after that device reconnects and syncs (recover its pending draft after a restart). Signing out stops session writes and hides the workspace; local recovery records remain scoped to that account for later sign-in.

## Limits and verification

A browser killed before the next checkpoint may lose the latest fraction of a second to roughly one second. Clearing browser storage, private-mode cleanup, storage eviction, or exhausting quota can remove/prevent local saves; the interface reports write failures. Work that never reached cloud cannot be recovered on another device. Interrupted provider requests are not automatically resent: partial output is shown as interrupted, excluded from future model context, and includes Retry. A model request may still finish or incur charges at the provider after the browser disappears.

Session retention is intentionally independent of receipt cleanup, with no automatic deletion. Large or numerous conversations may eventually require an archive/delete feature or IndexedDB storage. Cross-device pulls currently page through all session snapshots. Actual cloud migration/RLS validation and physical iPhone lifecycle testing require the deployed environment.

Run `node --test tests/cloud.test.mjs tests/markdown.test.js tests/workshop.test.mjs` for persistence, conflict, gateway and regression checks. `tests/workshop-browser.cjs` uses Playwright with an isolated mock backend to exercise refresh, continuation context, interrupted streaming and responsive layout; set `PLAYWRIGHT_PATH` if Playwright is installed outside this project.
