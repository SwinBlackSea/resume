'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器：没有简历时首页标识不创建、覆盖或跳转到无效详情', {
  skip: !available, timeout: 30000,
}, async t => {
  const ctx = await helpers.boot({ seed: false }); t.after(() => helpers.close(ctx));
  // Browser helper awaits a loaded workspace, so use an empty-project response
  // on reload after a normal initial workspace in this isolated database.
  const { seedIfEmpty } = require('../server/lib/seed');
  seedIfEmpty();
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  await browser.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    const actualFetch=window.fetch;
    window.fetch=function(url,options){
      if(String(url).endsWith('/projects')&&(!options||!options.method||options.method==='GET'))
        return Promise.resolve(new Response(JSON.stringify({items:[]}),{headers:{'content-type':'application/json'}}));
      return actualFetch.apply(this,arguments);
    };
  ` });
  const count = helpers.db.get('SELECT count(*) n FROM resume_projects').n;
  await browser.evaluate('window.__emptyOldPage=true');
  await browser.cdp('Page.reload');
  await browser.until('!window.__emptyOldPage&&Object.hasOwn(window,"PROJECT_ID")&&window.PROJECT_ID===undefined');
  assert.equal(await browser.evaluate('document.querySelector(".home-brand").disabled'), true);
  await browser.click('.home-brand');
  assert.equal(await browser.evaluate('document.body.classList.contains("home-mode")'), true);
  assert.equal(helpers.db.get('SELECT count(*) n FROM resume_projects').n, count);
  assert.deepEqual(browser.errors, []);
});
