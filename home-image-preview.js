(function(global){
  'use strict';
  // Read-only private material image viewer. It never applies/imports an image.
  var styleId='resume-home-image-preview-style';
  function installStyle(){
    if(document.getElementById(styleId))return;
    var style=document.createElement('style');style.id=styleId;
    style.textContent='.home-image-preview{box-sizing:border-box;width:min(1060px,calc(100vw - 32px));max-height:92dvh;border:1px solid #dfe3da;border-radius:16px;padding:20px;background:#f7f8f4;color:#30382d;box-shadow:0 24px 100px #18231b30}.home-image-preview::backdrop{background:#1a231c66}.home-image-preview header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.home-image-preview h2{margin:0;min-width:0;overflow-wrap:anywhere;font-size:17px;font-weight:550}.home-image-preview button{border:1px solid #d7ddd0;border-radius:8px;padding:9px 13px;background:transparent;color:#43513a;font:inherit;font-size:13px;cursor:pointer}.home-image-preview button:focus-visible{outline:2px solid #788d69;outline-offset:3px}.home-image-preview button:disabled{opacity:.5;cursor:not-allowed}.home-image-preview-controls{display:flex;flex-shrink:0;gap:8px}.home-image-preview-status{margin:18px 0;font-size:13px;color:#68765e}.home-image-preview-status[role=alert]{color:#a24035}.home-image-preview-canvas{overflow:auto;max-height:75dvh;text-align:center;overscroll-behavior:contain}.home-image-preview-canvas img{display:block;width:auto;max-width:100%;height:auto;margin:0 auto;background:#fff}.home-image-preview-canvas[data-original=true] img{max-width:none;margin:0}.home-image-preview [hidden]{display:none!important}@media(max-width:600px){.home-image-preview{padding:15px;width:calc(100vw - 20px)}.home-image-preview header{align-items:flex-start;gap:10px}.home-image-preview-controls{flex-direction:column}.home-image-preview-canvas{max-height:72dvh}}';
    document.head.appendChild(style);
  }
  global.ResumeImagePreview={create:function(options){
    options=options||{};installStyle();
    var base=new URL(options.apiBase||'/api/v1',location.href);
    if(base.origin!==location.origin)throw new Error('图片预览仅支持当前服务');
    var prefix=base.pathname.replace(/\/$/,'');
    var dialog=document.createElement('dialog');dialog.className='home-image-preview';
    var heading=document.createElement('h2');heading.id='home-image-preview-title-'+Math.random().toString(36).slice(2);
    dialog.setAttribute('aria-labelledby',heading.id);
    var header=document.createElement('header'),controls=document.createElement('div');controls.className='home-image-preview-controls';
    var sizing=document.createElement('button');sizing.type='button';sizing.textContent='原始大小';sizing.disabled=true;
    var dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='关闭';dismiss.setAttribute('aria-label','关闭图片预览');
    controls.append(sizing,dismiss);header.append(heading,controls);
    var status=document.createElement('p');status.className='home-image-preview-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    var retry=document.createElement('button');retry.type='button';retry.textContent='重新加载';retry.hidden=true;
    var canvas=document.createElement('div');canvas.className='home-image-preview-canvas';
    var image=document.createElement('img');image.hidden=true;canvas.append(image);
    dialog.append(header,status,retry,canvas);document.body.appendChild(dialog);
    var sequence=0,controller=null,objectUrl=null,opener=null,last=null,destroyed=false;
    function release(){
      sequence++;if(controller)controller.abort();controller=null;
      image.onload=null;image.onerror=null;image.removeAttribute('src');image.hidden=true;
      if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;
    }
    function restoreFocus(){if(opener&&opener.isConnected&&typeof opener.focus==='function')opener.focus()}
    function close(){release();if(dialog.open)dialog.close();restoreFocus()}
    function controlledUrl(value){
      if(value.uploadId)return new URL(prefix+'/uploads/'+encodeURIComponent(value.uploadId)+'/preview',base.origin).href;
      var url=new URL(value.url||'',base.href);
      if(url.protocol==='blob:'&&url.origin===location.origin)return url.href;
      if(url.origin!==location.origin||!url.pathname.startsWith(prefix+'/'))throw new Error('无法打开这张图片');
      var route=url.pathname.slice(prefix.length);
      if(!/^\/(?:uploads\/[a-zA-Z0-9-]+\/preview|document-assets\/[a-zA-Z0-9-]+\/content|home\/layouts\/[a-zA-Z0-9-]+\/image)$/.test(route)){
        throw new Error('无法打开这张图片');
      }
      return url.href;
    }
    function failure(message){
      image.hidden=true;sizing.disabled=true;status.hidden=false;status.setAttribute('role','alert');
      status.textContent=message||'图片暂时无法打开，请重试';retry.hidden=false;
    }
    async function open(value){
      if(destroyed)return;
      release();last=Object.assign({opener:document.activeElement},value||{});opener=last.opener;
      var run=sequence;controller=new AbortController();heading.textContent=last.name||'图片预览';
      image.alt=last.name||'上传的图片';status.hidden=false;status.setAttribute('role','status');status.textContent='正在加载原图…';
      retry.hidden=true;sizing.disabled=true;sizing.textContent='原始大小';canvas.dataset.original='false';
      if(!dialog.open)dialog.showModal();dismiss.focus();
      try{
        var response=await fetch(controlledUrl(last),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error(response.status===404?'图片已不可用，请重新上传':'图片暂时无法打开，请重试');
        var mime=(response.headers.get('content-type')||'').split(';')[0];
        if(!/^image\/(?:png|jpeg|webp|gif)$/.test(mime))throw new Error('这个附件不是可预览的图片');
        if(Number(response.headers.get('content-length'))>32*1024*1024)throw new Error('图片过大，暂时无法预览');
        var blob=await response.blob();if(blob.size>32*1024*1024)throw new Error('图片过大，暂时无法预览');
        if(run!==sequence||destroyed)return;
        objectUrl=URL.createObjectURL(blob);
        image.onload=function(){if(run!==sequence)return;image.hidden=false;status.hidden=true;sizing.disabled=false;canvas.scrollTo(0,0)};
        image.onerror=function(){if(run===sequence)failure('图片无法解码，请更换图片')};
        image.src=objectUrl;
      }catch(error){if(run===sequence&&!destroyed&&error.name!=='AbortError')failure(error.message)}
    }
    dismiss.onclick=close;
    sizing.onclick=function(){var original=canvas.dataset.original!=='true';canvas.dataset.original=String(original);sizing.textContent=original?'适应窗口':'原始大小'};
    retry.onclick=function(){if(last)open(last)};
    dialog.addEventListener('cancel',function(event){event.preventDefault();close()});
    dialog.addEventListener('close',function(){if(!dialog.open){release();restoreFocus()}});
    dialog.addEventListener('click',function(event){if(event.target!==dialog)return;var r=dialog.getBoundingClientRect();
      if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close()});
    return {open:open,close:close,destroy:function(){destroyed=true;release();if(dialog.open)dialog.close();dialog.remove();restoreFocus()}};
  }};
})(window);
