// src/cards.js — 知识卡片

YTX.features.cards = {
  tab: { key: 'cards', label: '卡片', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>' },
  prefix: 'CARDS',
  contentId: 'ytx-content-cards',
  actionsId: 'ytx-actions-cards',
  displayMode: 'flex',

  // 状态
  data: [],
  rawText: '',
  isGenerating: false,

  reset: function () {
    this.data = [];
    this.rawText = '';
    this.isGenerating = false;
    this.requestId = null;
    if (this._deferred) { this._deferred.reject(new Error('视频已切换')); this._deferred = null; }
  },

  actionsHtml: function () {
    return '<button id="ytx-generate-cards" class="ytx-btn ytx-btn-icon ytx-btn-primary" title="生成卡片">' + YTX.icons.play + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-empty">点击「生成卡片」提取视频中的关键知识点</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-generate-cards').addEventListener('click', function () { self.start().catch(function () {}); });
  },

  start: function () {
    var self = this;
    if (this.isGenerating) return Promise.resolve();
    this.isGenerating = true;
    this.rawText = '';
    this.data = [];

    if (this._deferred) this._deferred.reject(new Error('已被新请求覆盖'));
    this._deferred = YTX.createDeferred();
    var deferred = this._deferred;

    var startVideoId = YTX.currentVideoId;

    var btn = YTX.panel.querySelector('#ytx-generate-cards');
    var contentEl = YTX.panel.querySelector('#ytx-content-cards');
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

        contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在生成知识卡片...</span></div>';

        var settings = await YTX.getSettings();
        if (YTX.currentVideoId !== startVideoId) return bailSilently();
        var payload = YTX.getContentPayload();

        self.requestId = YTX.makeRequestId();
        chrome.runtime.sendMessage(Object.assign({
          type: 'GENERATE_CARDS',
          prompt: settings.promptCards || YTX.prompts.CARDS,
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
    this.rawText += text;
  },

  onDone: function () {
    try {
      this.data = YTX.extractJSON(this.rawText, 'array');
      if (!this.data) {
        throw new Error('AI 返回的内容不包含有效 JSON，请重新生成');
      }
      this.render();
    } catch (err) {
      YTX.parseError(YTX.panel.querySelector('#ytx-content-cards'), '卡片', err);
    }
    YTX.panel.querySelector('#ytx-generate-cards').disabled = false;
    YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-cards'));
    this.isGenerating = false;
    if (this.data && this.data.length > 0) YTX.cache.save(YTX.currentVideoId, 'cards', { data: this.data });
    if (this._deferred) { this._deferred.resolve(); this._deferred = null; }
  },

  onError: function (error) {
    YTX.panel.querySelector('#ytx-content-cards').innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + error + '</div>';
    YTX.panel.querySelector('#ytx-generate-cards').disabled = false;
    YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-cards'));
    this.isGenerating = false;
    if (this._deferred) { this._deferred.reject(new Error(error)); this._deferred = null; }
  },

  render: function () {
    if (!YTX.panel || this.data.length === 0) return;
    var contentEl = YTX.panel.querySelector('#ytx-content-cards');

    contentEl.innerHTML =
      '<div class="ytx-cards-counter">共 ' + this.data.length + ' 张卡片</div>' +
      '<div class="ytx-cards-list">' +
        this.data.map(function (card, i) {
          var safeT = YTX.safeTime(card.time);
          var tsHtml = safeT ? ' <span class="ytx-timestamp ytx-card-time" data-time="' + YTX.timeToSeconds(safeT) + '">[' + safeT + ']</span>' : '';
          return '<div class="ytx-card" data-index="' + i + '">' +
            '<div class="ytx-card-inner">' +
              '<div class="ytx-card-front">' +
                '<div class="ytx-card-label">问题' + tsHtml + '</div>' +
                '<div class="ytx-card-text">' + YTX.escapeHtml(card.front) + '</div>' +
              '</div>' +
              '<div class="ytx-card-back">' +
                '<div class="ytx-card-label">答案' + tsHtml + '</div>' +
                '<div class="ytx-card-text">' + YTX.escapeHtml(card.back) + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';

    contentEl.querySelectorAll('.ytx-card').forEach(function (cardEl) {
      cardEl.addEventListener('click', function (e) {
        if (e.target.closest('.ytx-timestamp')) return;
        cardEl.classList.toggle('flipped');
      });
    });
  },
};
