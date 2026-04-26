// src/html-notes.js — HTML 笔记

YTX.features.html = {
  tab: { key: 'html', label: '笔记', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>' },
  prefix: 'HTML',
  contentId: 'ytx-content-html',
  actionsId: 'ytx-actions-html',
  displayMode: 'flex',

  // 状态
  text: '',
  isGenerating: false,

  reset: function () {
    this.text = '';
    this.isGenerating = false;
    this.requestId = null;
    if (this._deferred) { this._deferred.reject(new Error('视频已切换')); this._deferred = null; }
  },

  actionsHtml: function () {
    return '<button id="ytx-generate-html" class="ytx-btn ytx-btn-icon ytx-btn-primary" title="生成笔记">' + YTX.icons.play + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-empty">点击「生成笔记」将视频内容生成 HTML 笔记</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-generate-html').addEventListener('click', function () { self.start().catch(function () {}); });
  },

  start: function () {
    var self = this;
    if (this.isGenerating) return Promise.resolve();
    this.isGenerating = true;
    this.text = '';

    if (this._deferred) this._deferred.reject(new Error('已被新请求覆盖'));
    this._deferred = YTX.createDeferred();
    var deferred = this._deferred;

    var startVideoId = YTX.currentVideoId;

    var btn = YTX.panel.querySelector('#ytx-generate-html');
    var contentEl = YTX.panel.querySelector('#ytx-content-html');
    btn.disabled = true;

    function bailSilently() {
      self.isGenerating = false;
      if (self._deferred === deferred) { deferred.resolve(); self._deferred = null; }
    }

    (async function () {
      try {
        btn.innerHTML = YTX.icons.spinner;
        contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在获取字幕...</span></div>';
        await YTX.ensureTranscript();
        if (YTX.currentVideoId !== startVideoId) return bailSilently();

        btn.innerHTML = YTX.icons.spinner;
        contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在生成笔记...</span></div>';

        var settings = await YTX.getSettings();
        if (YTX.currentVideoId !== startVideoId) return bailSilently();
        var payload = YTX.getContentPayload();

        self.requestId = YTX.makeRequestId();
        chrome.runtime.sendMessage(Object.assign({
          type: 'GENERATE_HTML',
          prompt: settings.promptHtml || YTX.prompts.HTML,
          provider: settings.provider,
          model: settings.model,
          requestId: self.requestId,
        }, payload));
      } catch (err) {
        if (YTX.currentVideoId !== startVideoId) return bailSilently();
        contentEl.innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + err.message + '</div>';
        btn.disabled = false;
        YTX.btnPrimary(btn);
        self.isGenerating = false;
        if (self._deferred === deferred) { deferred.reject(err); self._deferred = null; }
      }
    })();

    return deferred.promise;
  },

  onChunk: function (text) {
    this.text += text;
  },

  onDone: function () {
    this.renderContent();
    YTX.panel.querySelector('#ytx-generate-html').disabled = false;
    YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-html'));
    this.isGenerating = false;
    YTX.cache.save(YTX.currentVideoId, 'html', { text: this.text });
    if (this._deferred) { this._deferred.resolve(); this._deferred = null; }
  },

  onError: function (error) {
    YTX.panel.querySelector('#ytx-content-html').innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + error + '</div>';
    YTX.panel.querySelector('#ytx-generate-html').disabled = false;
    YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-html'));
    this.isGenerating = false;
    if (this._deferred) { this._deferred.reject(new Error(error)); this._deferred = null; }
  },

  renderContent: function () {
    if (!YTX.panel || !this.text) return;
    var self = this;
    var contentEl = YTX.panel.querySelector('#ytx-content-html');
    contentEl.innerHTML =
      '<div class="ytx-html-toolbar">' +
        '<span class="ytx-mm-toolbar-spacer"></span>' +
        '<button class="ytx-mm-tool-btn" data-action="open-tab">新标签打开</button>' +
        '<button class="ytx-mm-tool-btn" data-action="download">下载 HTML</button>' +
        '<button class="ytx-mm-tool-btn" data-action="export-obsidian">导出 Obsidian</button>' +
      '</div>';
    var iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-same-origin';
    iframe.srcdoc = YTX.Export.sanitizeHtml(this.text);
    contentEl.appendChild(iframe);

    // iframe 加载后注入时间戳点击跳转
    iframe.addEventListener('load', function () {
      try {
        var doc = iframe.contentDocument;
        if (!doc) return;
        // 给 iframe 内所有包含时间戳格式的元素添加点击监听
        doc.addEventListener('click', function (e) {
          var el = e.target;
          // 向上查找，最多 3 层
          for (var i = 0; i < 3 && el && el !== doc.body; i++) {
            var text = (el.textContent || '').trim();
            var m = text.match(/^(\d{1,2}):(\d{2})$/);
            if (m) {
              var seconds = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
              var video = document.querySelector('video');
              if (video) { video.currentTime = seconds; video.play(); }
              e.preventDefault();
              return;
            }
            el = el.parentElement;
          }
        });
        // 遍历所有文本节点，给包含时间戳的元素加上可点击样式
        var allEls = doc.body.querySelectorAll('*');
        for (var j = 0; j < allEls.length; j++) {
          var txt = (allEls[j].textContent || '').trim();
          if (/^\d{1,2}:\d{2}$/.test(txt) && allEls[j].children.length === 0) {
            allEls[j].style.cursor = 'pointer';
          }
        }
      } catch (e) {}
    });

    contentEl.querySelectorAll('.ytx-mm-tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.dataset.action;
        if (action === 'open-tab') self.openInNewTab();
        else if (action === 'download') self.downloadHtml();
        else if (action === 'export-obsidian') self.exportObsidian();
      });
    });
  },

  openInNewTab: function () {
    var safe = YTX.Export.sanitizeHtml(this.text);
    var blob = new Blob([safe], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  },

  downloadHtml: function () {
    var title = YTX.Export.getVideoTitle();
    var filename = YTX.Export.getSafeFilename(title) + '-笔记.html';
    var safe = YTX.Export.sanitizeHtml(this.text);
    var blob = new Blob([safe], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    var btn = YTX.panel.querySelector('#ytx-content-html .ytx-mm-tool-btn[data-action="download"]');
    if (btn) YTX.Export.flashButton(btn, '已下载', 1500);
  },

  exportObsidian: function () {
    var title = YTX.Export.getVideoTitle() + ' - 笔记';
    var md = YTX.Export.htmlToMarkdown(this.text);
    YTX.Export.downloadObsidian(md, title);
    var btn = YTX.panel.querySelector('#ytx-content-html .ytx-mm-tool-btn[data-action="export-obsidian"]');
    if (btn) YTX.Export.flashButton(btn, '已导出', 1500);
  },
};
