'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { isIP, BlockList } = require('node:net');
const { problem } = require('./util');

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');

function publicAddress(address) {
  // IPv6-only destinations fail closed until equivalent IPv6 range validation
  // is available. Never fall back to an unvalidated DNS lookup.
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}
function readableText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name])
    .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

async function fetchPage(raw, { lookup = dns.lookup, request, signal } = {}) {
  const deadline = Date.now() + 15000;
  let url = new URL(raw);
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal?.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))) throw new Error('链接地址不受支持');
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, family: 4 }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('链接解析超时')), Math.max(1, deadline - Date.now()));
        timer.unref();
      }),
    ]);
    if (!addresses.length || !addresses.every((item) => publicAddress(item.address))) {
      throw new Error('链接不是可公开访问的地址');
    }
    const address = addresses[0];
    const result = await new Promise((resolve, reject) => {
      const transport = request || (url.protocol === 'https:' ? https.request : http.request);
      const req = transport(url, {
        signal,
        method: 'GET', headers: { accept: 'text/html,text/plain', 'accept-encoding': 'identity',
          'user-agent': 'ResumePlanet/3.0 (user-requested job page reader)' },
        lookup: (_, options, callback) => callback(null,
          options.all ? [address] : address.address, address.family),
      }, (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) { res.destroy(new Error('网页过大，请粘贴岗位描述')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8') }));
      });
      const timer = setTimeout(() => req.destroy(new Error('读取链接超时')),
        Math.max(1, deadline - Date.now()));
      req.on('error', reject);
      req.on('close', () => clearTimeout(timer));
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      url = new URL(result.headers.location, url); continue;
    }
    if (result.status !== 200 || !/^text\/(html|plain)\b/i.test(result.headers['content-type'] || '')) {
      throw new Error('网页要求登录、限制读取或不是岗位文本');
    }
    const text = readableText(result.text);
    if (text.length < 80 || text.length > 60000) throw new Error('未获得可用的岗位描述');
    return { url: raw, resolved_url: url.href, text };
  }
  throw new Error('链接跳转次数过多');
}

async function readMessageLinks(content, signal) {
  const urls = [...new Set(String(content).match(/https?:\/\/[^\s<>"'，。；）)]+/g) || [])];
  if (urls.length > 3) throw problem.badRequest('一次最多读取 3 个链接，请分次补充');
  try { return await Promise.all(urls.map((url) => fetchPage(url, { signal }))); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw problem.unprocessable('JOB_LINK_UNREADABLE',
      '链接读取失败：' + error.message + '。请在当前输入框粘贴岗位描述，或上传截图后继续。');
  }
}

module.exports = { publicAddress, readableText, fetchPage, readMessageLinks };
