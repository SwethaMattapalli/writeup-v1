"""Output / input guardrails for rewrite and generate."""

from __future__ import annotations

import re

# Strip fenced code blocks, then inline code, then HTML tags.
_CODE_FENCE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_HTML_TAG = re.compile(r"</?[a-zA-Z][^>]*>")
_MD_HEADING = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_MD_BOLD_ITALIC = re.compile(r"(\*\*|__)(.*?)\1")
_MD_ITALIC = re.compile(r"(\*|_)(.*?)\1")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://[^\s<>\"']+|www\.[^\s<>\"']+", re.IGNORECASE)
_BULLET_PREFIX = re.compile(r"^[\s]*([-*•]|\d+[.)])\s+", re.MULTILINE)

# Generate input: refuse personal-data harvesting and obvious unsafe asks.
_PERSONAL_DATA = re.compile(
    r"\b("
    r"ssn|social\s*security|passport\s*number|driver'?s?\s*licen[cs]e|"
    r"credit\s*card|cvv|bank\s*account|routing\s*number|"
    r"password|passphrase|private\s*key|seed\s*phrase|"
    r"date\s*of\s*birth|home\s*address|phone\s*number|"
    r"national\s*id|aadhaar|pan\s*card"
    r")\b",
    re.IGNORECASE,
)

_UNSAFE_TOPICS = re.compile(
    r"\b("
    r"how\s+to\s+(make|build|create)\s+(a\s+)?(bomb|explosive|weapon)|"
    r"child\s*porn|csam|"
    r"kill\s+(someone|people|him|her)|"
    r"hack\s+into|steal\s+(credentials|passwords)|"
    r"credit\s*card\s*fraud|phishing\s+email"
    r")\b",
    re.IGNORECASE,
)

# Preamble the model adds despite instructions, e.g. "Here is a rephrased
# version of the text in a formal tone:" — strip up to and including the colon.
_PREAMBLE = re.compile(
    r"^\s*(here(?:'s| is| are)|sure|certainly|of course|okay|alright)\b[^:\n]{0,200}:\s*",
    re.IGNORECASE,
)

# Heuristic: selection looks like a prompt / question → suggest Generate.
_PROMPT_START = re.compile(
    r"^\s*("
    r"write|draft|compose|generate|create|make|expand|summarize|"
    r"reply\s+to|respond\s+to|email\s+(about|to)|"
    r"can\s+you|could\s+you|please\s+(write|draft|help)"
    r")\b",
    re.IGNORECASE,
)


def strip_preamble(text: str) -> str:
    """Remove a leading intro sentence like 'Here is a rephrased version:'."""
    if not text:
        return ""
    out = _PREAMBLE.sub("", text, count=1)
    out = out.strip()
    if (out.startswith('"') and out.endswith('"')) or (out.startswith("'") and out.endswith("'")):
        out = out[1:-1].strip()
    return out


def strip_to_plain_text(text: str) -> str:
    """Remove markdown, HTML, code fences, and URLs; keep readable plain text."""
    if not text:
        return ""
    out = _CODE_FENCE.sub("", text)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _HTML_TAG.sub("", out)
    out = _MD_LINK.sub(r"\1", out)
    out = _MD_HEADING.sub("", out)
    out = _MD_BOLD_ITALIC.sub(r"\2", out)
    out = _MD_ITALIC.sub(r"\2", out)
    out = _URL.sub("", out)
    # Collapse leftover blank lines / spaces from stripped URLs.
    out = re.sub(r"[ \t]+\n", "\n", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return out.strip()


def check_generate_input(text: str) -> str | None:
    """Return an error message if generate input violates guardrails, else None."""
    if _PERSONAL_DATA.search(text):
        return (
            "Generate cannot handle requests involving personal or sensitive data "
            "(IDs, passwords, financial details, etc.)."
        )
    if _UNSAFE_TOPICS.search(text):
        return "That request is blocked by WriteUp safety guardrails."
    return None


def looks_like_prompt(text: str) -> bool:
    """True when selection is likely a generation brief rather than prose to rewrite."""
    t = text.strip()
    if not t:
        return False
    if t.endswith("?"):
        return True
    if _PROMPT_START.search(t):
        return True
    # Several bullet lines → expand-into-paragraph use case.
    bullets = _BULLET_PREFIX.findall(t)
    if len(bullets) >= 2:
        return True
    return False
