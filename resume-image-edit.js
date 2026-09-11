(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResumeImageEdit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function canReplaceImage(document, nodeId) {
    var found = null, blocked = false;
    function walk(node, parents) {
      if (!node) return;
      if (String(node.id) === String(nodeId)) {
        found = node;
        blocked = parents.concat(node).some(function (entry) {
          var attributes = entry.attributes || {};
          return Object.keys(attributes).some(function (key) {
            return /^data-(?:scene-background|page-background|scan-background)/.test(key);
          }) || ['page_background', 'scene_background', 'scanned_page'].includes(entry.semantic && entry.semantic.kind);
        });
      }
      (node.children || []).forEach(function (child) { walk(child, parents.concat(node)); });
    }
    walk(document && document.root, []);
    if (!found || found.tag !== 'img' || blocked) return false;
    var attributes = found.attributes || {};
    return attributes.role !== 'presentation' && attributes['aria-hidden'] !== 'true'
      && !/scene-background|page-background/.test(attributes.class || '');
  }
  function install(deps) {
    var host = document.querySelector('#resume-document');
    if (!host) return;
    var style = document.createElement('style');
    style.textContent = '#resume-image-dialog{border:1px solid #dce2e7;border-radius:12px;padding:22px;width:min(400px,calc(100vw - 40px));color:inherit;background:#fff;box-shadow:0 16px 60px #0002}#resume-image-dialog::backdrop{background:#15203055}#resume-image-dialog h2{font-size:18px;margin:0 0 12px}#resume-image-dialog p{font-size:13px;line-height:1.6;color:#69747b}#resume-image-dialog img{display:block;max-width:100%;height:160px;object-fit:contain;margin:12px auto}#resume-image-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}#resume-image-dialog input{max-width:100%}#resume-image-dialog [data-error]{color:#b42318}#resume-document img[data-image-replaceable=true]{cursor:pointer}';
    document.head.appendChild(style);
    var dialog = document.createElement('dialog');
    dialog.id = 'resume-image-dialog';
    dialog.innerHTML = '<h2>更换图片</h2><img alt="当前图片"><p>上传新图片后保留当前位置和尺寸。可使用撤销恢复原图。</p><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择替换图片"><p data-error role="status" aria-live="polite" hidden></p><footer><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn primary" data-save disabled>更换图片</button></footer>';
    document.body.appendChild(dialog);
    var input = dialog.querySelector('input'), save = dialog.querySelector('[data-save]');
    var cancel = dialog.querySelector('[data-cancel]'), preview = dialog.querySelector('img');
    var error = dialog.querySelector('[data-error]'), selected = null, target = null, busy = false, previewUrl = null;
    function releasePreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
    function close() { if (busy) return; dialog.close(); releasePreview(); selected = target = null; input.value = ''; }
    function showError(message) { error.textContent = message || ''; error.hidden = !message; }
    function open(image) {
      var state = deps.state(), nodeId = image.dataset.nodeId;
      if (!state || !canReplaceImage(state.document, nodeId)) {
        deps.notify('整页扫描背景不能直接更换，请通过 AI 调整或提供独立照片'); return;
      }
      if (busy) return;
      releasePreview(); target = { nodeId: nodeId, projectId: state.projectId };
      selected = null; input.value = ''; save.disabled = true; showError('');
      preview.src = image.currentSrc || image.src;
      dialog.showModal();
    }
    host.addEventListener('click', function (event) {
      var image = event.target.closest('img[data-node-id]');
      if (!image || !host.contains(image)) return;
      event.preventDefault(); event.stopPropagation(); open(image);
    }, true);
    host.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('img[data-image-replaceable=true]')) {
        event.preventDefault(); event.stopPropagation(); open(event.target);
      }
    }, true);
    function hydrate() {
      var state = deps.state();
      if (!state) return;
      host.querySelectorAll('img[data-node-id]').forEach(function (image) {
        if (!canReplaceImage(state.document, image.dataset.nodeId)) return;
        image.dataset.imageReplaceable = 'true';
        image.tabIndex = 0; image.setAttribute('role', 'button');
        image.setAttribute('aria-label', (image.alt || '简历图片') + '，点击更换图片');
        image.title = '点击更换图片';
      });
    }
    new MutationObserver(hydrate).observe(host, { childList: true, subtree: true });
    hydrate();
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) close(); });
    input.addEventListener('change', function () {
      releasePreview(); selected = input.files[0] || null; showError('');
      if (selected && (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) || selected.size > 20 * 1024 * 1024)) {
        selected = null; showError('请选择不超过 20 MB 的 PNG、JPG 或 WEBP 图片');
      }
      save.disabled = !selected;
      if (selected) { previewUrl = URL.createObjectURL(selected); preview.src = previewUrl; }
    });
    save.addEventListener('click', async function () {
      if (!selected || !target || busy) return;
      busy = true; save.disabled = true; cancel.disabled = true; input.disabled = true;
      save.textContent = '正在保存…'; showError('');
      var uploadId = null, succeeded = false;
      try {
        await deps.flush();
        var state = deps.state();
        if (state.projectId !== target.projectId) throw new Error('当前简历已切换，请重新选择图片');
        var revision = state.revision, mutationId = deps.uid();
        uploadId = await deps.upload(selected);
        var result = await deps.api('/projects/' + target.projectId + '/resume-draft/images/' + encodeURIComponent(target.nodeId), {
          method: 'POST', body: { upload_id: uploadId, expected_revision: revision, mutation_id: mutationId },
        });
        await deps.applied(result);
        succeeded = true; deps.notify('图片已更换并自动保存，可撤销');
      } catch (failure) {
        showError(failure.message || '图片更换失败，请重试');
        if (failure.code === 'REVISION_CONFLICT') await deps.refresh().catch(function () {});
      } finally {
        if (uploadId) deps.api('/uploads/' + uploadId, { method: 'DELETE' }).catch(function () {});
        busy = false; save.disabled = !selected; cancel.disabled = false; input.disabled = false;
        save.textContent = '更换图片';
        if (succeeded) close();
      }
    });
    return { isBusy: function () { return busy; } };
  }
  return { canReplaceImage: canReplaceImage, install: install };
});
