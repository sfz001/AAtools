// src/summary.js — 总结功能

YTX.features.summary = {
  tab: { key: 'summary', label: '总结', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>' },
  prefix: 'SUMMARY',
  contentId: 'ytx-content',
  actionsId: 'ytx-actions-summary',
  displayMode: 'block',

  // 状态
  text: '',
  isGenerating: false,
  _renderTimer: null,

  reset: function () {
    this.text = '';
    this.isGenerating = false;
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    this.requestId = null;
    if (this._deferred) { this._deferred.reject(new Error('视频已切换')); this._deferred = null; }
  },

  actionsHtml: function () {
    return '<button id="ytx-generate-all" class="ytx-btn ytx-btn-icon ytx-btn-primary" title="一键生成">' + YTX.icons.zap + '</button>' +
           '<button id="ytx-summarize" class="ytx-btn ytx-btn-icon ytx-btn-secondary" title="总结视频">' + YTX.icons.play + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-empty">点击「总结视频」获取 AI 总结</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-summarize').addEventListener('click', function () { self.start().catch(function () {}); });
    panel.querySelector('#ytx-generate-all').addEventListener('click', function () { YTX.generateAll(); });
  },

  start: function () {
    var self = this;
    if (this.isGenerating) return Promise.resolve();
    this.isGenerating = true;
    this.text = '';

    // 旧 deferred 让位（理论上 isGenerating 已挡住，但安全起见）
    if (this._deferred) this._deferred.reject(new Error('已被新请求覆盖'));
    this._deferred = YTX.createDeferred();
    var deferred = this._deferred;

    var startVideoId = YTX.currentVideoId; // 早绑定

    var btn = YTX.panel.querySelector('#ytx-summarize');
    var contentEl = YTX.panel.querySelector('#ytx-content');

    btn.disabled = true;
    btn.innerHTML = YTX.icons.spinner;
    contentEl.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div><span>正在获取字幕...</span></div>';

    function bailSilently() {
      self.isGenerating = false;
      if (self._deferred === deferred) { deferred.resolve(); self._deferred = null; }
    }

    (async function () {
      try {
        await YTX.ensureTranscript();
        if (YTX.currentVideoId !== startVideoId) return bailSilently();

        contentEl.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div><span>正在生成总结...</span></div>';

        var settings = await YTX.getSettings();
        if (YTX.currentVideoId !== startVideoId) return bailSilently();
        var payload = YTX.getContentPayload();

        self.requestId = YTX.makeRequestId();
        chrome.runtime.sendMessage(Object.assign({
          type: 'SUMMARIZE',
          prompt: settings.prompt || YTX.prompts.DEFAULT,
          provider: settings.provider,
          model: settings.model,
          requestId: self.requestId,
        }, payload));
        // deferred 由 onDone/onError 触发
      } catch (err) {
        if (YTX.currentVideoId !== startVideoId) return bailSilently();
        contentEl.innerHTML = '<div class="ytx-error">' + err.message + '</div>';
        btn.disabled = false;
        YTX.btnPrimary(btn);
        self.isGenerating = false;
        if (self._deferred === deferred) { deferred.reject(err); self._deferred = null; }
      }
    })();

    return deferred.promise;
  },

  onChunk: function (text) {
    var self = this;
    var contentEl = YTX.panel.querySelector('#ytx-content');
    if (this.text === '' || contentEl.querySelector('.ytx-loading')) {
      contentEl.innerHTML = '';
    }
    this.text += text;
    // 节流渲染：最多每 80ms 刷新一次，保留滚动位置
    if (!this._renderTimer) {
      this._renderTimer = setTimeout(function () {
        self._renderTimer = null;
        var el = YTX.panel.querySelector('#ytx-content');
        var scrollTop = el.scrollTop;
        el.innerHTML = YTX.renderMarkdown(self.text);
        el.scrollTop = scrollTop;
      }, 80);
    }
  },

  onDone: function () {
    // 清除节流计时器，立即渲染最终结果
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    this.renderFinal();

    YTX.panel.querySelector('#ytx-summarize').disabled = false;
    YTX.btnRefresh(YTX.panel.querySelector('#ytx-summarize'));
    this.isGenerating = false;
    YTX.cache.save(YTX.currentVideoId, 'summary', { text: this.text });
    if (this._deferred) { this._deferred.resolve(); this._deferred = null; }
  },

  renderFinal: function () {
    var self = this;
    var contentEl = YTX.panel.querySelector('#ytx-content');
    var scrollTop = contentEl.scrollTop;
    contentEl.innerHTML =
      '<div class="ytx-summary-toolbar">' +
        '<span class="ytx-mm-toolbar-spacer"></span>' +
        '<button class="ytx-mm-tool-btn" data-action="download-md">下载 MD</button>' +
        '<button class="ytx-mm-tool-btn" data-action="export-obsidian">导出 Obsidian</button>' +
      '</div>' +
      YTX.renderMarkdown(self.text);
    contentEl.scrollTop = scrollTop;
    contentEl.querySelectorAll('.ytx-mm-tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.dataset.action;
        if (action === 'download-md') self.downloadMd();
        else if (action === 'export-obsidian') self.exportObsidian();
      });
    });
  },

  downloadMd: function () {
    var title = YTX.Export.getVideoTitle() + ' - 总结';
    YTX.Export.downloadMarkdown(this.text, YTX.Export.getSafeFilename(title));
    var btn = YTX.panel.querySelector('#ytx-content .ytx-mm-tool-btn[data-action="download-md"]');
    if (btn) YTX.Export.flashButton(btn, '已下载', 1500);
  },

  exportObsidian: function () {
    var title = YTX.Export.getVideoTitle() + ' - 总结';
    YTX.Export.downloadObsidian(this.text, title);
    var btn = YTX.panel.querySelector('#ytx-content .ytx-mm-tool-btn[data-action="export-obsidian"]');
    if (btn) YTX.Export.flashButton(btn, '已导出', 1500);
  },

  onError: function (error) {
    YTX.panel.querySelector('#ytx-content').innerHTML = '<div class="ytx-error">' + error + '</div>';
    YTX.panel.querySelector('#ytx-summarize').disabled = false;
    YTX.btnPrimary(YTX.panel.querySelector('#ytx-summarize'));
    this.isGenerating = false;
    if (this._deferred) { this._deferred.reject(new Error(error)); this._deferred = null; }
  },

};
