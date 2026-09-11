(function(global){
  'use strict';
  // Homepage orchestration only. Generation, imports, versions and documents
  // remain the same server-owned capabilities used by the editor.
  global.ResumeHome = { create: function(options){
    var api=options.api,root=document.getElementById('home-view');
    var resourceUrl=options.resolveResourceUrl||function(url){return url};
    var $=function(selector){return root.querySelector(selector)};
    var $$=function(selector){return Array.from(root.querySelectorAll(selector))};
    var intake=null,creating=null,forking=null,renderer=null,result=null,started=false,destroyed=false;
    var busyRoles=new Set(),tokens={personal:0,job:0,layout:0},generationToken=0,pollTimer=null,linkTimer=null,linkDirty=false,validatingLink=false;
    var savedKey='resumeHomeIntakeV2',newKey='resumeHomeCreateV2',linkDraftKey='resumeHomeLinkDraftV2';
    var layoutItems=[],previewLayout=null,previewOpener=null,layoutLoading=null;
    var localFiles={},transfers={},roleWrites={},roleErrors={},mutationEpoch=0,imagePreview=null;
    function clearFile(role){var file=localFiles[role];if(file&&file.url)URL.revokeObjectURL(file.url);delete localFiles[role]}
    function acceptRole(value,role){
      if(intake&&intake.id===value.id){
        value.materials=Object.assign({},intake.materials,{[role]:value.materials[role]});
        value.ready=['personal','job','layout'].every(function(key){return value.materials[key].status==='ready'});
      }
      return setIntake(value);
    }
    function writeRole(role,action){
      var next=(roleWrites[role]||Promise.resolve()).catch(function(){}).then(action);
      roleWrites[role]=next;return next;
    }
    function showImage(role,opener){
      var value=intake&&intake.materials[role],local=localFiles[role];
      var url=local&&local.url||value&&value.preview_url;
      if(!url||!global.ResumeImagePreview)return;
      if(!imagePreview)imagePreview=global.ResumeImagePreview.create({apiBase:options.apiBase});
      imagePreview.open({url:resourceUrl(url),name:local&&local.name||value.name||'图片',opener:opener});
    }
    function clearLinkDraft(){try{sessionStorage.removeItem(linkDraftKey)}catch(_){}}
    function error(message){$('#home-error').hidden=!message;$('#home-error').textContent=message||''}
    function store(){try{if(intake)sessionStorage.setItem(savedKey,intake.id)}catch(_){}}
    function setIntake(value){intake=value;store();render();return value}
    function id(){return global.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2)}
    function render(){
      ['personal','job','layout'].forEach(function(role){
        var value=intake&&intake.materials[role],status=$('#home-'+role+'-status');
        var local=localFiles[role],pending=busyRoles.has(role);
        var state=roleErrors[role]?'failed':pending?(role==='job'&&validatingLink?'checking':'processing'):value&&value.status||'empty';
        status.classList.toggle('home-material-error',state==='failed');
        status.classList.toggle('home-material-ready',state==='ready');
        var label=local&&local.phase||'正在准备…';
        var message=roleErrors[role]||(
          state==='checking'?'正在验证岗位链接…':pending?label:state==='empty'?'Word、PDF，或拖入截图':
          state==='processing'?'正在识别材料…':state==='checking'?'正在验证岗位链接…':
          state==='failed'?(value.error||'材料处理失败，请更换文件'):
          '已就绪');
        var name=local&&local.name||value&&(value.name||value.title||value.url);
        var imageUrl=local&&local.url||value&&value.preview_url;
        status.replaceChildren();
        if(name&&state!=='empty'){
          var nameElement=document.createElement(imageUrl?'button':'span');
          nameElement.className='home-file-name';nameElement.textContent=name;
          if(imageUrl){nameElement.type='button';nameElement.setAttribute('aria-label','查看图片 '+name);
            nameElement.onclick=function(){showImage(role,this)}}
          status.append(nameElement,document.createTextNode(' · '));
        }
        status.appendChild(document.createTextNode(message));
        if(state==='ready'){var dot=document.createElement('span');dot.className='home-ready-dot';dot.setAttribute('aria-hidden','true');status.appendChild(dot)}
        var card=$('[data-home-role="'+role+'"]');
        card.dataset.state=state;card.setAttribute('aria-busy',String(pending||['processing','checking'].includes(state)));
        var preview=card.querySelector('.home-file-preview');
        if(!preview){preview=document.createElement('button');preview.type='button';preview.className='home-file-preview';
          preview.innerHTML='<img alt=""><span aria-hidden="true">查看大图</span>';
          preview.onclick=function(){showImage(role,this)};status.after(preview)}
        preview.hidden=!imageUrl;preview.setAttribute('aria-label','查看图片 '+(name||''));
        if(imageUrl){var thumbnail=preview.querySelector('img'),resolved=resourceUrl(imageUrl);
          if(thumbnail.getAttribute('src')!==resolved)thumbnail.src=resolved;thumbnail.alt=name||'上传图片'}
        else preview.querySelector('img').removeAttribute('src');
        $('[data-home-upload="'+role+'"]').disabled=started;
        $('[data-home-upload="'+role+'"]').textContent=state==='empty'?(role==='layout'?'上传模板':'上传材料'):'替换材料';
        var remove=$('[data-home-remove="'+role+'"]');remove.hidden=state==='empty';remove.disabled=started;
        remove.textContent='删除';remove.setAttribute('aria-label','删除'+(name||'这份材料'));
      });
      $('#home-job-link').setAttribute('aria-invalid',String(Boolean(roleErrors.job||(intake&&intake.materials.job.kind==='link'&&intake.materials.job.status==='failed'))));
      $('#home-job-link').disabled=started||(busyRoles.has('job')&&!validatingLink);
      $('#home-layout-toggle').disabled=started||busyRoles.has('layout');
      $$('[data-layout-id]').forEach(function(button){
        button.disabled=started||busyRoles.has('layout')||button.dataset.imageReady!=='true';
        button.setAttribute('aria-pressed',String(intake&&intake.materials.layout.layout_id===button.dataset.layoutId));
      });
      var chosen=intake&&layoutItems.find(function(item){return item.id===intake.materials.layout.layout_id});
      $('#home-layout-selected').hidden=!chosen;
      if(chosen){
        var selectedImage=$('#home-layout-selected-image');
        if(selectedImage.dataset.layoutId!==chosen.id){selectedImage.dataset.layoutId=chosen.id;selectedImage.src=chosen.preview_url;selectedImage.alt=chosen.name+'，已应用样式'}
        $('#home-layout-selected-name').textContent=chosen.name;
      }
      var ready=intake&&intake.ready&&!busyRoles.size&&!linkDirty;
      var submit=$('#home-submit');submit.disabled=started||!ready;
      submit.textContent=started?'正在生成…':result?'重新生成简历':'生成简历';
      submit.setAttribute('aria-busy',String(started));
      submit.classList.toggle('ai-generation-pending',started);
      $('#home-stop').hidden=!started;
      $('#home-question-send').disabled=started;
      $('#home-followup').disabled=started;
      $('#home-generation-status').textContent=started?'AI 正在生成，请稍候…':
        busyRoles.size?'正在准备材料…':'';
    }
    function ensure(){
      if(intake)return Promise.resolve(intake);
      if(creating)return creating;
      var key;
      try{key=sessionStorage.getItem(newKey);if(!key){key=id();sessionStorage.setItem(newKey,key)}}catch(_){key=id()}
      creating=api('/home/intakes',{method:'POST',idemKey:'home-intake-'+key,body:{}})
        .then(setIntake).finally(function(){creating=null});
      return creating;
    }
    function editable(){
      return ensure().then(function(current){
        if(!current.generated&&!current.attempted&&!result)return current;
        if(forking)return forking;
        forking=api('/home/intakes',{method:'POST',idemKey:'home-copy-'+current.id,
          body:{copy_intake_id:current.id}}).then(function(next){
          result=null;$('#home-result').hidden=true;
          $('#home-result-entry').hidden=true;if($('#home-result-modal').open)$('#home-result-modal').close();
          $('#home-question').hidden=true;
          return setIntake(next);
        }).finally(function(){forking=null});
        return forking;
      });
    }
    function schedulePoll(){
      clearTimeout(pollTimer);
      if(destroyed||!intake)return;
      var need=started||Object.values(intake.materials).some(function(value){return ['processing','checking'].includes(value.status)});
      if(need)pollTimer=setTimeout(function(){refresh().catch(function(e){error(e.message);schedulePoll()})},1400);
    }
    function loadResult(focus){
      var captured=intake.id;
      return api('/projects/'+intake.project_id).then(function(workspace){
        if(!intake||intake.id!==captured)return;
        if(!global.ResumeDom.plainText(workspace.draft.resume_json).trim()){
          var messages=workspace.conversation&&workspace.conversation.messages||[];
          var last=messages[messages.length-1];
          if(last&&last.role==='assistant'){
            if(last.result_type==='ERROR')error(last.content||'尚未生成完整简历，可以重试或替换材料。');
            else{
              error('');$('#home-question-message').textContent=last.content||'请补充需要的信息。';
              $('#home-question').hidden=false;
              try{$('#home-followup').value=sessionStorage.getItem('resumeHomeFollowup:'+intake.id)||''}catch(_){}
            }
          }
          return;
        }
        result={projectId:workspace.project.id,revision:workspace.draft.revision,
          name:workspace.project.name,document:workspace.draft.resume_json};
        intake.generated=true;started=false;
        $('#home-question').hidden=true;
        if(!renderer)renderer=new global.ResumeDom.Renderer($('#home-result-document'),{resolveResourceUrl:resourceUrl});
        renderer.render(global.ResumeDom.toResumeDocument(result.document));
        options.hydrate($('#home-result-document'));
        $('#home-result').hidden=false;$('#home-result-entry').hidden=false;render();
        if(focus)openResult();
      });
    }
    function refresh(){
      if(!intake)return Promise.resolve();
      var captured=intake.id,epoch=mutationEpoch;
      return api('/home/intakes/'+captured).then(function(value){
        if(!intake||intake.id!==captured||epoch!==mutationEpoch||busyRoles.size)return;
        setIntake(value);
        if(value.generated){var wasGenerating=started;started=false;error('');return loadResult(wasGenerating)}
        return api('/projects/'+value.project_id+'/ai/status?conversation_id='+encodeURIComponent(value.conversation_id))
          .then(function(status){
            if(!intake||intake.id!==captured)return;
            var previously=started;started=Boolean(status.running_task);render();
            if(previously&&!started)return loadResult(true);
          });
      }).finally(schedulePoll);
    }
    function upload(role,files){
      var file=Array.from(files||[])[0];
      if(!file||started)return;
      if((files||[]).length>1){error('每一栏添加一份材料，请选择一个文件。');return}
      if(!/\.(docx?|pdf|png|jpe?g|webp)$/i.test(file.name)||file.size>20*1024*1024||!file.size){
        error('支持 Word、PDF 和图片，每个文件不超过 20 MB。');return;
      }
      if(role==='job'){clearTimeout(linkTimer);validatingLink=false}
      if(transfers[role])transfers[role].abort();
      var controller=new AbortController();transfers[role]=controller;
      var token=++tokens[role];mutationEpoch++;delete roleErrors[role];clearFile(role);
      localFiles[role]={name:file.name,url:/\.(png|jpe?g|webp)$/i.test(file.name)?URL.createObjectURL(file):null,phase:'正在上传…'};
      busyRoles.add(role);error('');render();
      function guard(){if(token!==tokens[role]||destroyed)throw new DOMException('已取消上传','AbortError')}
      editable().then(function(){
        guard();return api('/uploads',{method:'POST',signal:controller.signal,body:{original_name:file.name,mime_type:file.type,size:file.size}});
      }).then(function(upload){
        guard();
        return new Promise(function(resolve,reject){
          var xhr=new XMLHttpRequest();
          var abort=function(){xhr.abort()};controller.signal.addEventListener('abort',abort,{once:true});
          xhr.open('POST',options.apiBase+'/uploads/'+upload.id+'/content');xhr.timeout=120000;
          xhr.upload.onprogress=function(event){if(token===tokens[role]&&event.lengthComputable){
            localFiles[role].phase='正在上传 '+Math.round(event.loaded/event.total*100)+'%';render()}};
          xhr.onload=function(){if(xhr.status>=200&&xhr.status<300)resolve();else reject(new Error('上传失败，请重试'))};
          xhr.onerror=function(){reject(new Error('网络连接失败，请重试上传'))};
          xhr.ontimeout=function(){reject(new Error('上传超时，请重试'))};
          xhr.onabort=function(){reject(new DOMException('已取消上传','AbortError'))};
          xhr.onloadend=function(){controller.signal.removeEventListener('abort',abort)};
          xhr.send(file);
        }).then(function(){guard();localFiles[role].phase='正在校验图片或文件…';render();
          return api('/uploads/'+upload.id+'/complete',{method:'POST',signal:controller.signal})})
          .then(function(){return upload});
      }).then(function(upload){
        return writeRole(role,function(){guard();
          return api('/home/intakes/'+intake.id+'/materials/'+role,{method:'PUT',body:{
            upload_id:upload.id,image_material:/\.(png|jpe?g|webp)$/i.test(file.name)}})
            .then(function(value){if(token===tokens[role]){if(role==='job'){$('#home-job-link').value='';linkDirty=false;clearLinkDraft()}clearFile(role);acceptRole(value,role)}});
        });
      }).catch(function(e){if(token===tokens[role]&&e.name!=='AbortError'){roleErrors[role]=e.message;error(e.message)}})
        .finally(function(){if(token===tokens[role]){delete transfers[role];busyRoles.delete(role);mutationEpoch++;render();schedulePoll()}});
    }
    function validateLink(){
      var url=$('#home-job-link').value.trim();
      if(started)return;
      if(!url){
        validatingLink=false;
        if(intake&&intake.materials.job.kind==='link'){
          busyRoles.add('job');render();
          editable().then(function(){return api('/home/intakes/'+intake.id+'/materials/job',{method:'DELETE'})})
            .then(function(value){linkDirty=false;clearLinkDraft();setIntake(value)})
            .catch(function(e){error(e.message)}).finally(function(){busyRoles.delete('job');render()});
        }else{linkDirty=false;clearLinkDraft();render()}
        return;
      }
      var token=++tokens.job;mutationEpoch++;delete roleErrors.job;validatingLink=true;busyRoles.add('job');error('');render();
      editable().then(function(){return api('/home/intakes/'+intake.id+'/job-link',{method:'POST',body:{url:url}})})
        .then(function(value){if(token===tokens.job){linkDirty=value.materials.job.status!=='ready';if(!linkDirty)clearLinkDraft();acceptRole(value,'job')}})
        .catch(function(e){if(token===tokens.job){roleErrors.job=e.message;error(e.message)}})
        .finally(function(){if(token===tokens.job){validatingLink=false;busyRoles.delete('job');mutationEpoch++;render();schedulePoll()}});
    }
    function generate(instruction){
      if(started||!intake||!intake.ready||busyRoles.size||linkDirty)return;
      started=true;error('');render();var token=++generationToken;
      function guard(){if(token!==generationToken)throw new Error('本轮生成已停止')}
      // Re-generating a completed document starts an independent project. It
      // never relaxes the editor's explicit Apply boundary or overwrites it.
      Promise.resolve(result?editable():intake).then(function(){
        guard();return api('/home/intakes/'+intake.id+'/prepare',{method:'POST',body:instruction?{instruction:instruction}:{}});
      }).then(function(prepared){
        guard();
        return api('/projects/'+prepared.project_id+'/ai/messages').then(function(history){
          guard();
          var messages=history.items||[],last=messages[messages.length-1];
          if(!instruction&&last&&last.retry_message_id)return {retry_message_id:last.retry_message_id,conversation_id:prepared.conversation_id};
          return prepared.request;
        }).then(function(request){
          guard();
          schedulePoll();
          return api('/projects/'+prepared.project_id+'/ai/messages',{method:'POST',body:request});
        });
      }).then(function(){if(token===generationToken){started=false;return refresh().then(function(){return loadResult(true)})}})
        .catch(function(e){if(token===generationToken){
          error(e.message);return refresh().catch(function(){started=false;render()});
        }}).finally(function(){if(token===generationToken){render();schedulePoll()}});
    }
    function stop(){
      if(!started||!intake)return;
      generationToken++;
      var button=$('#home-stop');button.disabled=true;
      api('/projects/'+intake.project_id+'/ai/status?conversation_id='+encodeURIComponent(intake.conversation_id))
        .then(function(status){
          if(!status.running_task)return;
          return api('/projects/'+intake.project_id+'/ai/cancel',{method:'POST',body:{
            conversation_id:intake.conversation_id,run_id:status.running_task.run_id}});
        }).then(function(){started=false;error('已停止生成，材料已保留。');return refresh()})
        .catch(function(e){error(e.message)}).finally(function(){button.disabled=false;render()});
    }
    $$('[data-home-upload]').forEach(function(button){button.onclick=function(){
      $('[data-home-file="'+button.dataset.homeUpload+'"]').click();
    }});
    $$('[data-home-file]').forEach(function(input){input.onchange=function(){upload(input.dataset.homeFile,input.files);input.value=''}});
    $$('[data-home-role]').forEach(function(card){
      card.addEventListener('dragover',function(event){event.preventDefault();if(!started)card.classList.add('drag')});
      card.addEventListener('dragleave',function(event){if(!card.contains(event.relatedTarget))card.classList.remove('drag')});
      card.addEventListener('drop',function(event){event.preventDefault();card.classList.remove('drag');upload(card.dataset.homeRole,event.dataTransfer.files)});
      card.addEventListener('paste',function(event){
        var files=event.clipboardData&&event.clipboardData.files;
        if(files&&files.length){event.preventDefault();upload(card.dataset.homeRole,files)}
      });
    });
    $$('[data-home-remove]').forEach(function(button){button.onclick=function(){
      var role=button.dataset.homeRemove;if(started)return;
      if(role==='job'){clearTimeout(linkTimer);validatingLink=false}
      var token=++tokens[role];mutationEpoch++;delete roleErrors[role];
      if(transfers[role])transfers[role].abort();clearFile(role);
      localFiles[role]={phase:'正在删除…'};
      busyRoles.add(role);render();error('');
      editable().then(function(){return writeRole(role,function(){
        if(token!==tokens[role])return;
        return api('/home/intakes/'+intake.id+'/materials/'+role,{method:'DELETE'})
          .then(function(value){if(token!==tokens[role])return;
            if(role==='job'){$('#home-job-link').value='';linkDirty=false;clearLinkDraft()}
            acceptRole(value,role)});
      })}).catch(function(e){if(token===tokens[role]){roleErrors[role]=e.message;error(e.message)}})
        .finally(function(){if(token===tokens[role]){clearFile(role);busyRoles.delete(role);mutationEpoch++;render();schedulePoll()}});
    }});
    $('#home-job-link').addEventListener('input',function(){
      clearTimeout(linkTimer);++tokens.job;mutationEpoch++;delete roleErrors.job;
      linkDirty=Boolean(this.value.trim()||(intake&&intake.materials.job.kind==='link'));
      try{sessionStorage.setItem(linkDraftKey,this.value)}catch(_){}
      // An edited URL invalidates local readiness immediately, before debounce.
      if(intake&&intake.materials.job.kind==='link'){intake.ready=false;intake.materials.job.status='checking'}
      render();
      linkTimer=setTimeout(validateLink,650);
    });
    $('#home-job-link').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();clearTimeout(linkTimer);validateLink()}});
    function closeLayouts(){var dialog=$('#home-layout-dialog');if(dialog.open)dialog.close();$('#home-layout-toggle').setAttribute('aria-expanded','false')}
    function resetLayoutPreview(){
      $('#home-layout-options').hidden=false;$('#home-layout-enlarged').hidden=true;
      $('#home-layout-full-image').removeAttribute('src');previewLayout=null;
      if(layoutItems.length)$('#home-layout-load-status').textContent='';
      if(previewOpener&&previewOpener.isConnected)previewOpener.focus();
    }
    function selectLayout(item){
      if(started||busyRoles.has('layout'))return;
      mutationEpoch++;delete roleErrors.layout;clearFile('layout');
      busyRoles.add('layout');render();error('');$('#home-layout-use').disabled=true;
      editable().then(function(){return api('/home/intakes/'+intake.id+'/materials/layout',{method:'PUT',body:{layout_id:item.id}})})
        .then(function(value){acceptRole(value,'layout');busyRoles.delete('layout');render();closeLayouts()})
        .catch(function(e){$('#home-layout-load-status').textContent=e.message;error(e.message)})
        .finally(function(){busyRoles.delete('layout');$('#home-layout-use').disabled=false;render()});
    }
    function loadLayouts(){
      if(layoutLoading)return layoutLoading;
      var status=$('#home-layout-load-status');status.textContent='正在加载样式…';$('#home-layout-retry').hidden=true;
      layoutLoading=api('/home/layouts').then(function(response){
        if(destroyed)return;
        layoutItems=response.items.map(function(item){return Object.assign({},item,{
          preview_url:resourceUrl(item.preview_url),image_url:resourceUrl(item.image_url)
        })});var list=$('#home-layout-options');list.replaceChildren();status.textContent='';
        layoutItems.forEach(function(item){
          var card=document.createElement('article');card.className='home-layout-card';
          var zoom=document.createElement('button');zoom.type='button';zoom.className='home-layout-image-button';
          zoom.setAttribute('aria-label','放大查看 '+item.name);
          var image=document.createElement('img');image.src=item.preview_url;image.alt=item.name+'版式预览';image.decoding='async';
          var loading=document.createElement('span');loading.className='home-layout-image-status';loading.textContent='加载预览…';
          var button=document.createElement('button');button.type='button';button.className='home-layout-option';
          button.dataset.layoutId=item.id;button.setAttribute('aria-pressed','false');button.textContent=item.name;button.disabled=true;
          button.setAttribute('aria-label','预览 '+item.name);
          image.onload=function(){zoom.dataset.loaded='true';button.dataset.imageReady='true';render()};
          image.onerror=function(){zoom.dataset.loaded='false';loading.textContent='加载失败，点击重试';button.dataset.imageReady='false';render()};
          zoom.onclick=function(opener){
            if(zoom.dataset.loaded!=='true'){loading.textContent='重新加载…';image.src=item.preview_url+'&retry='+Date.now();return}
            previewOpener=opener&&opener.nodeType===1?opener:zoom;previewLayout=item;$('#home-layout-options').hidden=true;$('#home-layout-enlarged').hidden=false;
            var full=$('#home-layout-full-image');full.hidden=true;full.style.width='min(100%, '+Math.min(item.width||820,1000)+'px)';full.alt=item.name+'完整样式参考';$('#home-layout-use').disabled=true;
            status.textContent='正在加载完整预览…';
            full.onload=function(){if(previewLayout===item){full.hidden=false;status.textContent='';$('#home-layout-use').disabled=started||busyRoles.has('layout')}};
            full.onerror=function(){if(previewLayout===item){status.textContent='完整预览暂时无法加载，请返回后重试';$('#home-layout-use').disabled=true}};
            full.src=item.image_url;$('#home-layout-back').focus();
          };
          button.onclick=function(){zoom.onclick(button)};
          var attribution=document.createElement('p');attribution.className='home-layout-attribution';attribution.textContent=item.attribution;
          zoom.append(image,loading);card.append(zoom,button,attribution);list.appendChild(card);
        });render();
      }).catch(function(e){status.textContent='样式暂时无法加载：'+e.message;$('#home-layout-retry').hidden=false})
        .finally(function(){layoutLoading=null});
      return layoutLoading;
    }
    $('#home-layout-toggle').onclick=function(){
      resetLayoutPreview();$('#home-layout-dialog').showModal();this.setAttribute('aria-expanded','true');
      $('#home-layout-close').focus();if(!layoutItems.length)loadLayouts();
    };
    $('#home-layout-close').onclick=closeLayouts;
    $('#home-layout-dialog').addEventListener('close',function(){$('#home-layout-toggle').setAttribute('aria-expanded','false');$('#home-layout-toggle').focus()});
    $('#home-layout-dialog').addEventListener('cancel',function(event){if(previewLayout){event.preventDefault();resetLayoutPreview()}});
    $('#home-layout-dialog').addEventListener('click',function(event){
      if(event.target!==this)return;var rect=this.getBoundingClientRect();
      if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeLayouts();
    });
    $('#home-layout-back').onclick=resetLayoutPreview;
    $('#home-layout-use').onclick=function(){if(previewLayout)selectLayout(previewLayout)};
    $('#home-layout-selected').onclick=function(){
      var selected=intake&&intake.materials.layout.layout_id;
      var item=selected&&layoutItems.find(function(layout){return layout.id===selected});
      if(!item||!global.ResumeImagePreview)return;
      if(!imagePreview)imagePreview=global.ResumeImagePreview.create({apiBase:options.apiBase});
      imagePreview.open({url:item.image_url,name:item.name,opener:this});
    };
    $('#home-layout-selected').onkeydown=function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}};
    $('#home-layout-retry').onclick=loadLayouts;
    function openResult(){
      if(!result)return;var dialog=$('#home-result-modal');
      if(!dialog.open)dialog.showModal();
      options.hydrate($('#home-result-document'));$('#home-result-title').focus({preventScroll:true});
    }
    $('#home-result-open').onclick=openResult;
    $('#home-result-close').onclick=function(){$('#home-result-modal').close()};
    $('#home-result-modal').addEventListener('close',function(){if(!destroyed)$('#home-result-open').focus()});
    $('#home-result-modal').addEventListener('click',function(event){
      if(event.target!==this)return;var rect=this.getBoundingClientRect();
      if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)this.close();
    });
    $('#home-submit').onclick=function(){generate()};$('#home-stop').onclick=stop;
    $('#home-question-send').onclick=function(){
      var text=$('#home-followup').value;
      if(!text.trim()){error('请补充回答，或替换上方材料。');$('#home-followup').focus();return}
      generate(text);
    };
    $('#home-followup').addEventListener('input',function(){
      if(intake)try{sessionStorage.setItem('resumeHomeFollowup:'+intake.id,this.value)}catch(_){}
    });
    $('#home-followup').addEventListener('keydown',function(event){
      if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#home-question-send').click()}
    });
    $('#home-question-editor').onclick=function(){if(intake&&!started)options.navigate('?project='+encodeURIComponent(intake.project_id))};
    $('#home-continue').onclick=function(){if(result)options.navigate('?project='+encodeURIComponent(result.projectId))};
    $$('[data-home-download]').forEach(function(button){button.onclick=function(){
      if(!result)return;var current=result,format=button.dataset.homeDownload;button.disabled=true;error('');
      fetch(options.apiBase+'/projects/'+current.projectId+'/resume-draft/download?format='+format+'&revision='+current.revision)
        .then(function(response){if(!response.ok)return response.json().then(function(value){throw new Error(value.detail||'下载失败')});return response.blob()})
        .then(function(blob){var url=URL.createObjectURL(blob),link=document.createElement('a');
          link.href=url;link.download=current.name+'.'+format;document.body.appendChild(link);link.click();link.remove();
          setTimeout(function(){URL.revokeObjectURL(url)},30000);
        }).catch(function(e){error(e.message)}).finally(function(){button.disabled=false});
    }});
    return { start: function(){
      render();
      var stored;try{stored=sessionStorage.getItem(savedKey)}catch(_){}
      var newRequest=new URLSearchParams(location.search).get('new');
      var layouts=loadLayouts();
      var restoring=(newRequest
        ?api('/home/intakes',{method:'POST',idemKey:'home-another-'+newRequest,
          body:stored?{copy_intake_id:stored}:{}})
        :stored?api('/home/intakes/'+stored):Promise.resolve(null)).then(function(value){
        if(!value)return;
        if(newRequest){clearLinkDraft();$('#home-followup').value=''}
        setIntake(value);
        if(intake.materials.job.kind==='link')$('#home-job-link').value=intake.materials.job.url||'';
        return refresh();
      }).catch(function(e){
        if(e.code==='NOT_FOUND'){try{sessionStorage.removeItem(savedKey);sessionStorage.removeItem(newKey)}catch(_){}}
        error('之前的材料暂时无法恢复：'+e.message);
      });
      return Promise.all([layouts,restoring]).then(function(){
        var pending;try{pending=sessionStorage.getItem(linkDraftKey)}catch(_){}
        if(pending!==null&&pending!==undefined&&!started){
          $('#home-job-link').value=pending;linkDirty=true;render();
          linkTimer=setTimeout(validateLink,250);
        }
      }).catch(function(e){error(e.message)});
    }, refresh:refresh, destroy:function(){destroyed=true;closeLayouts();clearTimeout(pollTimer);clearTimeout(linkTimer);
      if($('#home-result-modal').open)$('#home-result-modal').close();
      Object.keys(transfers).forEach(function(role){transfers[role].abort()});Object.keys(localFiles).forEach(clearFile);
      if(imagePreview)imagePreview.destroy()},
    getState:function(){return {intake:intake,started:started,result:result,busy:Array.from(busyRoles)}} };
  }};
})(window);
