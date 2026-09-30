"""
LLM integration — supports Ollama (via ngrok) or OpenRouter.

Set OLLAMA_BASE_URL to use a local/remote Ollama instance (e.g. an ngrok URL).
Otherwise OPENROUTER_API_KEY must be set to use OpenRouter.
"""

import os
from openai import AsyncOpenAI

from sanitize import strip_preamble, strip_to_plain_text

_client: AsyncOpenAI | None = None

# Maps tone name → plain-English description used in the prompt.
TONE_DESCRIPTIONS: dict[str, str] = {
    "Confident": "assertive, direct, and confident — remove hedging language",
    "Professional": "formal, professional, and polished",
    "Friendly": "warm, approachable, conversational, and friendly",
    "Concise": "concise and to the point — cut unnecessary words ruthlessly",
}

GENERATE_MAX_CHARS = 1200


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        ollama_url = os.environ.get("OLLAMA_BASE_URL", "").strip().rstrip("/")
        if ollama_url:
            # Ollama exposes an OpenAI-compatible endpoint at /v1
            _client = AsyncOpenAI(
                base_url=f"{ollama_url}/v1",
                api_key="ollama",  # Ollama ignores the key but the client requires one
            )
        else:
            api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
            if not api_key:
                raise RuntimeError(
                    "Set OLLAMA_BASE_URL (for Ollama) or OPENROUTER_API_KEY (for OpenRouter) "
                    "in backend/.env before starting the backend."
                )
            _client = AsyncOpenAI(
                base_url="https://openrouter.ai/api/v1",
                api_key=api_key,
                default_headers={
                    "HTTP-Referer": "https://github.com/writeup-assistant",
                    "X-Title": "WriteUp Assistant",
                },
            )
    return _client


def _model_name() -> str:
    ollama_url = os.environ.get("OLLAMA_BASE_URL", "").strip()
    if ollama_url:
        return os.environ.get("OLLAMA_MODEL", "qwen3")
    return os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")


def _clean_model_text(raw: str) -> str:
    result = strip_preamble((raw or "").strip())
    if result.startswith('"') and result.endswith('"'):
        result = result[1:-1].strip()
    if result.startswith("'") and result.endswith("'"):
        result = result[1:-1].strip()
    return strip_to_plain_text(result)


async def rewrite_text(text: str, tone: str) -> str:
    """Call the LLM to rewrite *text* with the given *tone*.

    Returns only the rewritten string — no preamble, no commentary.
    Raises RuntimeError on misconfiguration, httpx.TimeoutException on timeout.
    """
    client = _get_client()
    tone_desc = TONE_DESCRIPTIONS.get(tone, tone.lower())

    prompt = (
        f"Rephrase the following text so that it sounds {tone_desc}.\n\n"
        "STRICT RULES:\n"
        "- Preserve the original meaning and intent exactly.\n"
        "- If the text is a question or request, rephrase that question/request — "
        "do NOT answer it, fulfill it, or expand it into new content.\n"
        "- Do not add facts, explanations, examples, or advice that were not in the original.\n"
        "- Keep roughly the same length (do not turn a short line into a long reply).\n"
        "- Return ONLY plain text — no markdown, HTML, code fences, bullet formatting, "
        "quotation marks around the whole reply, or commentary.\n"
        "- Do NOT start with an introduction like 'Here is...', 'Sure,', or 'Certainly,' — "
        "output must begin directly with the rephrased text itself.\n\n"
        f"Text:\n{text}"
    )

    response = await client.chat.completions.create(
        model=_model_name(),
        messages=[{"role": "user", "content": prompt}],
        max_tokens=1024,
        temperature=0.4,
    )

    return _clean_model_text(response.choices[0].message.content or "")


async def classify_allows_generate(text: str) -> bool:
    """Return True if the input is a question or a request to generate new content.

    Does not rely on a trailing '?'. Missing punctuation is fine.
    """
    client = _get_client()
    prompt = (
        "Classify the user's selected text.\n"
        "Answer YES if it is a question OR a request to generate new content "
        "(for example: draft an email, write a reply, compose a message, expand bullets, "
        "summarize into new text). A missing question mark still counts as a question "
        "if the wording is clearly asking something.\n"
        "Answer NO if it is normal prose that should only be rephrased/polished.\n"
        "Reply with exactly YES or NO — nothing else.\n\n"
        f"Text:\n{text}"
    )
    try:
        response = await client.chat.completions.create(
            model=_model_name(),
            messages=[{"role": "user", "content": prompt}],
            max_tokens=8,
            temperature=0,
        )
        raw = (response.choices[0].message.content or "").strip().lower()
        if raw.startswith("yes"):
            return True
        if raw.startswith("no"):
            return False
    except Exception:
        pass
    from sanitize import looks_like_prompt

    return looks_like_prompt(text)


async def generate_text(text: str, tone: str) -> str:
    """Generate short plain-text content from a brief (email/reply or expand bullets)."""
    client = _get_client()
    tone_desc = TONE_DESCRIPTIONS.get(tone, tone.lower())

    prompt = (
        f"Write short plain-text content from the user's brief. Tone: {tone_desc}.\n\n"
        "Allowed tasks only:\n"
        "- Short email or reply drafts (example: 'draft a email for leave' → leave email body)\n"
        "- Expand bullet points into one coherent paragraph\n\n"
        "STRICT RULES:\n"
        "- Return ONLY the generated message body as plain text.\n"
        "- No markdown, HTML, code fences, headings, or bullet symbols in the output.\n"
        "- No URLs or links of any kind.\n"
        "- Do not ask for or invent personal data (SSN, passwords, addresses, IDs, etc.).\n"
        "- Keep it short: typically one short email/reply or one paragraph.\n"
        "- If the brief is unsafe or asks for disallowed content, reply with exactly: "
        "I cannot help with that request.\n"
        "- Do NOT start with an introduction like 'Here is...', 'Sure,', or 'Certainly,' — "
        "output must begin directly with the message body itself.\n\n"
        f"Brief:\n{text}"
    )

    response = await client.chat.completions.create(
        model=_model_name(),
        messages=[{"role": "user", "content": prompt}],
        max_tokens=512,
        temperature=0.7,
    )

    cleaned = _clean_model_text(response.choices[0].message.content or "")
    if len(cleaned) > GENERATE_MAX_CHARS:
        cleaned = cleaned[:GENERATE_MAX_CHARS].rsplit(" ", 1)[0].strip()
    return cleaned
