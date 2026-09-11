(function(global){
  'use strict';
  // Workspace composition only. Credentials, sessions and transport belong to
  // ResumeAccount; resume editing remains owned by the existing application.
  function element(tag,text){var node=document.createElement(tag);if(text)node.textContent=text;return node}
  function clearWorkingCache(){
    try{
      for(var i=sessionStorage.length-1;i>=0;i--){
        var key=sessionStorage.key(i);
        if(key&&key.indexOf('resume')===0)sessionStorage.removeItem(key);
      }
    }catch(_){}
  }
  function isolateOwner(owner){
    try{
      if(sessionStorage.getItem('resumeSessionOwner')!==owner)clearWorkingCache();
      sessionStorage.setItem('resumeSessionOwner',owner);
    }catch(_){}
  }
  function installStyle(){
    if(document.getElementById('account-workspace-style'))return;
    var style=element('style');style.id='account-workspace-style';
    style.textContent=`
.home-account-bar{display:flex;align-items:center;justify-content:space-between;gap:16px}
.home-account-button,.account-avatar{display:inline-grid;place-items:center;flex:none;width:36px;height:36px;border:1px solid rgba(0,0,0,.06);border-radius:50%;background:rgba(118,118,128,.09);color:#4a4a4f;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
.home-account-button{cursor:pointer}.home-account-button:hover{background:rgba(118,118,128,.14);color:#1d1d1f}.home-account-button:focus-visible{outline:3px solid #0071e33d;outline-offset:2px}
.account-dialog{box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:90dvh;overflow:auto;padding:24px;border:1px solid rgba(0,0,0,.075);border-radius:24px;color:var(--ink,#1d1d1f);background:#fff;box-shadow:0 24px 80px #17233422}.account-dialog::backdrop{background:#0004;backdrop-filter:blur(6px)}
.account-dialog header{display:flex;align-items:center;justify-content:space-between;gap:16px}.account-dialog h2{font-size:19px;letter-spacing:-.5px;margin:0}.account-dialog h2:focus{outline:0}.account-dialog p{font-size:12px;color:#737378;line-height:1.6}.account-identity{display:flex;align-items:center;gap:12px;padding:22px 0}.account-identity strong{font-size:14px}.account-role{display:block;margin-top:3px;color:#737378;font-size:11px}
.account-dialog label{display:block;font-size:12px;margin:12px 0 6px}.account-dialog input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #dce1e7;border-radius:10px;font:inherit;font-size:13px}.account-dialog input:focus{outline:3px solid #0071e31a;border-color:#0071e3}
.account-dialog button{padding:8px 11px;border:0;border-radius:9px;background:#f2f2f7;font:inherit;font-size:12px;color:#4a4a4f;cursor:pointer}.account-dialog button:focus-visible,.account-dialog summary:focus-visible{outline:3px solid #0071e33d;outline-offset:2px}.account-dialog button:disabled{opacity:.5;cursor:default}.account-dialog button.primary{background:#0071e3;color:#fff}.account-dialog button.account-close{width:30px;height:30px;padding:0;border-radius:50%;font-size:20px}.account-dialog form button{margin-top:12px}
.account-section{border-top:1px solid rgba(0,0,0,.075)}.account-section>summary{list-style:none;cursor:pointer;padding:17px 0;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between}.account-section>summary::-webkit-details-marker{display:none}.account-section>summary::after{content:'⌄';color:#8e8e93}.account-section[open]>summary::after{transform:rotate(180deg)}.account-section-content{padding:0 0 18px}.account-section-content form>label:first-child{margin-top:0}
.account-session,.managed-account{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid #f0f0f3}.account-session p{margin:0}.account-session:first-child{border:0}.managed-account-copy{min-width:0;overflow-wrap:anywhere}.managed-account-copy strong{font-size:12px}.managed-account-copy p{margin:4px 0 0;font-size:11px}.managed-account-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex:none;max-width:150px}.managed-account-actions button{font-size:11px;padding:7px 9px}.managed-account-actions .danger{color:#b5473d;background:#fff1ef}
.account-search{display:flex;gap:8px;margin:0 0 10px}.account-search input{min-width:0}.account-dialog .account-search button{margin:0;flex:none}.account-pages{display:flex;align-items:center;justify-content:space-between;gap:8px}.account-pages span{font-size:11px;color:#737378}
.account-dialog [role=status]{margin:12px 0 0}.account-dialog [role=status]:empty{display:none}.account-dialog [role=status][data-error=true]{color:#b5473d}.account-dialog footer{display:flex;justify-content:flex-end;border-top:1px solid rgba(0,0,0,.075);padding-top:18px;margin-top:0}.account-dialog footer button{background:transparent;color:#737378}
@media(max-width:480px){.account-dialog{padding:20px;border-radius:20px}.account-dialog input{font-size:16px}.managed-account{align-items:flex-start}.managed-account-actions{max-width:112px}}
`;
    document.head.appendChild(style);
  }
  global.ResumeAccountWorkspace={start:async function(options){
    options=options||{};
    installStyle();
    var account=global.ResumeAccount,busy=false,dialog=null,status=null;
    function invalidate(){
      document.documentElement.dataset.accountReady='false';
      clearWorkingCache();
      if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null}
      if(options.invalidate)options.invalidate();
    }
    var session=await account.bootstrap({apiBase:options.apiBase,onInvalidate:invalidate});
    isolateOwner(session.user.id);
    function message(text,failed){
      if(status){status.textContent=text||'';status.dataset.error=String(Boolean(failed))}
    }
    async function logout(){
      if(busy)return;
      busy=true;
      try{await account.logout({beforeLogout:options.flush})}
      catch(error){message(error.message,true);if(options.notify)options.notify(error.message)}
      finally{busy=false}
    }
    function setBusy(value){
      busy=value;
      if(dialog)dialog.querySelectorAll('input,button').forEach(function(control){control.disabled=value||control.dataset.unavailable==='true'});
    }
    function section(label,id){
      var details=element('details');details.className='account-section';details.id=id;
      var summary=element('summary',label),body=element('div');body.className='account-section-content';
      details.append(summary,body);return {details:details,body:body};
    }
    async function loadSessions(container){
      container.replaceChildren(element('p','正在读取…'));
      try{
        var result=await account.request('/auth/sessions');
        if(!container.isConnected)return;
        container.replaceChildren();
        result.items.forEach(function(item){
          var row=element('div');row.className='account-session';
          row.append(element('p',item.current?'当前登录':'其他登录'));
          if(!item.current){
            var remove=element('button','退出此登录');remove.type='button';
            remove.onclick=async function(){
              if(busy)return;setBusy(true);message('');
              try{await account.request('/auth/sessions/'+encodeURIComponent(item.id),{method:'DELETE'});await loadSessions(container)}
              catch(error){message(error.message,true)}finally{setBusy(false)}
            };row.append(remove);
          }
          container.append(row);
        });
      }catch(error){if(container.isConnected)container.replaceChildren(element('p',error.message))}
    }
    function mountManagement(container){
      var search=element('form'),input=element('input'),find=element('button','查找');
      search.className='account-search';input.type='search';input.placeholder='搜索用户名';input.setAttribute('aria-label','搜索用户名');input.maxLength=64;
      find.type='submit';search.append(input,find);
      var list=element('div');list.id='managed-accounts';
      var pages=element('div');pages.className='account-pages';
      container.append(search,list,pages);
      var offset=0,sequence=0;
      async function load(){
        var seq=++sequence;list.replaceChildren(element('p','正在读取账号…'));pages.replaceChildren();
        try{
          var result=await account.request('/auth/admin/accounts?q='+encodeURIComponent(input.value.trim())+'&offset='+offset);
          if(seq!==sequence||!container.isConnected)return;
          list.replaceChildren();
          if(!result.items.length)list.append(element('p','没有匹配的账号'));
          result.items.forEach(function(item){
            var row=element('div');row.className='managed-account';row.dataset.accountId=item.id;
            var copy=element('div');copy.className='managed-account-copy';
            copy.append(element('strong',item.username),element('p',item.role==='superadmin'?'超级管理员':item.status==='active'?'正常':'已停用'),
              element('p','最近登录：'+(item.last_login_at?new Date(item.last_login_at).toLocaleString('zh-CN',{hour12:false}):'暂无记录')));
            row.append(copy);
            if(item.role!=='superadmin'){
              var actions=element('div');actions.className='managed-account-actions';
              [['status',item.status==='active'?'停用':'启用'],['revoke','退出所有登录']].forEach(function(entry){
                var button=element('button',entry[1]);button.type='button';button.dataset.action=entry[0];
                if(entry[0]==='status'&&item.status==='active')button.className='danger';
                button.onclick=async function(){
                  if(busy)return;setBusy(true);message('');
                  try{
                    var url='/auth/admin/accounts/'+encodeURIComponent(item.id);
                    if(entry[0]==='status')await account.request(url,{method:'PATCH',body:{status:item.status==='active'?'disabled':'active'}});
                    else await account.request(url+'/revoke-sessions',{method:'POST'});
                    message(item.username+'：'+(entry[0]==='revoke'?'已退出所有登录':item.status==='active'?'已停用':'已启用'));
                    await load();
                  }catch(error){message(error.message,true)}finally{setBusy(false)}
                };actions.append(button);
              });row.append(actions);
            }
            list.append(row);
          });
          if(result.total>result.limit){
            var previous=element('button','上一页'),next=element('button','下一页');
            previous.type=next.type='button';previous.disabled=offset===0;next.disabled=offset+result.limit>=result.total;previous.dataset.unavailable=String(previous.disabled);next.dataset.unavailable=String(next.disabled);
            previous.onclick=function(){if(!busy&&offset>0){offset-=result.limit;load()}};
            next.onclick=function(){if(!busy&&offset+result.limit<result.total){offset+=result.limit;load()}};
            pages.append(previous,element('span',(offset+1)+'–'+(offset+result.items.length)+' / '+result.total),next);
          }
        }catch(error){if(seq===sequence&&container.isConnected)list.replaceChildren(element('p',error.message))}
      }
      search.onsubmit=function(event){event.preventDefault();if(!busy){offset=0;load()}};
      return load;
    }
    function openSettings(){
      if(dialog&&dialog.open)return;
      if(dialog)dialog.remove();
      dialog=element('dialog');dialog.className='account-dialog';dialog.id='account-dialog';
      dialog.setAttribute('aria-labelledby','account-dialog-title');
      var header=element('header'),heading=element('h2','账号设置');heading.id='account-dialog-title';heading.tabIndex=-1;
      var close=element('button','×');close.className='account-close';close.type='button';close.setAttribute('aria-label','关闭账号设置');
      close.onclick=function(){if(!busy)dialog.close()};header.append(heading,close);
      var identity=element('div');identity.className='account-identity';
      var avatar=element('span',Array.from(display)[0].toUpperCase());avatar.className='account-avatar';avatar.setAttribute('aria-hidden','true');
      var copy=element('div');copy.append(element('strong',display));
      if(session.user.role==='superadmin'){var role=element('span','超级管理员');role.className='account-role';copy.append(role)}
      identity.append(avatar,copy);dialog.append(header,identity);
      var passwordSection=section('修改密码','account-password-section'),form=element('form');
      [['current','当前密码','current-password'],['new','新密码','new-password'],['confirm','确认新密码','new-password']].forEach(function(field){
        var label=element('label',field[1]),input=element('input');
        input.id='account-password-'+field[0];input.name=field[0];input.type='password';
        input.autocomplete=field[2];input.required=true;input.maxLength=256;
        label.htmlFor=input.id;form.append(label,input);
      });
      form.append(element('p','新密码使用 15–128 个字符，修改后其他登录会退出。'));
      var save=element('button','更新密码');save.type='submit';save.className='primary';form.append(save);
      passwordSection.body.append(form);
      status=element('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      var deviceSection=section('登录设备','account-devices-section'),sessions=element('div');sessions.id='account-session-list';deviceSection.body.append(sessions);
      deviceSection.details.addEventListener('toggle',function(){if(deviceSection.details.open)loadSessions(sessions)});
      form.onsubmit=async function(event){
        event.preventDefault();if(busy)return;
        var current=form.elements.namedItem('current').value,next=form.elements.namedItem('new').value;
        if(next!==form.elements.namedItem('confirm').value){message('两次输入的新密码不一致',true);return}
        setBusy(true);message('正在更新密码…');
        try{
          if(options.flush)await options.flush();
          var result=await account.request('/auth/password',{method:'POST',body:{current_password:current,new_password:next}});
          account.updateSession(result);session=result;form.reset();passwordSection.details.open=false;message('密码已更新，其他登录已退出');
          if(deviceSection.details.open)await loadSessions(sessions);
        }catch(error){message(error.message,true)}finally{setBusy(false)}
      };
      dialog.append(passwordSection.details,deviceSection.details);
      if(session.user.role==='superadmin'){
        var management=section('账号管理','account-management-section');dialog.append(management.details);
        var load=mountManagement(management.body);
        management.details.addEventListener('toggle',function(){if(management.details.open)load()});
      }
      var footer=element('footer'),leave=element('button','退出登录');leave.type='button';leave.onclick=logout;footer.append(leave);
      dialog.append(footer,status);
      dialog.addEventListener('cancel',function(event){if(busy)event.preventDefault()});
      dialog.addEventListener('close',function(){form.reset();message('')});
      document.body.append(dialog);dialog.showModal();
      // Keep the dialog's opening position as sections and async results grow.
      // Native vertical centering otherwise moves the clicked heading twice.
      var top=dialog.getBoundingClientRect().top;
      Object.assign(dialog.style,{top:top+'px',bottom:'auto',marginTop:'0',marginBottom:'0',
        maxHeight:'calc(100dvh - '+(top+16)+'px)',scrollbarGutter:'stable'});
      heading.focus();
    }
    var menu=document.querySelector('#account-menu'),button=document.querySelector('#account-button');
    var display=session.user.username||session.user.display_name||'账号';
    if(button){button.textContent=Array.from(display)[0].toUpperCase();button.title=display;button.setAttribute('aria-label','个人中心，'+display)}
    if(menu){
      var settings=element('button','账号设置'),exit=element('button','退出登录');
      settings.id='account-settings-button';exit.id='account-logout-button';
      settings.onclick=function(){menu.hidden=true;if(button)button.setAttribute('aria-expanded','false');openSettings()};
      exit.onclick=logout;menu.append(settings,exit);
    }
    var brand=document.querySelector('.home-brand');
    if(brand){
      var bar=element('div');bar.className='home-account-bar';brand.before(bar);bar.append(brand);
      var homeAccount=element('button',Array.from(display)[0].toUpperCase());homeAccount.type='button';homeAccount.id='home-account-button';
      homeAccount.className='home-account-button';homeAccount.title='个人中心';homeAccount.setAttribute('aria-label','个人中心，'+display);
      homeAccount.onclick=openSettings;bar.append(homeAccount);
    }
    document.documentElement.dataset.accountReady='true';
    return options.boot();
  },clearWorkingCache:clearWorkingCache};
})(window);
