(function(global){
  'use strict';
  var state=null,apiBase='',redirecting=false,invalidating=false,epoch=0,channel=null;
  var authVersion=0,revalidating=null,revalidationReveal=false,lifecycleInstalled=false;
  var nativeFetch=global.fetch.bind(global);
  var activeRequests=new Set(),listeners=new Set();
  function basePath(){return apiBase.replace(/api\/v1\/?$/,'')}
  function accountHeaders(){
    var result={};
    if(state&&state.csrf_token)result['X-CSRF-Token']=state.csrf_token;
    if(state&&state.authenticated&&state.user)result['X-Account-Id']=state.user.id;
    return result;
  }
  function isApi(url){
    try{var parsed=new URL(url,global.location.href);
      return parsed.origin===global.location.origin&&(parsed.pathname===apiBase||parsed.pathname.indexOf(apiBase+'/')===0);
    }catch(_){return false}
  }
  function error(message,code){var value=new Error(message);value.code=code;return value}
  function invalidate(reason){
    epoch+=1;authVersion+=1;state=null;
    activeRequests.forEach(function(controller){controller.abort()});activeRequests.clear();
    listeners.forEach(function(callback){try{callback(reason)}catch(_){}});
    global.dispatchEvent(new CustomEvent('resume:account-changed',{detail:{reason:reason}}));
  }
  function returnTarget(){
    return global.location.pathname+global.location.search;
  }
  function goLogin(){
    if(redirecting)return;redirecting=true;
    var next=returnTarget();
    global.location.replace(basePath()+'login.html?return='+encodeURIComponent(next));
  }
  async function onUnauthorized(options){
    if(redirecting||invalidating)return;
    invalidating=true;
    invalidate('expired');
    if(options&&options.beforeRedirect)await options.beforeRedirect();
    goLogin();
  }
  async function request(path,options){
    options=options||{};
    var requestEpoch=epoch,controller=new AbortController();
    var protectedRequest=state&&state.authenticated&&!/^\/auth\/(session(?:\?|$)|login$|register$)/.test(path);
    var headers=Object.assign({'Content-Type':'application/json'},accountHeaders(),options.headers||{});
    activeRequests.add(controller);
    try{
      var response=await nativeFetch(apiBase+path,{method:options.method||'GET',headers:headers,
        credentials:'same-origin',cache:'no-store',signal:controller.signal,
        body:options.body===undefined?undefined:JSON.stringify(options.body)});
      var body=await response.json().catch(function(){return null});
      if(requestEpoch!==epoch)throw new DOMException('账号已切换','AbortError');
      if(response.status===401&&protectedRequest){onUnauthorized();throw error('登录状态已失效','UNAUTHORIZED')}
      if(!response.ok)throw error(body&&body.detail||'请求未完成，请重试',body&&body.title||'HTTP_'+response.status);
      if(!body)throw error('服务返回异常，请重试','INVALID_RESPONSE');
      return body;
    }finally{activeRequests.delete(controller)}
  }
  function hidePrivatePage(){
    if(state&&state.authenticated&&global.__RESUME_ACCOUNTS_ENABLED__){
      document.documentElement.dataset.accountReady='false';
    }
  }
  async function revalidateSession(options){
    options=options||{};
    if(!state||!state.authenticated||redirecting||invalidating)return null;
    if(options.reveal){revalidationReveal=true;hidePrivatePage()}
    if(revalidating)return revalidating;
    var owner=state.user.id,version=authVersion,recheck=false;
    revalidating=(async function(){
      try{
        var fresh=await request('/auth/session?touch=0');
        if(redirecting||invalidating)return null;
        if(version!==authVersion){recheck=true;return null}
        if(!fresh.authenticated||!fresh.user||fresh.user.id!==owner){
          invalidate('changed');goLogin();return null;
        }
        state=fresh;
        if(revalidationReveal&&document.visibilityState!=='hidden'&&global.__RESUME_ACCOUNTS_ENABLED__){
          document.documentElement.dataset.accountReady='true';
        }
        return fresh;
      }catch(error){
        // Keep restored private content hidden on a failed identity check.
        // Login page then offers an explicit retry; never reveal cached data.
        if(revalidationReveal){invalidate('verification-failed');goLogin()}
        return null;
      }finally{
        var reveal=revalidationReveal;revalidationReveal=false;revalidating=null;
        if(recheck&&!redirecting&&!invalidating)revalidateSession({reveal:reveal});
      }
    })();
    return revalidating;
  }
  function installLifecycle(){
    if(lifecycleInstalled)return;lifecycleInstalled=true;
    global.addEventListener('pagehide',function(){
      hidePrivatePage();
      activeRequests.forEach(function(controller){controller.abort()});activeRequests.clear();
    });
    global.addEventListener('pageshow',function(event){
      if(event.persisted)revalidateSession({reveal:true});
    });
    document.addEventListener('visibilitychange',function(){
      if(document.visibilityState==='hidden')hidePrivatePage();
      else revalidateSession({reveal:true});
    });
    global.addEventListener('focus',function(){revalidateSession({reveal:true})});
  }
  function installTransport(){
    if(global.fetch.__resumeAccount)return;
    var wrapped=async function(input,options){
      var url=typeof input==='string'?input:input&&input.url;
      if(!isApi(url))return nativeFetch(input,options);
      var isAuth=new URL(url,global.location.href).pathname.indexOf(apiBase+'/auth/')===0;
      var requestEpoch=epoch;
      var headers=new Headers(global.Request&&input instanceof global.Request?input.headers:undefined);
      new Headers(options&&options.headers||{}).forEach(function(value,key){headers.set(key,value)});
      var attached=accountHeaders();
      Object.keys(attached).forEach(function(key){headers.set(key,attached[key])});
      var controller=new AbortController(),signal=options&&options.signal||(input&&input.signal);
      function abort(){controller.abort()}
      if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})}
      activeRequests.add(controller);
      try{
        var response=await nativeFetch(input,Object.assign({},options,{headers:headers,
          credentials:'same-origin',signal:controller.signal}));
        if(requestEpoch!==epoch)throw new DOMException('账号已切换','AbortError');
        if(response.status===401&&!isAuth){onUnauthorized();throw error('登录状态已失效','UNAUTHORIZED')}
        return response;
      }finally{activeRequests.delete(controller);if(signal)signal.removeEventListener('abort',abort)}
    };
    wrapped.__resumeAccount=true;global.fetch=wrapped;
    // Existing raw image upload paths use XHR; apply the same CSRF/owner fence.
    var originalOpen=XMLHttpRequest.prototype.open,originalSend=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(method,url){
      this.__resumeAccountApi=isApi(String(url));
      return originalOpen.apply(this,arguments);
    };
    XMLHttpRequest.prototype.send=function(){
      if(this.__resumeAccountApi){
        var xhr=this,headers=accountHeaders();
        Object.keys(headers).forEach(function(key){xhr.setRequestHeader(key,headers[key])});
        var controller={abort:function(){xhr.abort()}};
        activeRequests.add(controller);
        xhr.addEventListener('loadend',function(){
          activeRequests.delete(controller);
          if(xhr.status===401)onUnauthorized();
        },{once:true});
      }
      return originalSend.apply(this,arguments);
    };
    if(global.EventSource){
      var NativeEventSource=global.EventSource;
      var AccountEventSource=function(url,options){
        var stream=new NativeEventSource(url,options);
        if(isApi(String(url))){
          var nativeClose=stream.close.bind(stream),controller={abort:function(){stream.close()}};
          activeRequests.add(controller);
          stream.close=function(){activeRequests.delete(controller);nativeClose()};
          stream.addEventListener('error',function(){
            // Native EventSource hides HTTP 401. Ask the session endpoint before
            // allowing it to reconnect indefinitely with expired credentials.
            request('/auth/session?touch=0').then(function(result){
              if(!result.authenticated||state&&state.user&&result.user.id!==state.user.id)onUnauthorized();
            }).catch(function(){});
          });
        }
        return stream;
      };
      AccountEventSource.prototype=NativeEventSource.prototype;
      ['CONNECTING','OPEN','CLOSED'].forEach(function(key){AccountEventSource[key]=NativeEventSource[key]});
      global.EventSource=AccountEventSource;
    }
  }
  async function bootstrap(options){
    options=options||{};
    apiBase=String(options.apiBase||'').replace(/\/$/,'');
    if(!/^\/(?:[A-Za-z0-9_-]+\/)*api\/v1$/.test(apiBase))throw error('账号地址配置不正确','ACCOUNT_CONFIG');
    var response=await request('/auth/session');
    state=response;authVersion+=1;
    if(options.onInvalidate)listeners.add(options.onInvalidate);
    installTransport();
    installLifecycle();
    if(!channel&&global.BroadcastChannel){
      channel=new BroadcastChannel('resume-account-v1');
      channel.onmessage=function(event){
        if(!state||!state.authenticated)return;
        var value=event.data||{};
        if(value.type==='logout'&&value.ownerId===state.user.id||value.type==='login'&&value.ownerId!==state.user.id){
          invalidate('changed');goLogin();
        }else if((value.type==='login'||value.type==='rotation')&&value.ownerId===state.user.id){
          revalidateSession();
        }
      };
    }
    if(!response.authenticated&&!options.allowAnonymous){goLogin();throw error('请先登录','UNAUTHORIZED')}
    return response;
  }
  async function login(kind,body){
    var response=await request(kind==='register'?'/auth/register':'/auth/login',{method:'POST',body:body});
    state=response;epoch+=1;authVersion+=1;
    if(channel)channel.postMessage({type:'login',ownerId:response.user.id});
    return response;
  }
  async function logout(options){
    options=options||{};
    if(options.beforeLogout)await options.beforeLogout();
    await request('/auth/logout',{method:'POST'});
    if(channel)channel.postMessage({type:'logout',ownerId:state&&state.user&&state.user.id});
    invalidate('logout');
    if(options.afterLogout)await options.afterLogout();
    global.location.replace(basePath()+'login.html');
  }
  function safeReturn(value){
    var fallback=basePath();
    try{
      if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return fallback;
      var parsed=new URL(value,global.location.origin);
      if(parsed.origin!==global.location.origin||!parsed.pathname.startsWith(fallback)
        ||parsed.pathname.endsWith('login.html')||parsed.pathname.indexOf('/api/')>=0)return fallback;
      return parsed.pathname+parsed.search;
    }catch(_){return fallback}
  }
  global.ResumeAccount={bootstrap:bootstrap,request:request,login:login,logout:logout,
    csrfHeaders:accountHeaders,accountHeaders:accountHeaders,onUnauthorized:onUnauthorized,safeReturn:safeReturn,
    updateSession:function(value){if(!value||!value.authenticated||!value.user)throw error('账号状态不正确','ACCOUNT_STATE');
      state=value;authVersion+=1;if(channel)channel.postMessage({type:'rotation',ownerId:value.user.id});return value},
    revalidateSession:revalidateSession,
    session:function(){return state},
    storageKey:function(key){if(!state||!state.authenticated)throw error('请先登录','UNAUTHORIZED');
      return 'resumeAccount:'+state.user.id+':'+key},
    onInvalidate:function(callback){listeners.add(callback);return function(){listeners.delete(callback)}}
  };
})(window);
