'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const home = require('../server/modules/home');
const validation = require('../server/lib/home-job-validation');
const assets = require('../server/lib/document-assets');
const harness = require('../server/lib/resume-harness');
const { openBrowser, available } = require('./browser-driver');
let ctx, png;
test.before(async () => {
  ctx = await helpers.boot();
  png = await sharp({ create: { width: 320, height: 480, channels: 3, background: '#8cae99' } }).png().toBuffer();
});
test.after(() => { home.setLinkReaderForTests(null); validation.setClientForTests(null); helpers.close(ctx); });
const call = (method, url, body) => helpers.call(ctx, method, url, { body });
async function upload() {
  const item = (await call('POST','/uploads',{ original_name: '材料.png', mime_type:'image/png',size:png.length })).body;
  assert.equal((await fetch(ctx.base+'/uploads/'+item.id+'/content',{method:'POST',body:png})).status,200);
  assert.equal((await call('POST','/uploads/'+item.id+'/complete',{})).status,200);
  return item.id;
}
test('首页截图不创建OCR任务，角色冻结进入视觉输入，删除/复制不破坏资料或资源', async t => {
  const value = (await call('POST','/home/intakes',{})).body;
  const importCount = helpers.db.get('SELECT count(*) n FROM document_imports').n;
  const ids = await Promise.all([upload(),upload(),upload()]);
  await Promise.all(['personal','job','layout'].map(async (role,i) => {
    assert.equal((await call('PUT',`/home/intakes/${value.id}/materials/${role}`,
      {upload_id:ids[i],image_material:true})).status,200);
  }));
  const ready = (await call('GET','/home/intakes/'+value.id)).body;
  assert.equal(ready.ready,true);
  assert.equal(helpers.db.get('SELECT count(*) n FROM document_imports').n,importCount);
  assert.equal((await call('DELETE','/uploads/'+ids[0])).status,409,'正在使用的首页图片不能被清理');
  const requests=[];
  t.after(harness.setModelClientForTests({async generate(options){
    requests.push(options);return {output:{type:'message',content:'希望重点突出哪段经历？'}};
  }}));
  const prepared = (await call('POST',`/home/intakes/${value.id}/prepare`,{})).body;
  const response = await call('POST',`/projects/${value.project_id}/ai/messages`,prepared.request);
  assert.equal(response.status,200,JSON.stringify(response.body));
  const sources=requests[0].input.image_sources;
  assert.deepEqual(sources.map(s=>s.material_role).sort(),['job','layout','personal']);
  assert.equal(sources.find(s=>s.material_role==='layout').reference_only,true);
  assert.ok(JSON.stringify(requests[0].messages).includes('image_url'),'原图实际进入视觉消息');
  const copied=(await call('POST','/home/intakes',{copy_intake_id:value.id})).body;
  assert.equal(copied.ready,true);
  assert.notEqual(copied.project_id,value.project_id);
  assert.equal(copied.materials.personal.asset_id,ready.materials.personal.asset_id);
  const deleted=(await call('DELETE',`/home/intakes/${copied.id}/materials/personal`)).body;
  assert.equal(deleted.ready,false);
  assert.equal(deleted.materials.personal.status,'empty');
  assert.equal((await call('GET','/home/intakes/'+value.id)).body.materials.personal.status,'ready');
  assert.equal((await fetch(ctx.base.replace('/api/v1','')+ready.materials.personal.preview_url)).status,200);
  // Only the accepted message keeps these images alive after changing materials.
  helpers.db.run('UPDATE home_intakes SET state_json=? WHERE id IN (?,?)',
    ['{}',value.id,copied.id]);
  helpers.db.run('DELETE FROM document_image_cache WHERE upload_id IN (?,?,?)',ids);
  assert.equal((await call('DELETE','/uploads/'+ids[0])).status,409,
    '首页材料已移除，已受理对话仍需继续读取原图');
  const ownerId=helpers.db.get('SELECT owner_id FROM home_intakes WHERE id=?',[value.id]).owner_id;
  const collected=assets.collectUnusedAssets(ownerId,{graceMs:0});
  assert.notEqual(collected.deferred,true);
  assert.ok(helpers.db.get('SELECT id FROM document_assets WHERE id=?',[ready.materials.personal.asset_id]),
    '没有首页选择和解析缓存时，冻结消息仍保护不可变图片');
});
test('删除处理中截图阻止迟到重新绑定；三种角色异步更新互不覆盖', async t => {
  const value=(await call('POST','/home/intakes',{})).body, id=await upload();
  const original=assets.prepareUploadImages;let release,entered;
  const started=new Promise(resolve=>{entered=resolve});
  const held=new Promise(resolve=>{release=resolve});
  assets.prepareUploadImages=async function(uploadId,options){if(uploadId===id){entered();await held}return original(uploadId,options)};
  t.after(()=>{release();assets.prepareUploadImages=original});
  const pending=call('PUT',`/home/intakes/${value.id}/materials/personal`,{upload_id:id,image_material:true});
  await started;
  await call('DELETE',`/home/intakes/${value.id}/materials/personal`);
  release();
  assert.equal((await pending).body.superseded,true);
  assert.equal((await call('GET','/home/intakes/'+value.id)).body.materials.personal.status,'empty');
});
test('真实Chromium：粘贴立即预览可取消、就绪呼吸点、删除、链接红色告警和生成按钮', {
  skip:!available,timeout:45000,
},async t=>{
  home.setLinkReaderForTests(async ()=>{throw new Error('unavailable')});
  const browser=await openBrowser(t,ctx.base.replace('/api/v1','/'),{home:true});
  const {evaluate,click,until,cdp}=browser;
  await until('window.homeController');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit")).backgroundColor'),'rgb(229, 229, 234)',
    '材料未就绪时为浅灰色，不显示可生成的蓝色');
  await evaluate(`window.__realFetch=window.fetch;window.fetch=function(url,opts){
    if(String(url).endsWith('/uploads')&&opts&&opts.method==='POST'){
      return new Promise(resolve=>{window.__releaseUpload=()=>resolve(__realFetch(url,opts))});
    }return __realFetch(url,opts)};`);
  async function paste(role){
    await evaluate(`(()=>{
      const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0))],'image.png',{type:'image/png'}));
      document.querySelector('[data-home-role="${role}"]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
    })()`);
  }
  await paste('personal');
  await until('window.__releaseUpload&&document.querySelector("[data-home-role=personal] .home-file-preview img").naturalWidth>0');
  assert.equal(await evaluate('document.querySelector("[data-home-remove=personal]").disabled'),false);
  await click('#home-personal-status .home-file-name');
  await until('document.querySelector(".home-image-preview").open&&document.querySelector(".home-image-preview img").naturalWidth>0');
  await click('.home-image-preview button[aria-label="关闭图片预览"]');
  await click('[data-home-remove="personal"]');
  await until('homeController.getState().intake.materials.personal.status==="empty"&&!homeController.getState().busy.length');
  await evaluate('window.fetch=window.__realFetch;window.__releaseUpload()');
  await paste('personal');
  await until('homeController.getState().intake.materials.personal.status==="ready"&&!homeController.getState().busy.length');
  assert.equal(await evaluate('document.querySelectorAll("#home-personal-status .home-ready-dot").length'),1);
  assert.equal(await evaluate('document.querySelector("#home-personal-status").lastElementChild.className'),'home-ready-dot');
  assert.match(await evaluate('document.querySelector("#home-personal-status").textContent'),/已就绪/);
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".home-ready-dot")).animationName'),'none');
  await click('#home-job-link');await cdp('Input.insertText',{text:'bad-url'});
  await until('document.querySelector("#home-job-link").getAttribute("aria-invalid")==="true"');
  await until('getComputedStyle(document.querySelector("#home-job-status")).color==="rgb(174, 60, 53)"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-job-status")).color'),'rgb(174, 60, 53)');
  await click('[data-home-remove="job"]');
  await until('!document.querySelector("#home-job-link").value&&!homeController.getState().busy.length');
  await click('#home-job-link');await cdp('Input.insertText',{text:'https://jobs.example/missing'});
  await until('document.querySelector("[data-home-role=job]").dataset.state==="failed"');
  assert.equal(await evaluate('document.querySelector("#home-job-link").getAttribute("aria-invalid")'),'true');
  await paste('job');
  await until('homeController.getState().intake.materials.job.status==="ready"&&!homeController.getState().busy.length');
  await paste('layout');
  await until('!document.querySelector("#home-submit").disabled');
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(0, 113, 227)"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit")).backgroundColor'),
    await evaluate('getComputedStyle(document.querySelector("#resume-preview-apply")).backgroundColor'),
    '就绪生成按钮与详情页真实“应用修改”按钮使用相同蓝色');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit")).color'),'rgb(255, 255, 255)');
  await click('#home-personal-status .home-file-name');
  await until('document.querySelector(".home-image-preview").open&&document.querySelector(".home-image-preview img").naturalWidth>0');
  await click('.home-image-preview button[aria-label="关闭图片预览"]');
  await click('[data-home-remove="personal"]');
  await until('homeController.getState().intake.materials.personal.status==="empty"&&!homeController.getState().busy.length');
  assert.equal(await evaluate('document.querySelector("#home-submit").disabled'),true);
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(229, 229, 234)"');
  assert.equal(await evaluate('document.querySelector("[data-home-role=personal] .home-file-preview").hidden'),true);
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await evaluate('document.querySelector("#home-submit").classList.add("ai-generation-pending")');
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(0, 113, 227)"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit"),"::before").animationName'),'sendThinking',
    '生成中的禁用按钮仍保留旋转态，而不是变成未就绪浅灰按钮');
  await evaluate('document.querySelector("#home-submit").classList.remove("ai-generation-pending")');
  assert.deepEqual(browser.errors,[]);
});

test('真实Chromium：生成按钮配色与应用修改一致，浅灰未就绪、旋转生成态及键盘焦点保留', {
  skip:!available,timeout:20000,
},async t=>{
  const {evaluate,until,cdp}=await openBrowser(t,ctx.base.replace('/api/v1','/'),{home:true});
  await until('window.homeController');
  await until('document.querySelectorAll("[data-layout-id]").length===20&&[...document.querySelectorAll("[data-layout-id]")].every(button=>button.dataset.imageReady==="true")');
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(229, 229, 234)"');
  // Isolated rendering states: no request, material mutation or model generation.
  await evaluate('document.querySelector("#home-submit").disabled=false');
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(0, 113, 227)"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit")).backgroundColor'),
    await evaluate('getComputedStyle(document.querySelector("#resume-preview-apply")).backgroundColor'));
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await evaluate('document.querySelector("#home-submit").focus()');
  assert.equal(await evaluate('document.querySelector("#home-submit").matches(":focus-visible")'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit")).outlineColor'),'rgb(0, 113, 227)');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit")).outlineWidth'),'2px');
  await evaluate('document.querySelector("#home-submit").disabled=true;document.querySelector("#home-submit").classList.add("ai-generation-pending")');
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(0, 113, 227)"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#home-submit"),"::before").animationName'),'sendThinking');
  await evaluate('document.querySelector("#home-submit").classList.remove("ai-generation-pending")');
  await until('getComputedStyle(document.querySelector("#home-submit")).backgroundColor==="rgb(229, 229, 234)"');
});
