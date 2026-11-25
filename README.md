# MiniProxy v2 — restricted full-page proxy starter

## What changed
- Clicking the extension icon opens a separate MiniProxy tab. It does not replace Chrome New Tab and does not open a tab on install.
- The viewer sends navigation to the Render server's `/proxy?url=...` endpoint instead of navigating directly to the destination.
- The server proxies HTML, CSS and byte resources, rewrites many common URL attributes, and follows redirects only when each redirect destination remains allowed.
- The server blocks non-public IP addresses and caps resource size/time.

## Deploy on Render
1. Upload `server.js` and `package.json` to the root of the Render web service repository.
2. Deploy the service.
3. In Render environment variables, set `HOST_ALLOWLIST` to the exact domains you are authorised to proxy, comma-separated. Example: `example.com,docs.example.org,static.example.org`. Do not use a public unrestricted open proxy.
4. Confirm `https://YOUR-SERVICE/` returns the MiniProxy v2 status text.
5. In Chrome, open `chrome://extensions`, remove the old extension, enable Developer mode, click Load unpacked, and choose this folder.

## Important limitations
This is a constrained starter, not a guarantee that every website works. Modern sites can depend on complex JavaScript APIs, cross-origin requests, service workers, WebSockets, authentication cookies, CAPTCHA and anti-bot checks. The server uses an explicit allowlist for safety and does not provide unrestricted access to every domain. Browser sandbox behaviour may also limit some pages.
