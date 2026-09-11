(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ResumeReview=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Read-only review projection. Never feed this display tree back into the
  // document, proposal, transaction, preview or export paths.
  var names={'font-size':'字号','font-family':'字体','font-weight':'粗细',color:'文字颜色',
    background:'背景','background-color':'背景色','text-align':'文字对齐','line-height':'行距',
    padding:'内边距',margin:'段落间距',gap:'内容间距',display:'排列方式',width:'宽度',height:'高度',
    'min-width':'最小宽度','max-width':'最大宽度','min-height':'最小高度','max-height':'最大高度',
    position:'位置',tag:'内容类型',editable:'文字编辑方式',semantic:'内容分组',kind:'内容分组',
    page_setup:'页面设置',styles:'整体排版',assets:'图片等资源',annotations:'辅助标记',
    'align-items':'垂直对齐','justify-content':'水平分布','flex-direction':'排列方向',
    'grid-template-columns':'分栏比例','grid-template-rows':'行布局','border-left':'左侧边线',
    'border-right':'右侧边线','border-top':'上方边线','border-bottom':'下方边线',
    'padding-left':'左侧留白','padding-right':'右侧留白','padding-top':'上方留白','padding-bottom':'下方留白',
    'margin-left':'左侧间距','margin-right':'右侧间距','margin-top':'上方间距','margin-bottom':'下方间距'};
  var values={right:'靠右',left:'靠左',center:'居中',justify:'两端对齐',flex:'弹性排列',
    grid:'网格排列',block:'分段排列',column:'纵向',row:'横向',none:'无',normal:'常规',
    bold:'加粗',true:'可编辑',false:'不可编辑',p:'段落',div:'内容区域',section:'模块',
    article:'整份简历',h1:'主标题',h2:'模块标题',h3:'小标题',ul:'无序列表',ol:'有序列表',
    li:'列表内容',table:'表格',tr:'表格行',td:'表格内容',th:'表格标题',span:'行内文字',
    document:'整份简历',page:'页面',heading:'标题',paragraph:'段落',module:'模块'};
  function editorOnly(node){
    return node&&node.type==='element'&&(String(node.attributes&&node.attributes['data-editor-only']||'')==='true'||
      node.tag==='button'&&String(node.attributes&&node.attributes.class||'').split(/\s+/).includes('ai-marker'));
  }
  function text(node){
    if(!node||editorOnly(node))return'';
    if(node.type==='text')return String(node.value||'');
    if(node.tag==='br')return '\n';
    var output=String(node.text||'');
    (node.children||[]).forEach(function(child){
      var block=child.type==='element'&&/^(p|div|li|h[1-6]|tr|section|article|ul|ol|table|blockquote)$/.test(child.tag);
      if(block&&output&&!output.endsWith('\n'))output+='\n';
      output+=text(child);
      if(block&&!output.endsWith('\n'))output+='\n';
    });
    return output.replace(/\n$/,'');
  }
  function index(doc){
    var map=new Map();
    function visit(node,parent){map.set(node.id,{node:node,parent:parent});(node.children||[]).forEach(function(c){visit(c,node)})}
    visit(doc.root,null);return map;
  }
  function render(host,before,after,preview,diffParts,resolveResourceUrl){
    var d=host.ownerDocument,old=index(before),next=index(after),changes=preview.presentation_changes||[];
    host.replaceChildren();host.classList.add('resume-review');
    function el(tag,cls,content){var e=d.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=content;return e}
    var notice=el('p','resume-review-note','在简历中查看修改：红色是删去的内容，绿色是新增内容。为方便对照，这里采用阅读排版；实际版式可查看整份预览。');
    host.appendChild(notice);
    var paper=el('article','resume-review-paper');paper.setAttribute('aria-label','完整简历修改审阅稿');host.appendChild(paper);
    function value(v){if(v===null)return'沿用默认';return values[String(v)]||(typeof v==='object'?JSON.stringify(v):String(v))}
    function presentation(container,list){
      if(!list.length)return;
      var kinds=[];
      list.forEach(function(c){
        var k=c.property==='position'?'内容位置':/^(tag|editable|semantic)(\.|$)/.test(c.property)?'内容组织':
          /^(assets)(\.|$)/.test(c.property)?'图片等资源':'排版';
        if(!kinds.includes(k))kinds.push(k);
      });
      var details=el('details','resume-review-presentation');
      var highlights=list.slice(0,3).map(function(c){
        var key=c.property.split('.')[0],label=names[key];
        if(!label)return'其他显示细节';
        return label+(/^(font-size|text-align|line-height|font-weight)$/.test(c.property)?' '+value(c.before)+' → '+value(c.after):'');
      }).filter(function(v,i,all){return all.indexOf(v)===i});
      var summary=el('summary','',kinds.join('、')+'有调整：'+highlights.join('、')+' · 查看 '+list.length+' 项详情');details.appendChild(summary);
      list.forEach(function(c){
        var line=el('div','resume-review-setting');
        var property=c.property.split('.').map(function(k){return names[k]||k}).join(' · ');
        line.appendChild(el('span','resume-review-setting-name',property+'：'));
        line.appendChild(el('del','',value(c.before)));
        line.appendChild(el('span','',' → '));line.appendChild(el('ins','',value(c.after)));
        details.appendChild(line);
      });
      container.appendChild(details);
    }
    function rows(container,a,b,kind){
      var parts=kind==='add'?[{kind:'add',text:b}]:kind==='remove'?[{kind:'remove',text:a}]:diffParts(a,b);
      parts.forEach(function(part){part.text.split('\n').forEach(function(line){
        var row=el('div','proposal-diff-row');row.dataset.diffKind=part.kind;
        row.appendChild(el(part.kind==='remove'?'del':part.kind==='add'?'ins':'span','',line));
        container.appendChild(row);
      })});
    }
    function isUnit(n){
      if(n.type==='text'||n.editable)return true;
      return !(n.children||[]).some(function(c){return c.type==='element'&&!/^(a|b|strong|em|i|u|s|span|small|br|sup|sub)$/.test(c.tag)});
    }
    function descendants(n,predicate){
      return (n.children||[]).some(function(c){return predicate(c)||descendants(c,predicate)});
    }
    function renderNode(n,parent,kind){
      if(editorOnly(n))return;
      if(n.type==='element'&&['script','style'].includes(n.tag))return;
      var prior=old.get(n.id),a=prior&&prior.node;
      var added=kind==='add'||!old.has(n.id),removed=kind==='remove';
      var type=(n.semantic&&n.semantic.kind)||n.tag||'text';
      var box=el('div','resume-review-unit');
      box.dataset.reviewNode=n.id;
      box.dataset.reviewKind=type;
      if(/^h[1-6]$/.test(n.tag)||type==='heading')box.classList.add('resume-review-heading');
      if(['section','module','page'].includes(type))box.classList.add('resume-review-section');
      if(type==='li'||type==='list_item')box.classList.add('resume-review-list-item');
      if(n.tag==='tr')box.classList.add('resume-review-table-row');
      if(n.tag==='td'||n.tag==='th')box.classList.add('resume-review-table-cell');
      parent.appendChild(box);
      if(!removed)presentation(box,changes.filter(function(c){return c.node_id===n.id}));
      // A replaced editing boundary can contain descendants retained elsewhere.
      // Do not flatten those into a false deletion/addition of their text.
      var crossBoundary=(removed&&descendants(n,function(c){return next.has(c.id)}))||
        (added&&descendants(n,function(c){return old.has(c.id)}));
      if(!removed&&!added&&a){
        var currentIds=new Set(),priorIds=new Set();
        descendants(n,function(c){currentIds.add(c.id);return false});
        descendants(a,function(c){priorIds.add(c.id);return false});
        crossBoundary=descendants(a,function(c){return next.has(c.id)&&!currentIds.has(c.id)})||
          descendants(n,function(c){return old.has(c.id)&&!priorIds.has(c.id)});
      }
      if(isUnit(n)&&!crossBoundary){
        var current=text(n),previous=a?text(a):'';
        if(current||previous)rows(box,removed?current:previous,current,removed?'remove':added?'add':null);
        // Inline formatting/resource changes still belong to this visible line.
        if(!removed){var nested=new Set();function ids(x){(x.children||[]).forEach(function(c){if(c.tag!=='img')nested.add(c.id);ids(c)})}ids(n);
          presentation(box,changes.filter(function(c){return nested.has(c.node_id)}));}
        function embeddedResources(x,resourceKind,deletedOnly){
          if(editorOnly(x))return;
          (x.children||[]).forEach(function(c){
            if(c.tag==='img'){
              var retained=next.get(c.id);
              if(!deletedOnly||!retained||retained.node.tag!=='img')renderNode(c,box,resourceKind);
            }else embeddedResources(c,resourceKind,deletedOnly);
          });
        }
        // Text flattening does not represent deleted non-text resources. Read
        // those from the old subtree, excluding resources merely moved elsewhere.
        if(a&&!removed)embeddedResources(a,'remove',true);
        embeddedResources(n,removed?'remove':null,false);
        if(n.tag==='img'){
          var imageChanged=a&&a.attributes&&n.attributes&&a.attributes.src!==n.attributes.src;
          box.appendChild(el(removed?'del':added?'ins':'span','resume-review-resource',removed?'删除图片':added?'新增图片':imageChanged?'图片已更新':'图片'));
          var src=n.attributes&&n.attributes.src;
          if(typeof src==='string'&&/^(data:image\/|https?:\/\/|\/(?!\/))/.test(src)){
            var image=el('img','resume-review-image');image.alt=removed?'删除的图片':added?'新增的图片':'简历图片';
            if(n.attributes['data-document-asset-id'])image.setAttribute('data-document-asset-id',n.attributes['data-document-asset-id']);
            image.addEventListener('error',function(){this.alt='图片加载失败，请刷新后重试';this.setAttribute('data-image-error','true')},{once:true});
            image.src=resolveResourceUrl?resolveResourceUrl(src):src;box.appendChild(image);
          }
        }
        return;
      }
      if(n.text!==undefined||a&&a.text!==undefined)rows(box,removed?String(n.text||''):String(a&&a.text||''),String(n.text||''),removed?'remove':added?'add':null);
      var children=n.children||[],beforeChildren=a&&a.children||[],pending=[];
      // Removed content is placed at its former surviving neighbour within this
      // region. Moved nodes only appear at their new location, never twice.
      beforeChildren.forEach(function(c,i){
        if(next.has(c.id))return;
        var following=beforeChildren.slice(i+1).find(function(s){return children.some(function(t){return t.id===s.id})});
        pending.push({node:c,before:following&&following.id});
      });
      children.forEach(function(c){
        if(removed&&next.has(c.id))return;
        if(!removed)pending.filter(function(x){return x.before===c.id}).forEach(function(x){renderNode(x.node,box,'remove')});
        renderNode(c,box,removed?'remove':null);
      });
      if(!removed)pending.filter(function(x){return !x.before}).forEach(function(x){renderNode(x.node,box,'remove')});
    }
    presentation(paper,changes.filter(function(c){return !c.node_id}));
    // Root IDs can change on a whole-document rewrite; keep a single paper.
    if(before.root.id!==after.root.id){
      if(before.root.text!==undefined)rows(paper,String(before.root.text),'','remove');
      (before.root.children||[]).filter(function(n){return !next.has(n.id)}).forEach(function(n){renderNode(n,paper,'remove')});
    }
    renderNode(after.root,paper,null);
    if(preview.complete&&!(preview.changes||[]).length)notice.textContent='当前正文与这版建议一致，没有差异。';
    else if(preview.before&&preview.after&&preview.before.text===preview.after.text&&changes.length){
      notice.textContent='文字未变化，标记处调整了排版或内容组织。展开查看具体变化，实际版式可查看整份预览。';
    }
    return paper;
  }
  return {render:render};
});
