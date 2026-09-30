# PRD: System-Wide Writing Assistant Widget

| | |
|---|---|
| **Doc status** | Draft v1.0 |
| **Owner** | [you] |
| **Last updated** | 2026-07-21 |
| **Target dev approach** | Spec-driven development — each functional requirement below has a stable ID (FR-x) intended to map 1:1 to an implementation spec/PR |

---

## 1. Problem Statement

Knowledge workers write constantly — emails, chat messages, docs, code comments — and frequently second-guess tone, clarity, and confidence in what they've written. Today this friction is solved by either:
- Manually rereading and editing (slow, unreliable self-assessment), or
- Copy-pasting into a browser tool (ChatGPT, Grammarly web) and back — a context switch that breaks flow and discourages use.

There is no tool that improves text **in place, system-wide, in any desktop application**, with explicit tone control and a persistent feedback loop that helps the user actually improve over time (not just patches this one sentence).

## 2. Goals

- **G1**: Let a user select text in *any* desktop application and get an improved rewrite without leaving that application.
- **G2**: Let the user explicitly control tone (confident, professional, friendly, concise, custom) rather than receiving a one-size-fix.
- **G3**: Build a feedback dataset from accept/reject/edit behavior that surfaces recurring writing patterns back to the user ("learn from mistakes").
- **G4**: Validate locally first; architect so the same core can be deployed org-wide with centralized auth, logging, and admin controls without a rewrite.

## 3. Non-Goals (v1)

- **NG1**: Inline diff-highlighting *inside* the original app's text field (requires Accessibility API integration — deferred to v2, see §10).
- **NG2**: Mobile support.
- **NG3**: Custom fine-tuned/local model — v1 uses a hosted LLM via API.
- **NG4**: Multi-language support — v1 is English-only.
- **NG5**: Real-time as-you-type suggestions (Grammarly-style underlines) — v1 is trigger-based (hotkey), not continuous.

## 4. Target Users & Personas

| Persona | Context | Primary need |
|---|---|---|
| Non-native English professional | Writes emails/Slack daily, unsure about tone/grammar | Confidence, correctness |
| Manager/exec | High volume of written comms, wants efficient tone control | Speed, tone precision (assertive vs diplomatic) |
| IC engineer | Writes PR descriptions, Slack updates, docs | Concise, clear technical writing |

## 5. Success Metrics

| Metric | Target (local POC) | Target (org, 90 days post-rollout) |
|---|---|---|
| Hotkey → suggestion latency | < 2.5s p50 | < 2.5s p50 |
| Suggestion accept rate | ≥ 40% (directional signal, not gate) | ≥ 50% |
| Daily active triggers per user | N/A (self-testing) | ≥ 3/day among adopters |
| Clipboard-restore failure rate | 0 observed in manual testing | < 0.1% of sessions |
| Crash-free session rate | N/A | ≥ 99.5% |

## 6. Scope Phasing

- **Phase 1 — Local POC** (this PRD's primary scope): single-user, runs on your machine, local backend, manual LLM API key, clipboard-based capture strategy, no auth.
- **Phase 2 — Org pilot**: centralized backend proxy, SSO, per-app blocklist, admin dashboard, signed installers, feedback data aggregated centrally.
- **Phase 3 — Accessibility API upgrade**: inline diff-highlighting for priority apps (Outlook, Word), on top of Phase 1/2 foundation.

This PRD specifies **Phase 1** in full detail and **Phase 2/3** at a scope-boundary level only (see §10).

---

## 7. User Flows

### 7.1 Primary flow: Improve selected text
1. User selects text in any app.
2. User presses global hotkey.
3. Widget appears near cursor, showing captured text.
4. System proposes a default tone (last-used) with tone chips visible for override.
5. Rewrite streams into the widget.
6. User accepts (→ paste-back into original app), edits inline, regenerates with a different tone, or dismisses.
7. Interaction is logged.

### 7.2 Secondary flow: No text selected
1. User presses hotkey with no active selection.
2. Widget shows an empty/error state: "No text selected — select something first," auto-dismisses after a few seconds or on click-away.

### 7.3 Secondary flow: Backend/LLM unreachable
1. Capture succeeds, LLM call fails (timeout/network/auth error).
2. Widget shows an inline error state with a **Retry** action; original clipboard remains untouched; no partial paste ever occurs.

---

## 8. Functional Requirements

Each FR is scoped to be an independent implementation spec.

### FR-1: Global Hotkey Registration
- System registers a configurable global hotkey (default `Ctrl+Shift+G` / `Cmd+Shift+G`) at OS level, active regardless of focused application.
- **Acceptance criteria**:
  - Hotkey fires the capture flow from at least: a browser, a native email client, a chat app (Slack/Teams desktop), a code editor, and a plain text editor.
  - Hotkey conflict with another running app is detected and surfaced to the user (not silently swallowed).

### FR-2: Text Capture (clipboard strategy)
- On hotkey trigger, system captures the currently selected text via simulated copy, without permanently altering the user's clipboard.
- **Acceptance criteria**:
  - Original clipboard content (text) is restored within 300ms of capture completing, in ≥ 99% of manual trials.
  - If no text is selected, system detects this (empty/unchanged clipboard) and shows the "no selection" state (FR flow 7.2) rather than sending empty text to the LLM.
  - Non-text clipboard content (e.g. copied image) prior to capture is preserved and restored correctly.

### FR-3: Widget Window Behavior
- Floating window is transparent-background, undecorated, always-on-top, and positioned adjacent to the cursor at time of trigger.
- **Acceptance criteria**:
  - Widget never renders off-screen (clamp position to visible display bounds).
  - Widget does not steal focus from the field the user was typing in until the user interacts with the widget itself.
  - Widget dismisses on: explicit dismiss click, click-outside, or `Esc` key.

### FR-4: Tone Selection
- User can choose from a fixed set of tone presets: Confident, Professional, Friendly, Concise. Custom tone (free text) is a stretch goal for v1, required by v2.
- **Acceptance criteria**:
  - Default tone on open = last tone used by this user (persisted locally).
  - Switching tone after a suggestion is already shown triggers a new rewrite request without requiring re-capture of the original text.

### FR-5: LLM Rewrite Request
- Selected text + tone instruction is sent to a local backend service, which constructs the prompt and calls the LLM provider.
- **Acceptance criteria**:
  - API key is never present in client-side (Tauri/JS) code or logs.
  - Backend returns only the rewritten text (no commentary/preamble) — enforced via prompt instructions and response validation on the backend.
  - Requests timeout and surface a retryable error state after 10s with no response.

### FR-6: Accept & Paste-Back
- On accept, the improved text is written into the originally focused field, replacing the original selection.
- **Acceptance criteria**:
  - Paste-back uses the same save/restore clipboard pattern as FR-2.
  - If paste-back fails (e.g., field no longer focused/exists), the improved text remains available in the widget and clipboard so the user can paste manually — never silently lost.

### FR-7: Interaction Logging (feedback dataset seed)
- Every capture → suggestion → resolution (accepted / edited / dismissed / regenerated) is logged locally.
- **Acceptance criteria**:
  - Log schema (see §9) captures: timestamp, tone requested, original text, suggested text, final accepted text (if edited), resolution type, source app name (best-effort).
  - Logging failures never block or delay the core rewrite flow (fire-and-forget / async write).
  - Local log is stored in a structured, queryable format (SQLite) from day one, not flat text.

### FR-8: Error & Edge-Case Handling
- **Acceptance criteria**:
  - No text selected → FR flow 7.2.
  - Backend unreachable → FR flow 7.3, with Retry.
  - Text exceeds a defined max length (e.g. 3000 chars) → truncation warning shown before sending, not a silent failure.
  - Rapid double-trigger of hotkey while a request is in-flight → second trigger cancels/restarts the first (defined behavior, not a race condition left to chance).

---

## 9. Data Model (local log, Phase 1)

```
Table: interactions
- id            INTEGER PRIMARY KEY
- ts            INTEGER (unix ms)
- app_context   TEXT (best-effort focused app name, nullable)
- tone          TEXT
- original_text TEXT
- suggested_text TEXT
- final_text    TEXT (nullable — only set if user edited before accepting)
- resolution    TEXT ENUM('accepted','edited','dismissed','regenerated','error')
- latency_ms    INTEGER (capture → suggestion shown)
```

This schema is the direct input to the future "learn from mistakes" pattern view and any later fine-tuning/few-shot dataset — no schema changes should be needed to support that later work.

---

## 10. Explicitly Deferred (Phase 2/3 scope boundary)

Documented here so Phase 1 architecture doesn't foreclose these, without specifying their implementation:

- **Accessibility API integration** (AXUIElement / UI Automation) for inline highlighting — Phase 3.
- **Centralized backend, SSO auth, admin blocklist, signed installers** — Phase 2.
- **Custom/local model, fine-tuning on logged data** — Phase 3+, gated on log volume.
- **Cross-device sync of tone preferences / feedback history** — not scoped.

---

## 11. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Hotkey-to-widget-visible < 300ms; capture-to-suggestion < 2.5s p50 |
| Privacy | Raw text never persisted server-side beyond request lifecycle in Phase 1 (no backend text storage — logging is local-only); Phase 2 must define retention policy explicitly before rollout |
| Reliability | Clipboard save/restore must not lose user data under any code path, including crashes mid-operation (restore-on-panic where feasible) |
| Compatibility | macOS 13+ and Windows 11 for Phase 1 testing |
| Resource usage | Idle memory footprint < 50MB while resident in tray |

## 12. Open Questions

- Should Custom tone (free-text tone description) be in v1 or deferred? (Currently deferred per FR-4.)
- What's the max acceptable clipboard "flicker" risk we're comfortable with before prioritizing the Accessibility API path?
- Do we need per-app default tone memory in Phase 1, or is global last-used-tone sufficient to validate the concept?
- What's the actual org policy on sending employee-written text to a third-party LLM API — needs legal/security sign-off before Phase 2, should be raised early not late.

## 13. Milestones (Phase 1)

| Milestone | Scope |
|---|---|
| M1 | FR-1, FR-2 validated in isolation (hotkey + capture/restore, no UI) |
| M2 | FR-3 widget shell renders and positions correctly |
| M3 | FR-4, FR-5 tone selection + LLM rewrite end-to-end |
| M4 | FR-6 paste-back working reliably across target apps |
| M5 | FR-7 logging wired to SQLite |
| M6 | FR-8 edge cases handled; informal dogfood period before org pilot scoping begins |
