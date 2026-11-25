
const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;

// Configure exact domains or wildcard subdomains in Render.
const allowedHosts = (process.env.HOST_ALLOWLIST || 'example.com')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);

class ProxyError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
  }
}

function publicIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);

    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    );
  }

  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase();

    return !(
      value === '::' ||
      value === '::1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb') ||
      value.startsWith('::ffff:127.') ||
      value.startsWith('::ffff:10.') ||
      value.startsWith('::ffff:192.168.')
    );
  }

  return false;
}

function allowedHost(host) {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');

  return allowedHosts.some(rule => {
    if (rule === '*') return false;

    if (rule.startsWith('*.')) {
      const domain = rule.slice(2);

      return normalizedHost === domain ||
        normalizedHost.endsWith('.' + domain);
    }

    return normalizedHost === rule;
  });
}

async function validateUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new ProxyError('The supplied URL is invalid.', 400);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password
  ) {
    throw new ProxyError(
      'Only public HTTPS URLs without embedded credentials are supported.',
      400
    );
  }

  if (url.port && url.port !== '443') {
    throw new ProxyError(
      'Only the standard HTTPS port is supported.',
      400
    );
  }

  if (!allowedHost(url.hostname)) {
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
      'Could not resolve the destination hostname.',
      502
    );
  }

  if (
    !records.length ||
    records.some(record => !publicIp(record.address))
  ) {
    throw new ProxyError(
      'Destination IP is not public.',
      403
    );
  }

  return url;
}

function proxyUrl(url) {
  return '/proxy?url=' + encodeURIComponent(url.href);
}

function rewriteCss(css, baseUrl) {
  return css
    .replace(
      /url\((\s*)(['"]?)(.*?)\2(\s*)\)/gi,
      (all, before, quote, value, after) => {
        const trimmed = value.trim();

        if (
          !trimmed ||
          /^(data:|blob:|javascript:|#)/i.test(trimmed)
        ) {
          return all;
        }

        try {
          return `url(${before}${quote}${proxyUrl(
            new URL(trimmed, baseUrl)
          )}${quote}${after})`;
        } catch {
          return all;
        }
      }
    )
    .replace(
      /@import\s+(?:url\()?\s*(['"])(.*?)\1\s*\)?/gi,
      (all, quote, value) => {
        try {
          return `@import url("${proxyUrl(
            new URL(value, baseUrl)
          )}")`;
        } catch {
          return all;
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
        throw new ProxyError(
          'The destination request timed out.',
          504
        );
      }

      throw new ProxyError(
        `Could not connect to destination: ${error.message}`,
        502
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (!location) {
        throw new ProxyError(
          'Redirect did not include a destination.',
          502
        );
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

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    if (contentLength > MAX_BYTES) {
      throw new ProxyError(
        'Resource is larger than the 4 MB limit.',
        413
      );
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (buffer.length > MAX_BYTES) {
      throw new ProxyError(
        'Resource is larger than the 4 MB limit.',
        413
      );
    }

    return { response, url, buffer };
  }

  throw new ProxyError('Too many redirects.', 502);
}

app.get('/', (_req, res) => {
  res.type('text').send(
    'MiniProxy is running. Configure HOST_ALLOWLIST for authorised domains.'
  );
});

app.get('/proxy', async (req, res) => {
  try {
    if (typeof req.query.url !== 'string') {
      return res.status(400).type('text').send(
        'Missing or invalid url parameter.'
      );
    }

    const { response, url, buffer } =
      await fetchChecked(req.query.url);

    const contentType = (
      response.headers.get('content-type') ||
      'application/octet-stream'
    ).toLowerCase();

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');

    // Preserve destination security restrictions.
    for (const header of [
      'content-security-policy',
      'x-frame-options',
      'referrer-policy'
    ]) {
      const value = response.headers.get(header);

      if (value) {
        res.set(header, value);
      }
    }

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(buffer.toString('utf8'));

      $('base').remove();
      $('meta[http-equiv="refresh" i]').remove();

      $('[src], [href], [action], [poster], [srcset]')
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
              // Keep unsupported values unchanged.
            }
          }

          const srcset = $(element).attr('srcset');

          if (srcset) {
            const rewritten = srcset
              .split(',')
              .map(part => {
                const pieces = part.trim().split(/\s+/);

                try {
                  pieces[0] = proxyUrl(
                    new URL(pieces[0], url)
                  );
                } catch {
                  // Keep unsupported candidates unchanged.
                }

                return pieces.join(' ');
              })
              .join(', ');

            $(element).attr('srcset', rewritten);
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

      res.type('text/html; charset=utf-8').send($.html());
      return;
    }

    if (contentType.includes('text/css')) {
      res.type('text/css; charset=utf-8').send(
        rewriteCss(buffer.toString('utf8'), url)
      );
      return;
    }

    res.set('Content-Type', contentType);
    res.send(buffer);

  } catch (error) {
    console.error('MiniProxy error:', error);

    const statusCode = error instanceof ProxyError
      ? error.statusCode
      : 502;

    const message = error instanceof Error
      ? error.message
      : 'Unknown proxy error';

    if (!res.headersSent) {
      res.status(statusCode).type('text').send(
        `MiniProxy could not load this resource:\n${message}`
      );
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MiniProxy listening on ${PORT}`);
});
