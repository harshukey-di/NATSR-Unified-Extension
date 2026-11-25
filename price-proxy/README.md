# price-proxy

Holds the pricing API key so it never ships inside the extension.

## Run

```bash
pip install -r requirements.txt
export PRICING_KEY=...            # from the backend owner
uvicorn main:app --host 0.0.0.0 --port 8080
```

Serve it over HTTPS (reverse proxy or your host's TLS). Check `GET /health`.

## Connect the extension

1. `background/background.js`: set `PRICE_PROXY_URL` to `https://<your-host>/price-quote`.
2. `manifest.json`: replace `https://YOUR-PRICE-PROXY.example.com/*` in `host_permissions` with your host.
3. Reload the extension.

## Local testing

- Run it on `127.0.0.1` (e.g. `uvicorn main:app --port 8000`), set `PRICE_PROXY_URL`
  to `http://127.0.0.1:8000/price-quote`. `manifest.json` already allows
  `http://127.0.0.1/*` (any port).
- The proxy sends CORS headers for `chrome-extension://` origins. Set
  `EXTENSION_ID` to allow only your extension.
- Reload the extension at `chrome://extensions` after changing the manifest.

## Notes

- Only CrossCover customers are forwarded; others get `not_found` without a search.
- Anyone who can reach this URL can request quotes, and each one costs a live
  search. Keep it on a private network or behind your own auth, or set
  `PROXY_TOKEN` (the token is then inside the extension, so it only deters
  casual use).
