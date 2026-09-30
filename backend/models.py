from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum


class Resolution(str, Enum):
    accepted = "accepted"
    edited = "edited"
    dismissed = "dismissed"
    regenerated = "regenerated"
    error = "error"


ALLOWED_TONES = frozenset({"Confident", "Professional", "Friendly", "Concise"})


class RewriteRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000)
    tone: str = Field(..., min_length=1, max_length=40)


class GenerateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000)
    tone: str = Field(..., min_length=1, max_length=40)


class RewriteResponse(BaseModel):
    suggestion: str
    allows_generate: bool = False


class GenerateResponse(BaseModel):
    suggestion: str


class LogRequest(BaseModel):
    tone: str
    original_text: str
    suggested_text: str
    final_text: Optional[str] = None
    resolution: Resolution
    latency_ms: int
    app_context: Optional[str] = None
