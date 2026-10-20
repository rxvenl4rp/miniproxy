const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const allowedHosts = (process.env.HOST_ALLOWLIST || 'example.com')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

function publicIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return !(s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
      s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') ||
      s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.'));
  }
  return false;
}

function allowedHost(host) {
  host = host.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some(rule => host === rule || (rule.startsWith('*.') && host.endsWith(rule.slice(1))));
}

async function validateUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only public HTTPS URLs are supported.');
  if (!allowedHost(url.hostname)) throw new Error(`Domain ${url.hostname} is not in HOST_ALLOWLIST.`);
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(r => !publicIp(r.address))) throw new Error('Destination IP is not public.');
  return url;
}

function proxyUrl(url) {
  return '/proxy?url=' + encodeURIComponent(url.href);
}
function rewriteCss(css, base) {
  return css.replace(/url\((\s*)(['"]?)(.*?)\2(\s*)\)/gi, (all, pre, quote, value, post) => {
    const v = value.trim();
    if (!v || /^(data:|blob:|javascript:|#)/i.test(v)) return all;
    try { return `url(${pre}${quote}${proxyUrl(new URL(v, base))}${quote}${post})`; }
    catch { return all; }
  }).replace(/@import\s+(?:url\()?\s*(['"])(.*?)\1\s*\)?/gi, (all, q, value) => {
    try { return `@import url("${proxyUrl(new URL(value, base))}")`; } catch { return all; }
  });
}

async function fetchChecked(startUrl) {
  let url = await validateUrl(startUrl);
  for (let i = 0; i < 6; i++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'MiniProxy/2.0 (authorised browsing viewer)', 'Accept': '*/*' }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect did not include a destination.');
      url = await validateUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`Destination returned HTTP ${response.status}.`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw new Error('Resource is larger than the 4 MB limit.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('Resource is larger than the 4 MB limit.');
    return { response, url, buffer };
  }
  throw new Error('Too many redirects.');
}

app.get('/', (_req, res) => res.type('text').send('MiniProxy v2 is running. Configure HOST_ALLOWLIST for authorised domains.'));
app.get('/proxy', async (req, res) => {
  try {
    if (typeof req.query.url !== 'string') return res.status(400).send('Missing url parameter.');
    const { response, url, buffer } = await fetchChecked(req.query.url);
    const type = (response.headers.get('content-type') || 'application/octet-stream').toLowerCase();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    if (type.includes('text/html')) {
      const html = buffer.toString('utf8');
      const $ = cheerio.load(html);
      $('base').remove();
      $('meta[http-equiv="Content-Security-Policy" i]').remove();
      $('meta[http-equiv="refresh" i]').remove();
      $('[src], [href], [action], [poster], [srcset]').each((_i, el) => {
        const attrs = ['src', 'href', 'action', 'poster'];
        for (const attr of attrs) {
          const value = $(el).attr(attr);
          if (!value || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value)) continue;
          try { $(el).attr(attr, proxyUrl(new URL(value, url))); } catch {}
        }
        const srcset = $(el).attr('srcset');
        if (srcset) {
          const rewritten = srcset.split(',').map(part => {
            const bits = part.trim().split(/\s+/);
            try { bits[0] = proxyUrl(new URL(bits[0], url)); } catch {}
            return bits.join(' ');
          }).join(', ');
          $(el).attr('srcset', rewritten);
        }
      });
      $('style').each((_i, el) => $(el).text(rewriteCss($(el).text(), url)));
      $('[style]').each((_i, el) => $(el).attr('style', rewriteCss($(el).attr('style'), url)));
      // Keep relative resource resolution tied to the source page via explicit rewriting.
      $('head').prepend(`<meta name="referrer" content="no-referrer">`);
      res.type('text/html; charset=utf-8').send($.html());
      return;
    }
    if (type.includes('text/css')) {
      res.type('text/css; charset=utf-8').send(rewriteCss(buffer.toString('utf8'), url));
      return;
    }
    // Serve media, fonts, scripts, JSON and other assets as bytes. JavaScript-driven
    // sites may still fail because browser APIs, cookies and cross-origin behaviour vary.
    res.set('Content-Type', type);
    res.send(buffer);
  } catch (e) {
    res.status(400).type('text').send(`MiniProxy could not load this resource: ${e.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`MiniProxy listening on ${PORT}`));
