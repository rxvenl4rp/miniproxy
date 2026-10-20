const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 20000;
// HOST_ALLOWLIST="*" allows any public host. Otherwise use e.g. "example.com,*.wikipedia.org"
const allowedHosts = (process.env.HOST_ALLOWLIST || '*')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const allowAll = allowedHosts.includes('*');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

app.use(express.raw({ type: () => true, limit: '10mb' }));

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
      s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.') ||
      s.startsWith('::ffff:169.254.'));
  }
  return false;
}

function allowedHost(host) {
  if (allowAll) return true;
  host = host.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some(rule => host === rule || (rule.startsWith('*.') && host.endsWith(rule.slice(1))));
}

async function validateUrl(input) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public http(s) URLs are supported.');
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
  }).replace(/@import\s+(['"])(.*?)\1/gi, (all, q, value) => {
    try { return `@import url("${proxyUrl(new URL(value, base))}")`; } catch { return all; }
  });
}

async function fetchChecked(startUrl, method, body, reqHeaders) {
  let url = await validateUrl(startUrl);
  for (let i = 0; i < 8; i++) {
    const headers = {
      'User-Agent': UA,
      'Accept': reqHeaders['accept'] || '*/*',
      'Accept-Language': reqHeaders['accept-language'] || 'en-GB,en;q=0.9'
    };
    if (reqHeaders['range']) headers['Range'] = reqHeaders['range'];
    if (reqHeaders['content-type'] && body) headers['Content-Type'] = reqHeaders['content-type'];
    const response = await fetch(url, {
      method,
      body: body && body.length ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await validateUrl(new URL(response.headers.get('location'), url).href);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'; body = undefined;
      }
      continue;
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw new Error('Resource is larger than the size limit.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('Resource is larger than the size limit.');
    return { response, url, buffer };
  }
  throw new Error('Too many redirects.');
}

// Script injected into every proxied page: reroutes fetch/XHR/dynamic elements/forms
// through the proxy and tells the viewer which real URL is showing.
function clientScript(targetHref) {
  const target = JSON.stringify(targetHref).replace(/</g, '\\u003c');
  return `(function(){
var BASE=location.origin,T=new URL(${target});
function px(u){try{
  u=String(u);
  if(/^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(u))return u;
  if(u.indexOf('/proxy?url=')===0||u.indexOf(BASE+'/proxy?url=')===0)return u;
  var a=new URL(u,T.href);
  if(a.protocol!=='http:'&&a.protocol!=='https:')return u;
  return BASE+'/proxy?url='+encodeURIComponent(a.href);
}catch(e){return u;}}
var of=window.fetch;
if(of)window.fetch=function(i,o){
  try{
    if(typeof i==='string'||i instanceof URL)i=px(i);
    else if(i&&i.url){i=new Request(px(i.url),i);}
  }catch(e){}
  return of.call(this,i,o);
};
var xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  arguments[1]=px(u);
  return xo.apply(this,arguments);
};
var wo=window.open;
window.open=function(u){arguments[0]=u?px(u):u;return wo.apply(this,arguments);};
function fix(el){
  if(!el||el.nodeType!==1)return;
  ['src','href','action','poster'].forEach(function(a){
    var v=el.getAttribute&&el.getAttribute(a);
    if(v&&v.indexOf('/proxy?url=')!==0&&!/^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(v)){
      if(a==='action')el.setAttribute('data-orig-action',v);
      el.setAttribute(a,px(v));
    }
  });
  if(el.children)for(var i=0;i<el.children.length;i++)fix(el.children[i]);
}
new MutationObserver(function(ms){
  ms.forEach(function(m){
    m.addedNodes.forEach(fix);
    if(m.type==='attributes'){
      var v=m.target.getAttribute(m.attributeName);
      if(v&&v.indexOf('/proxy?url=')!==0)fix(m.target);
    }
  });
}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href','action']});
document.addEventListener('submit',function(e){
  var f=e.target;
  if(f&&(f.method||'get').toLowerCase()==='get'){
    e.preventDefault();
    var u=new URL(f.getAttribute('data-orig-action')||T.href,T.href);
    new FormData(f).forEach(function(v,k){if(typeof v==='string')u.searchParams.set(k,v);});
    location.href=px(u.href);
  }
},true);
try{parent.postMessage({type:'miniproxy-nav',url:T.href,title:document.title},'*');}catch(e){}
})();`;
}

app.get('/', (_req, res) => res.type('text').send('MiniProxy v3 is running.'));

app.all('/proxy', async (req, res) => {
  try {
    if (typeof req.query.url !== 'string') return res.status(400).send('Missing url parameter.');
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const body = Buffer.isBuffer(req.body) ? req.body : undefined;
    const { response, url, buffer } = await fetchChecked(req.query.url, method, body, req.headers);
    const type = (response.headers.get('content-type') || 'application/octet-stream').toLowerCase();
    res.status(response.status);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    for (const h of ['content-range', 'accept-ranges']) {
      const v = response.headers.get(h);
      if (v) res.set(h, v);
    }

    if (type.includes('text/html')) {
      const $ = cheerio.load(buffer.toString('utf8'));
      $('base').remove();
      $('meta[http-equiv="Content-Security-Policy" i]').remove();
      $('meta[http-equiv="refresh" i]').remove();
      $('[integrity]').removeAttr('integrity');
      $('[nonce]').removeAttr('nonce');
      $('[src], [href], [action], [poster], [srcset]').each((_i, el) => {
        for (const attr of ['src', 'href', 'action', 'poster']) {
          const value = $(el).attr(attr);
          if (!value || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value)) continue;
          try {
            if (attr === 'action') $(el).attr('data-orig-action', new URL(value, url).href);
            $(el).attr(attr, proxyUrl(new URL(value, url)));
          } catch {}
        }
        const srcset = $(el).attr('srcset');
        if (srcset) {
          $(el).attr('srcset', srcset.split(',').map(part => {
            const bits = part.trim().split(/\s+/);
            try { bits[0] = proxyUrl(new URL(bits[0], url)); } catch {}
            return bits.join(' ');
          }).join(', '));
        }
      });
      // forms with no action submit to the current page
      $('form:not([action])').each((_i, el) => {
        $(el).attr('data-orig-action', url.href);
        $(el).attr('action', proxyUrl(url));
      });
      $('style').each((_i, el) => $(el).text(rewriteCss($(el).text(), url)));
      $('[style]').each((_i, el) => $(el).attr('style', rewriteCss($(el).attr('style'), url)));
      $('head').prepend(`<meta name="referrer" content="no-referrer"><script>${clientScript(url.href)}</script>`);
      if (!$('head').length) $.root().prepend(`<script>${clientScript(url.href)}</script>`);
      return res.type('text/html; charset=utf-8').send($.html());
    }
    if (type.includes('text/css')) {
      return res.type('text/css; charset=utf-8').send(rewriteCss(buffer.toString('utf8'), url));
    }
    res.set('Content-Type', type);
    res.send(buffer);
  } catch (e) {
    res.status(400).type('text').send(`MiniProxy could not load this resource: ${e.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`MiniProxy listening on ${PORT}`));
