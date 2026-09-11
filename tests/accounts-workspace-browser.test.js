'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');
const { seedIfEmpty } = require('../server/lib/seed');
const { createServer } = require('../server/index');
const { createAccountRuntime } = require('../server/lib/accounts/runtime');
const { bootstrapLegacyAdmin, resetPassword } = require('../server/lib/accounts/admin');
const { openBrowser, available } = require('./browser-driver');

test('真实账号工作区：/resume登录、旧稿、改密、会话撤销、退出保存与跨账号缓存清理', {
  skip:!available,timeout:120000,
},async t=>{
  seedIfEmpty();
  const database=helpers.db.getDb();
  await bootstrapLegacyAdmin(database,{apply:true});
  const password='private administrative test phrase 9821';
  const nextPassword='replacement administrative test phrase 5918';
  await resetPassword(database,{username:'admin',password,apply:true});
  let upstream;
  const proxy=http.createServer((req,res)=>{
    if(!req.url.startsWith('/resume/')){res.writeHead(404).end();return}
    const request=http.request({hostname:'127.0.0.1',port:upstream.address().port,
      path:req.url.slice('/resume'.length),method:req.method,headers:req.headers},response=>{
      res.writeHead(response.statusCode,response.headers);response.pipe(res);
    });
    request.on('error',()=>res.writeHead(502).end());req.pipe(request);
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>{proxy.closeAllConnections();proxy.close()});
  const origin='http://127.0.0.1:'+proxy.address().port;
  const runtime=createAccountRuntime({database,config:{enabled:true,registration:'open',
    publicOrigin:origin,basePath:'/resume',allowInsecureLoopback:true},
    rateSecret:'workspace-browser-private-test-bucket-secret'});
  upstream=createServer({accountRuntime:runtime});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>helpers.close({server:upstream}));
  const oldOwner=helpers.db.get("SELECT id FROM users WHERE email='demo@resume-planet.local'").id;
  const project=helpers.db.get('SELECT id FROM resume_projects WHERE owner_id=? ORDER BY created_at LIMIT 1',[oldOwner]).id;
  const browser=await openBrowser(t,origin+'/resume/login.html?return='+encodeURIComponent('/resume/?project='+project),
    {home:true,readyExpression:'Boolean(window.ResumeAccount&&!document.querySelector("#submit").disabled)'});
  const {evaluate,click,until,cdp}=browser;
  async function fill(selector,text){
    await click(selector);await cdp('Input.insertText',{text});
  }
  await fill('#username','admin');await fill('#password',password);await click('#submit');
  await until('Boolean(window.WS&&WS.draft)&&document.documentElement.dataset.accountReady==="true"');
  assert.equal(await evaluate('ResumeAccount.session().user.id'),oldOwner);
  assert.equal(await evaluate('document.querySelector("#account-button").title'),'admin');
  // Create an independent second device through the real domain service.
  const extra=await runtime.login({username:'admin',password},runtime.buckets({headers:{},
    socket:{remoteAddress:'192.0.2.89'}},'admin'));
  const managed=await runtime.register({username:'browser_managed_member',password},runtime.buckets({headers:{},
    socket:{remoteAddress:'192.0.2.90'}},'browser_managed_member'));
  await click('#account-button');await click('#account-settings-button');
  assert.equal(await evaluate('document.querySelector("#account-password-section").open'),false);
  assert.equal(await evaluate('document.querySelector("#account-management-section")!==null'),true);
  assert.equal(await evaluate('document.querySelector("#account-dialog").getBoundingClientRect().height<450'),true,
    '默认设置页保持紧凑，不展开密码表单与登录列表');
  await click('#account-management-section summary');
  await until('document.querySelectorAll(".managed-account").length===2');
  const managedRow='.managed-account[data-account-id="'+managed.user.id+'"]';
  await click(managedRow+' [data-action=status]');
  await until('document.querySelector("#account-dialog [role=status]").textContent.includes("已停用")');
  assert.throws(()=>runtime.resolve(managed.token));
  await until('!document.querySelector("'+managedRow.replace(/"/g,'\\"')+' [data-action=status]").disabled');
  await click(managedRow+' [data-action=status]');
  await until('document.querySelector("#account-dialog [role=status]").textContent.includes("已启用")');
  await click('#account-management-section summary');
  await click('#account-devices-section summary');
  await until('document.querySelectorAll("#account-session-list .account-session").length===2');
  await click('#account-session-list button');
  await until('document.querySelectorAll("#account-session-list .account-session").length===1');
  assert.throws(()=>runtime.resolve(extra.token));
  await click('#account-password-section summary');
  await fill('#account-password-current',password);
  await fill('#account-password-new',nextPassword);
  await fill('#account-password-confirm',nextPassword);
  await click('#account-dialog form button[type=submit]');
  await until('document.querySelector("#account-dialog [role=status]").textContent.includes("密码已更新")');
  assert.equal(await evaluate('api("/projects").then(result=>result.items.length>0)'),true,'轮转Cookie后前端CSRF同步');
  await click('#account-dialog button[aria-label="关闭账号设置"]');
  // Leave text focused: explicit logout must save it before invalidating auth.
  const selector='#resume-document [data-resume-editable=true]';
  await click(selector);
  await cdp('Input.insertText',{text:'账号退出前待保存的测试文字'});
  await evaluate('sessionStorage.setItem("resumeHomeLinkDraftV2","https://private.example/old-job")');
  await click('#account-button');await click('#account-logout-button');
  await until('location.pathname.endsWith("/login.html")&&window.ResumeAccount&&!document.querySelector("#submit").disabled');
  assert.equal(await evaluate('sessionStorage.getItem("resumeHomeLinkDraftV2")'),null);
  assert.ok(helpers.db.get('SELECT resume_json FROM resume_drafts WHERE project_id=?',[project])
    .resume_json.includes('账号退出前待保存的测试文字'));
  await click('#switch');await fill('#username','separate_workspace_user');
  await fill('#password','separate new account testing phrase 3348');await click('#submit');
  await until('location.pathname==="/resume/"&&document.documentElement.dataset.accountReady==="true"');
  assert.notEqual(await evaluate('ResumeAccount.session().user.id'),oldOwner);
  assert.deepEqual(await evaluate('api("/projects").then(result=>result.items)'),[]);
  assert.equal(await evaluate('homeController.getState().intake'),null);
  assert.equal(await evaluate('document.querySelector("#home-job-link").value'),'');
  assert.equal(await evaluate('document.querySelector("#home-account-button").textContent'),'S');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate(`(()=>{
    const button=document.querySelector('#home-account-button'),rect=button.getBoundingClientRect();
    return rect.width===36&&rect.height===36&&rect.right<=innerWidth
      &&rect.left>innerWidth/2&&getComputedStyle(button).borderRadius==='50%';
  })()`),true,'窄屏个人中心保持右侧圆形头像，不因用户名长度撑开');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click('#home-account-button');
  assert.equal(await evaluate('document.querySelector("#account-management-section")'),null);
  assert.equal(await evaluate('document.querySelector("#account-password-section").open'),false);
  await click('#account-dialog button[aria-label="关闭账号设置"]');
  assert.equal(await evaluate(`fetch(API+"/projects/"+${JSON.stringify(project)}).then(response=>response.status)`),404);
  const image=await sharp({create:{width:48,height:64,channels:3,background:'#81988c'}}).png().toBuffer();
  await evaluate(`(()=>{
    const clipboard=new DataTransfer();
    clipboard.items.add(new File([Uint8Array.from(atob(${JSON.stringify(image.toString('base64'))}),c=>c.charCodeAt(0))],
      'new-account.png',{type:'image/png'}));
    document.querySelector('[data-home-role=personal]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:clipboard}));
  })()`);
  await until('homeController.getState().intake?.materials.personal.status==="ready"');
  const intake=await evaluate('homeController.getState().intake');
  const owner=await evaluate('ResumeAccount.session().user.id');
  assert.equal(helpers.db.get('SELECT owner_id FROM uploads WHERE id=?',[intake.materials.personal.upload_id]).owner_id,owner,
    '真实Cookie/CSRF下XHR原图上传只属于新账号');
  assert.notEqual(intake.project_id,project);
  assert.deepEqual(browser.errors,[]);
});
