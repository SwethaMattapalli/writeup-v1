"""
WriteUp backend — FastAPI service.

Rewrite API plus a browser UI. Runs locally (127.0.0.1) or hosted (Render)
with WRITEUP_ACCESS_KEYS set.
"""

import asyncio
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from db import init_db, log_interaction
from llm import classify_allows_generate, generate_text, rewrite_text
from models import (
    ALLOWED_TONES,
    GenerateRequest,
    GenerateResponse,
    LogRequest,
    RewriteRequest,
    RewriteResponse,
)
from sanitize import check_generate_input, looks_like_prompt, strip_to_plain_text

_env_file = Path(os.environ["WRITEUP_ENV_FILE"]) if os.environ.get("WRITEUP_ENV_FILE") else Path(__file__).parent / ".env"
load_dotenv(_env_file)

MAX_TEXT_LEN = 3000
MAX_BODY_BYTES = 32_000
REWRITE_LIMIT = 30
REWRITE_WINDOW_SEC = 60
_rewrite_hits: dict[str, deque[float]] = {}

# Hosted mode: comma-separated per-tester keys. Unset = local-only, no auth.
ACCESS_KEYS = {k.strip() for k in os.environ.get("WRITEUP_ACCESS_KEYS", "").split(",") if k.strip()}
ALLOWED_HOSTS = [
    h.strip() for h in os.environ.get("WRITEUP_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()
]

FRONTEND_BUILD = Path(__file__).resolve().parent.parent / "app" / "build"
STATIC_DIR = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="WriteUp Backend", docs_url=None, redoc_url=None, lifespan=lifespan)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=ALLOWED_HOSTS,
)
app.add_middleware(
    CORSMiddleware,
    # Electron uses writeup:// so it must be allowed; hosted mode is protected by access keys.
    allow_origins=["*"],
    allow_origin_regex=r".*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _access_key(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


@app.middleware("http")
async def guardrails(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "Request too large."}, status_code=413)
    if ACCESS_KEYS and request.method != "OPTIONS" and request.url.path != "/health":
        if _access_key(request) not in ACCESS_KEYS:
            return JSONResponse({"detail": "Access key invalid — open WriteUp setup."}, status_code=401)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


def _rate_ok(request: Request) -> bool:
    hits = _rewrite_hits.setdefault(_access_key(request), deque())
    now = time.time()
    while hits and now - hits[0] > REWRITE_WINDOW_SEC:
        hits.popleft()
    if len(hits) >= REWRITE_LIMIT:
        return False
    hits.append(now)
    return True


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/rewrite", response_model=RewriteResponse)
async def rewrite(req: RewriteRequest, request: Request):
    if not _rate_ok(request):
        raise HTTPException(status_code=429, detail="Too many rewrite requests. Wait a minute and retry.")

    tone = req.tone.strip()
    if tone not in ALLOWED_TONES:
        raise HTTPException(status_code=400, detail="Tone is not allowed.")

    text = req.text[:MAX_TEXT_LEN]

    try:
        suggestion, allows_generate = await asyncio.wait_for(
            asyncio.gather(
                rewrite_text(text, tone),
                classify_allows_generate(text),
            ),
            timeout=100.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="The model timed out. Please retry.")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Model request failed. Please retry.",
        )

    cleaned = strip_to_plain_text(suggestion)
    if not cleaned:
        raise HTTPException(status_code=502, detail="The model returned empty text. Please retry.")

    # LLM classify OR heuristic — missing "?" / drafts like "Compose an email…" must unlock Generate.
    allow = bool(allows_generate) or looks_like_prompt(text)
    return RewriteResponse(suggestion=cleaned, allows_generate=allow)


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest, request: Request):
    if not _rate_ok(request):
        raise HTTPException(status_code=429, detail="Too many requests. Wait a minute and retry.")

    tone = req.tone.strip()
    if tone not in ALLOWED_TONES:
        raise HTTPException(status_code=400, detail="Tone is not allowed.")

    text = req.text[:MAX_TEXT_LEN]
    blocked = check_generate_input(text)
    if blocked:
        raise HTTPException(status_code=400, detail=blocked)

    try:
        suggestion = await asyncio.wait_for(
            generate_text(text, tone),
            timeout=100.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="The model timed out. Please retry.")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Model request failed. Please retry.",
        )

    cleaned = strip_to_plain_text(suggestion)
    if not cleaned:
        raise HTTPException(status_code=502, detail="The model returned empty text. Please retry.")

    return GenerateResponse(suggestion=cleaned)


@app.get("/suggest-mode")
async def suggest_mode(text: str = ""):
    """Lightweight hint for the widget: prefer Generate when text looks like a prompt."""
    clipped = (text or "")[:MAX_TEXT_LEN]
    return {"suggest_generate": looks_like_prompt(clipped)}


@app.post("/log")
async def log(req: LogRequest):
    log_interaction(
        tone=req.tone,
        original_text=req.original_text,
        suggested_text=req.suggested_text,
        resolution=req.resolution.value,
        latency_ms=req.latency_ms,
        final_text=req.final_text,
        app_context=req.app_context,
    )
    return {"ok": True}


def _index_file() -> Path:
    return STATIC_DIR / "index.html"


@app.get("/")
async def index():
    page = _index_file()
    if not page.exists():
        raise HTTPException(status_code=500, detail="WriteUp UI files are missing.")
    return FileResponse(page)


if FRONTEND_BUILD.exists():
    app.mount("/_app", StaticFiles(directory=str(FRONTEND_BUILD / "_app")), name="svelte-assets")
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
