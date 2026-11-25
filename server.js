
const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;

const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const HOST_ALLOWLIST = (process.env.HOST_ALLOWLIST || '')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

if (!PROXY_PASSWORD) {
  throw new Error('Missing PROXY_PASSWORD environment variable.');
}

// Password protection
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Basic\s+(.+)$/i);

  if (match) {
    let decoded = '';

    try {
      decoded = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
      decoded = '';
    }

    const separator = decoded.indexOf(':');
    const password = separator >= 0
      ? decoded.slice(separator + 1)
      : '';

    const a = Buffer.from(password);
    const b = Buffer.from(PROXY_PASSWORD);

    if (
      separator >= 0 &&
      a.length === b.length &&
      require('crypto').timingSafeEqual(a, b)
    ) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="MiniProxy"');
  return res.status(401).type('text').send(
    'MiniProxy requires a password.'
  );
});

class ProxyError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isPublicIPv4(ip) {
  const p = ip.split('.').map(Number);

  return !(
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19))
  );
}

function isPublicIPv6(ip) {
  const value = ip.toLowerCase();

  // Only accept global unicast IPv6 addresses.
  if (!value.startsWith('2') && !value.startsWith('3')) {
    return false;
  }

  if (
    value.startsWith('2001:db8:') ||
    value.startsWith('2001:10:') ||
    value.startsWith('2002:')
  ) {
    return false;
  }

  return true;
}

function isPublicIP(ip) {
  const version = net.isIP(ip);

  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) return isPublicIPv6(ip);

  return false;
}

function hostIsAllowed(host) {
  const hostname = host.toLowerCase().replace(/\.$/, '');

  if (HOST_ALLOWLIST.includes('*')) {
    return true;
  }

  return HOST_ALLOWLIST.some(rule => {
    if (rule.startsWith('*.')) {
      const domain = rule.slice(2);
      return hostname === domain ||
        hostname.endsWith('.' + domain);
    }

    return hostname === rule;
  });
}

async function validateUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new ProxyError('Invalid URL.', 400);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new ProxyError(
      'Only standard HTTPS public website URLs are supported.',
      400
    );
  }

  if (!hostIsAllowed(url.hostname)) {
    throw new ProxyError(
      `Domain ${url.hostname} is not in HOST_ALLOWLIST.`,
      403
    );
  }

  let records;

  try {
    records = await dns.lookup(url.hostname, {
      all: true,
      verbatim: true
    });
  } catch {
    throw new ProxyError(
      'Could not resolve destination hostname.',
      502
    );
  }

  if (
    !records.length ||
    records.some(record => !isPublicIP(record.address))
  ) {
    throw new ProxyError(
      'Destination does not resolve exclusively to public IP addresses.',
      403
    );
  }

  return url;
}

function proxyUrl(url) {
  return '/proxy?url=' + encodeURIComponent(url.href);
}

function rewriteCss(css, baseUrl) {
  return css.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (match, quote, value) => {
      const trimmed = value.trim();

      if (
        !trimmed ||
        /^(data:|blob:|javascript:|#)/i.test(trimmed)
      ) {
        return match;
      }

      try {
        return `url("${proxyUrl(new URL(trimmed, baseUrl))}")`;
      } catch {
        return match;
      }
    }
  );
}

async function fetchChecked(startUrl) {
  let url = await validateUrl(startUrl);

  for (let redirects = 0; redirects < 6; redirects++) {
    let response;

    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'User-Agent': 'MiniProxy/2.0',
          'Accept': '*/*'
        }
      });
    } catch (error) {
      if (
        error.name === 'TimeoutError' ||
        error.name === 'AbortError'
      ) {
        throw new ProxyError('Destination timed out.', 504);
      }

      throw new ProxyError(
        `Connection failed: ${error.message}`,
        502
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (!location) {
        throw new ProxyError('Redirect has no location.', 502);
      }

      url = await validateUrl(
        new URL(location, url).href
      );

      continue;
    }

    if (!response.ok) {
      throw new ProxyError(
        `Destination returned HTTP ${response.status}.`,
        response.status
      );
    }

    const length = Number(
      response.headers.get('content-length') || 0
    );

    if (length > MAX_BYTES) {
      throw new ProxyError('Resource exceeds 4 MB.', 413);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_BYTES) {
      throw new ProxyError('Resource exceeds 4 MB.', 413);
    }

    return { response, url, buffer };
  }

  throw new ProxyError('Too many redirects.', 502);
}

app.get('/', (_req, res) => {
  res.type('text').send(
    'MiniProxy is running. Password protection is enabled.'
  );
});

app.get('/proxy', async (req, res) => {
  try {
    if (typeof req.query.url !== 'string') {
      throw new ProxyError('Missing URL parameter.', 400);
    }

    const { response, url, buffer } =
      await fetchChecked(req.query.url);

    const contentType = (
      response.headers.get('content-type') ||
      'application/octet-stream'
    ).toLowerCase();

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');

    for (const header of [
      'content-security-policy',
      'x-frame-options',
      'referrer-policy'
    ]) {
      const value = response.headers.get(header);
      if (value) res.set(header, value);
    }

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(buffer.toString('utf8'));

      $('base').remove();

      $('[src], [href], [action], [poster]')
        .each((_index, element) => {
          for (const attribute of [
            'src',
            'href',
            'action',
            'poster'
          ]) {
            const value = $(element).attr(attribute);

            if (
              !value ||
              /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value)
            ) {
              continue;
            }

            try {
              $(element).attr(
                attribute,
                proxyUrl(new URL(value, url))
              );
            } catch {
              // Leave unsupported URLs unchanged.
            }
          }
        });

      $('style').each((_index, element) => {
        $(element).text(
          rewriteCss($(element).text(), url)
        );
      });

      $('[style]').each((_index, element) => {
        $(element).attr(
          'style',
          rewriteCss($(element).attr('style'), url)
        );
      });

      return res.type('text/html; charset=utf-8').send($.html());
    }

    if (contentType.includes('text/css')) {
      return res.type('text/css; charset=utf-8').send(
        rewriteCss(buffer.toString('utf8'), url)
      );
    }

    res.set('Content-Type', contentType);
    res.send(buffer);

  } catch (error) {
    console.error('MiniProxy error:', error);

    const status = error instanceof ProxyError
      ? error.statusCode
      : 502;

    if (!res.headersSent) {
      res.status(status).type('text').send(
        `MiniProxy could not load this resource:\n${error.message || 'Unknown error'}`
      );
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MiniProxy listening on ${PORT}`);
});
