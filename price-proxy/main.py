"""
Price-quote proxy for the NATSR Unified extension.

The pricing API needs a secret key (X-Ext-Key). A Chrome extension is client
code, so the key cannot live in it. This service holds the key and forwards
quote requests, so the extension only ever talks to this server.

    extension  --POST /price-quote-->  this proxy  --X-Ext-Key-->  pricing API

Run:
    pip install -r requirements.txt
    PRICING_KEY=... uvicorn main:app --host 0.0.0.0 --port 8080
"""

import hmac
import os

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv()

BACKEND_BASE_URL = os.environ.get("BACKEND_BASE_URL", "https://qagent.dhaninfo.ai").rstrip("/")
PRICING_KEY = os.environ.get("PRICING_KEY", "")
# Optional. When set, callers must send it as X-Proxy-Token.
PROXY_TOKEN = os.environ.get("PROXY_TOKEN", "")
# Each quote runs a live web search, so it can take a while.
UPSTREAM_TIMEOUT_SECONDS = float(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "90"))

# Optional: the extension's ID (chrome://extensions). When set, only that
# extension may call the proxy from a browser; otherwise any extension may.
EXTENSION_ID = os.environ.get("EXTENSION_ID", "").strip()

UPSTREAM_URL = f"{BACKEND_BASE_URL}/lms/pricing/price-quote"

app = FastAPI(title="NATSR price-quote proxy")

# The extension sends JSON, so the browser first asks permission (a preflight
# OPTIONS request). Without these headers it blocks the call.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"chrome-extension://{EXTENSION_ID}"] if EXTENSION_ID else [],
    allow_origin_regex=None if EXTENSION_ID else r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Proxy-Token"],
)


class QuoteIn(BaseModel):
    customer: str = Field(..., min_length=1, max_length=300)
    inspection_type: str = Field(..., min_length=1, max_length=100)
    survey_type: str = Field(..., min_length=1, max_length=200)
    address: str = Field(..., min_length=1, max_length=500)


@app.get("/health")
async def health():
    return {"ok": True, "key_configured": bool(PRICING_KEY), "upstream_url": UPSTREAM_URL}


@app.post("/price-quote")
async def price_quote(body: QuoteIn, x_proxy_token: str | None = Header(default=None)):
    if PROXY_TOKEN and not hmac.compare_digest(x_proxy_token or "", PROXY_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid proxy token")
    if not PRICING_KEY:
        raise HTTPException(status_code=500, detail="PRICING_KEY is not set on the proxy")

    # Only CrossCover is priced. Answer here, without spending a search.
    if "crosscover" not in body.customer.lower():
        return {
            "customer": body.customer,
            "status": "not_found",
            "total": None,
            "base_price": None,
            "restaurant_count": None,
            "restaurant_addon_each": 75.0,
            "restaurant_total": None,
            "capped": False,
            "notes": ["Pricing is only set up for CrossCover."],
            "line_ids": [],
            "restaurant_check": None,
            "quote_id": None,
        }

    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
            upstream = await client.post(
                UPSTREAM_URL,
                json=body.model_dump(),
                headers={"X-Ext-Key": PRICING_KEY},
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="The pricing API timed out")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach the pricing API")

    # A 404 from the pricing API is not a missing proxy route; say where it came from.
    if upstream.status_code == 404:
        raise HTTPException(
            status_code=502,
            detail=f"The pricing API returned 404 at {UPSTREAM_URL} - check BACKEND_BASE_URL",
        )

    # A 401 here means the proxy's own key is wrong, which the caller cannot fix.
    if upstream.status_code == 401:
        raise HTTPException(status_code=502, detail="The pricing API rejected the proxy's key")

    try:
        data = upstream.json()
    except ValueError:
        data = {"detail": upstream.text[:200] or f"HTTP {upstream.status_code}"}
    return JSONResponse(status_code=upstream.status_code, content=data)
