
const express = require("express");
const dns = require("dns").promises;
const net = require("net");

const app = express();
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const allowedHosts = (process.env.HOST_ALLOWLIST || "example.com")
  .split(",")
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    return !(
      parts[0] === 10 ||
      parts[0] === 127 ||
      parts[0] === 0 ||
      parts[0] === 169 && parts[1] === 254 ||
      parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
      parts[0] === 192 && parts[1] === 168 ||
      parts[0] >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === "::1" ? false :
      !(s.startsWith("fc") || s.startsWith("fd") ||
        s.startsWith("fe8") || s.startsWith("fe9") ||
        s.startsWith("fea") || s.startsWith("feb") ||
        s === "::");
  }

  return false;
}

app.get("/", (req, res) => {
  res.type("text").send("MiniProxy server is running.");
});

app.post("/api/read", async (req, res) => {
  try {
    const url = new URL(req.body.url);

    if (url.protocol !== "https:") {
      return res.status(400).json({ error: "HTTPS URLs only." });
    }

    const host = url.hostname.toLowerCase();

    if (!allowedHosts.includes(host)) {
      return res.status(403).json({
        error: "This domain is not in HOST_ALLOWLIST."
      });
    }

    const addresses = await dns.lookup(host, { all: true });

    if (!addresses.length || addresses.some(a => !isPublicIp(a.address))) {
      return res.status(403).json({ error: "Address not allowed." });
    }

    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "MiniProxyTextViewer/1.0" }
    });

    if (response.status >= 300 && response.status < 400) {
      return res.status(400).json({
        error: "Redirects are not supported."
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        error: `Website returned status ${response.status}.`
      });
    }

    const type = response.headers.get("content-type") || "";

    if (!type.includes("text/html") && !type.includes("text/plain")) {
      return res.status(415).json({
        error: "Only HTML and plain text are supported."
      });
    }

    const html = (await response.text()).slice(0, 500000);
    const text = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();

    res.json({ title: host, text: text.slice(0, 20000) });
  } catch (err) {
    res.status(400).json({ error: "Could not read that URL." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MiniProxy listening on port ${PORT}`);
});
