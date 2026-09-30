<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // ── Config ──────────────────────────────────────────────────────────────────
  const LOCAL_BACKEND_URL = "http://127.0.0.1:8090";
  const TONES = ["Confident", "Professional", "Friendly", "Concise"] as const;
  type Tone = (typeof TONES)[number];
  type Mode = "rewrite" | "generate";

  // ── State ───────────────────────────────────────────────────────────────────
  type UIState =
    | { kind: "idle" }
    | { kind: "no_selection"; reason: "empty" | "permission" }
    | { kind: "working"; text: string; mode: Mode }
    | { kind: "done"; original: string; suggestion: string }
    | { kind: "error"; original: string; message: string };

  let uiState = $state<UIState>({ kind: "idle" });
  let tone = $state<Tone>("Professional");
  let generateEnabled = $state(false);
  let editedSuggestion = $state("");
  let startTs = 0;
  let abortCtrl: AbortController | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;

  let draft = $state("");
  let hotkey = $state(
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "Cmd+Shift+G" : "Ctrl+Shift+G",
  );
  let unlisten: (() => void) | null = null;

  /** Local backend, or the hosted one + access key (asked per call: the key can change in setup). */
  async function backend(): Promise<{ url: string; headers: Record<string, string> }> {
    const cfg = await window.electronAPI?.getBackendConfig?.().catch(() => null);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg?.accessKey) headers.Authorization = `Bearer ${cfg.accessKey}`;
    return { url: cfg?.url || LOCAL_BACKEND_URL, headers };
  }

  function looksLikePrompt(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (t.endsWith("?")) return true;
    if (
      /^(write|draft|compose|generate|create|make|expand|summarize|reply\s+to|respond\s+to|email\s+(about|to)|can\s+you|could\s+you|please\s+(write|draft|help))\b/i.test(
        t,
      )
    ) {
      return true;
    }
    const bullets = t.match(/^[\s]*([-*•]|\d+[.)])\s+/gm);
    return (bullets?.length ?? 0) >= 2;
  }

  /** Strip markdown / HTML / URLs before paste-back (defense in depth). */
  function stripToPlainText(text: string): string {
    let out = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi, "");
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
    return out.trim();
  }

  function formatApiDetail(detail: unknown): string {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join("; ");
    }
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    return "Request failed";
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(() => {
    const api = window.electronAPI;
    if (!api) {
      document.addEventListener("keydown", onKey);
      return;
    }

    // Register before any await so hotkey payloads are never dropped.
    unlisten = api.onStateChange((payload) => {
      clearAuto();
      if (payload.hotkey) hotkey = payload.hotkey;
      if (payload.type === "no_selection") {
        const reason = payload.reason === "permission" ? "permission" : "empty";
        uiState = { kind: "no_selection", reason };
        generateEnabled = false;
        autoTimer = setTimeout(dismiss, reason === "permission" ? 10000 : 2500);
      } else if (payload.type === "compose") {
        uiState = { kind: "idle" };
        generateEnabled = looksLikePrompt(draft);
      } else if (payload.type === "ready" && payload.text) {
        const text = payload.text;
        draft = text;
        generateEnabled = looksLikePrompt(text); // unlock immediately for drafts like "Compose an email…"
        startTs = Date.now();
        // Always rewrite first; LLM may further confirm Generate.
        runMode(text, tone, "rewrite");
      }
    });

    void api.widgetUiReady?.().catch(() => {});
    void api.getLastTone().then((saved) => {
      if ((TONES as readonly string[]).includes(saved)) tone = saved as Tone;
    }).catch(() => {});

    document.addEventListener("keydown", onKey);
  });

  onDestroy(() => {
    unlisten?.();
    document.removeEventListener("keydown", onKey);
    clearAuto();
  });

  // ── Event handlers ───────────────────────────────────────────────────────────
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  }

  function clearAuto() {
    if (autoTimer !== null) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  }

  function activeOriginal(): string | null {
    const s = uiState;
    if (s.kind === "done" || s.kind === "error") return s.original;
    if (s.kind === "working") return s.text;
    return draft.trim() || null;
  }

  // ── Core actions ─────────────────────────────────────────────────────────────
  async function runMode(text: string, t: Tone, m: Mode) {
    abortCtrl?.abort();
    abortCtrl = new AbortController();
    uiState = { kind: "working", text, mode: m };

    const path = m === "generate" ? "/generate" : "/rewrite";

    try {
      const { url, headers } = await backend();
      const res = await fetch(`${url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, tone: t }),
        signal: abortCtrl.signal,
      });

      if (res.status === 401) {
        throw new Error("Access key invalid — open WriteUp setup from the tray icon.");
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Request failed" }));
        throw new Error(formatApiDetail(err.detail) || `${m === "generate" ? "Generate" : "Rewrite"} failed`);
      }

      const data = await res.json();
      const suggestion = stripToPlainText(data.suggestion ?? "");
      if (!suggestion) {
        throw new Error("The model returned empty text. Please retry.");
      }
      if (m === "rewrite" && typeof data.allows_generate === "boolean") {
        generateEnabled = data.allows_generate;
      }
      editedSuggestion = suggestion;
      uiState = { kind: "done", original: text, suggestion };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg =
        err instanceof Error
          ? err.message === "Failed to fetch"
            ? "Cannot reach the WriteUp server. Check your connection or wait for setup to finish, then retry."
            : err.message
          : "Backend unreachable. Is WriteUp finished setting up?";
      uiState = { kind: "error", original: text, message: msg };
    }
  }

  function clickRewrite() {
    const orig = activeOriginal();
    if (!orig) return;
    if (uiState.kind === "done") {
      logInteraction(uiState.original, uiState.suggestion, null, "regenerated");
    }
    startTs = Date.now();
    runMode(orig, tone, "rewrite");
  }

  function clickGenerate() {
    if (!generateEnabled) return;
    const orig = activeOriginal();
    if (!orig) return;
    if (uiState.kind === "done") {
      logInteraction(uiState.original, uiState.suggestion, null, "regenerated");
    }
    startTs = Date.now();
    runMode(orig, tone, "generate");
  }

  async function accept() {
    if (uiState.kind !== "done") return;
    const { original, suggestion } = uiState;
    const final = stripToPlainText(editedSuggestion);
    const resolution = final !== suggestion ? "edited" : "accepted";
    logInteraction(original, suggestion, final !== suggestion ? final : null, resolution);
    try {
      if (window.electronAPI?.pasteBack) {
        await window.electronAPI.pasteBack(final);
      } else {
        await navigator.clipboard.writeText(final);
      }
    } catch {
      // text remains in the suggestion box
    }
    uiState = { kind: "idle" };
    generateEnabled = false;
  }

  async function changeTone(t: Tone) {
    if (t === tone) return;
    tone = t;
    window.electronAPI?.setLastTone(t);
    const orig = activeOriginal();
    if (!orig || uiState.kind === "idle" || uiState.kind === "no_selection") return;
    if (uiState.kind === "done") {
      logInteraction(uiState.original, uiState.suggestion, null, "regenerated");
    }
    const mode = uiState.kind === "working" ? uiState.mode : "rewrite";
    runMode(orig, t, mode);
  }

  async function dismiss() {
    clearAuto();
    const s = uiState;
    if (s.kind === "done") logInteraction(s.original, s.suggestion, null, "dismissed");
    uiState = { kind: "idle" };
    generateEnabled = false;
    abortCtrl?.abort();
    await window.electronAPI?.dismissWidget?.().catch(() => {});
  }

  function logInteraction(
    originalText: string,
    suggestedText: string,
    finalText: string | null,
    resolution: string,
  ) {
    const body = JSON.stringify({
      tone,
      original_text: originalText,
      suggested_text: suggestedText,
      final_text: finalText,
      resolution,
      latency_ms: Date.now() - startTs,
      app_context: generateEnabled ? "rewrite+generate" : "rewrite",
    });
    void backend()
      .then(({ url, headers }) => fetch(`${url}/log`, { method: "POST", headers, body }))
      .catch(() => {});
  }

  const workingLabel = $derived(
    uiState.kind === "working" && uiState.mode === "generate"
      ? `Generating as ${tone}…`
      : `Rewriting as ${tone}…`,
  );

  const showActions = $derived(
    uiState.kind === "idle" ||
      uiState.kind === "working" ||
      uiState.kind === "done" ||
      uiState.kind === "error" ||
      uiState.kind === "no_selection",
  );

  function fitWindow() {
    const api = window.electronAPI;
    if (!api?.resizeWidget) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(".widget") as HTMLElement | null;
      if (!el) return;
      const h = Math.ceil(el.getBoundingClientRect().height);
      void api.resizeWidget({ width: 440, height: Math.max(280, Math.min(h + 4, 680)) });
    });
  }

  $effect(() => {
    // Track UI changes so the Electron window hugs content (no empty slab).
    void uiState.kind;
    void editedSuggestion;
    void generateEnabled;
    fitWindow();
  });

  async function minimize() {
    await window.electronAPI?.minimizeWidget?.().catch(() => {});
  }
</script>

<!-- ── Markup ──────────────────────────────────────────────────────────────── -->
<div class="widget">
  <div class="header">
    <span class="logo">✍ WriteUp</span>
    <div class="header-actions">
      <button type="button" class="win-btn" onclick={minimize} title="Minimize to tray">─</button>
      <button type="button" class="win-btn close-btn" onclick={dismiss} title="Dismiss (Esc)">✕</button>
    </div>
  </div>

  <div class="body">
    {#if uiState.kind !== "no_selection"}
      <div class="tone-bar">
        {#each TONES as t}
          <button
            type="button"
            class="tone-chip"
            class:active={tone === t}
            onclick={() => changeTone(t)}
          >{t}</button>
        {/each}
      </div>
    {/if}

    {#if uiState.kind === "no_selection" && uiState.reason === "permission"}
      <div class="state-msg">
        <span class="icon">🔒</span>
        <p>WriteUp needs permission to copy your selection.</p>
        <p class="sub">
          System Settings → Privacy &amp; Security → turn WriteUp ON under
          <b>Accessibility</b> and under <b>Automation → System Events</b>.
          Then quit WriteUp from the menu bar and open it again.
        </p>
      </div>

    {:else if uiState.kind === "no_selection"}
      <div class="state-msg">
        <span class="icon">⚠️</span>
        <p>No text selected.</p>
        <p class="sub">Select some text in any app, then press <kbd>{hotkey}</kbd>.</p>
      </div>

    {:else if uiState.kind === "working"}
      <div class="original-label">Original</div>
      <div class="original-text">{uiState.text}</div>
      <div class="spinner-row">
        <span class="spinner"></span>
        <span class="spinner-label">{workingLabel}</span>
      </div>

    {:else if uiState.kind === "done"}
      <div class="original-label">Original</div>
      <div class="original-text">{uiState.original}</div>

      <div class="suggestion-label">Suggestion <span class="hint">(editable)</span></div>
      <textarea class="suggestion-box" bind:value={editedSuggestion} rows={5}></textarea>

    {:else if uiState.kind === "error"}
      <div class="state-msg error">
        <span class="icon">❌</span>
        <p class="error-text">{uiState.message}</p>
      </div>

    {:else}
      <div class="suggestion-label">Your text</div>
      <textarea
        class="suggestion-box"
        bind:value={draft}
        rows={6}
        placeholder="Paste text to rewrite, or a brief like: draft a leave email"
      ></textarea>
      <p class="sub">Or select text in another app and press <kbd>{hotkey}</kbd>.</p>
    {/if}

    {#if showActions && uiState.kind !== "no_selection"}
      <div class="actions mode-actions">
        <button
          type="button"
          class="btn primary"
          disabled={uiState.kind === "working" || (!activeOriginal() && uiState.kind === "idle")}
          onclick={() => {
            if (uiState.kind === "idle") {
              const text = draft.trim();
              if (!text) return;
              startTs = Date.now();
              runMode(text, tone, "rewrite");
              return;
            }
            clickRewrite();
          }}
        >Rewrite</button>
        <button
          type="button"
          class="btn generate"
          class:active={generateEnabled || (uiState.kind === "idle" && looksLikePrompt(draft))}
          disabled={
            uiState.kind === "working" ||
            !(generateEnabled || (uiState.kind === "idle" && looksLikePrompt(draft.trim())))
          }
          title={generateEnabled || (uiState.kind === "idle" && looksLikePrompt(draft))
            ? "Generate new plain-text content from this brief"
            : "Generate unlocks when the text is a question or draft request"}
          onclick={() => {
            if (uiState.kind === "idle") {
              const text = draft.trim();
              if (!text || !looksLikePrompt(text)) return;
              generateEnabled = true;
              startTs = Date.now();
              runMode(text, tone, "generate");
              return;
            }
            clickGenerate();
          }}
        >Generate</button>
        {#if uiState.kind === "done"}
          <button type="button" class="btn accept" onclick={accept}>Accept ✓</button>
          <button type="button" class="btn ghost" onclick={dismiss}>Dismiss</button>
        {:else if uiState.kind === "error"}
          <button type="button" class="btn secondary" onclick={clickRewrite}>↺ Retry</button>
          <button type="button" class="btn ghost" onclick={dismiss}>Dismiss</button>
        {/if}
      </div>
      {#if uiState.kind === "done" && !generateEnabled}
        <p class="sub hint-line">Generate is off — this looks like prose to rewrite, not a question or draft request.</p>
      {/if}
      {#if uiState.kind === "done" && generateEnabled}
        <p class="sub hint-line">Generate is available for this request.</p>
      {/if}
    {/if}
  </div>
</div>

<style lang="css">
  :global(html, body) {
    height: auto;
    margin: 0;
  }

  :global(*, *::before, *::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    background: #1c1c2e;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    user-select: none;
  }

  .widget {
    width: 440px;
    height: auto;
    background: #1c1c2e;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    box-shadow:
      0 24px 64px rgba(0, 0, 0, 0.55),
      0 4px 16px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #13132b;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    cursor: default;
    -webkit-app-region: drag;
    flex-shrink: 0;
  }

  .logo {
    font-size: 13px;
    font-weight: 600;
    color: #a78bfa;
    letter-spacing: 0.02em;
  }

  .header-actions {
    display: flex;
    gap: 2px;
    -webkit-app-region: no-drag;
  }

  .win-btn {
    background: none;
    border: none;
    color: #6b7280;
    font-size: 14px;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
    line-height: 1;
    transition: color 0.15s, background 0.15s;
  }
  .win-btn:hover {
    color: #e5e7eb;
    background: rgba(255, 255, 255, 0.08);
  }
  .win-btn.close-btn:hover {
    color: #f87171;
    background: rgba(248, 113, 113, 0.1);
  }

  .body {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .tone-bar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .tone-chip {
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid rgba(167, 139, 250, 0.3);
    background: transparent;
    color: #9ca3af;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .tone-chip:hover {
    border-color: #a78bfa;
    color: #a78bfa;
  }
  .tone-chip.active {
    background: #a78bfa;
    border-color: #a78bfa;
    color: #1c1c2e;
    font-weight: 600;
  }

  .original-label,
  .suggestion-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
  }
  .hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: #4b5563;
  }

  .original-text {
    font-size: 13px;
    color: #9ca3af;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 8px 10px;
    line-height: 1.5;
    max-height: 72px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .suggestion-box {
    width: 100%;
    background: rgba(167, 139, 250, 0.06);
    border: 1px solid rgba(167, 139, 250, 0.25);
    border-radius: 8px;
    padding: 8px 10px;
    color: #e5e7eb;
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
    min-height: 80px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
    user-select: text;
  }
  .suggestion-box:focus {
    border-color: #a78bfa;
  }

  .spinner-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 0;
  }
  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(167, 139, 250, 0.25);
    border-top-color: #a78bfa;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .spinner-label {
    font-size: 13px;
    color: #9ca3af;
  }

  .state-msg {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 20px 0;
    text-align: center;
  }
  .state-msg .icon {
    font-size: 28px;
  }
  .state-msg p {
    font-size: 14px;
    color: #d1d5db;
  }
  .state-msg .sub {
    font-size: 12px;
    color: #6b7280;
  }
  .error-text {
    font-size: 13px;
    color: #f87171 !important;
    max-width: 360px;
    line-height: 1.5;
  }

  kbd {
    font-size: 11px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    padding: 1px 5px;
    font-family: monospace;
    color: #d1d5db;
  }

  .actions {
    display: flex;
    gap: 8px;
    padding-top: 4px;
    flex-wrap: wrap;
    -webkit-app-region: no-drag;
  }

  .btn {
    padding: 7px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
    font-family: inherit;
  }
  .btn.primary {
    background: #a78bfa;
    color: #1c1c2e;
  }
  .btn.primary:hover:not(:disabled) {
    background: #c4b5fd;
  }
  .btn.generate {
    background: rgba(52, 211, 153, 0.12);
    color: #6ee7b7;
    border: 1px solid rgba(52, 211, 153, 0.35);
  }
  .btn.generate.active:not(:disabled) {
    background: rgba(52, 211, 153, 0.22);
    border-color: #34d399;
    color: #a7f3d0;
  }
  .btn.generate:hover:not(:disabled) {
    background: rgba(52, 211, 153, 0.28);
  }
  .btn.accept {
    background: #a78bfa;
    color: #1c1c2e;
  }
  .btn.accept:hover:not(:disabled) {
    background: #c4b5fd;
  }
  .btn.secondary {
    background: rgba(167, 139, 250, 0.15);
    color: #a78bfa;
    border: 1px solid rgba(167, 139, 250, 0.3);
  }
  .btn.secondary:hover:not(:disabled) {
    background: rgba(167, 139, 250, 0.25);
  }
  .btn.ghost {
    background: transparent;
    color: #6b7280;
  }
  .btn.ghost:hover:not(:disabled) {
    color: #9ca3af;
    background: rgba(255, 255, 255, 0.05);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .body > .sub,
  .hint-line {
    font-size: 12px;
    color: #6b7280;
    line-height: 1.5;
  }
</style>
