// src/chat.js — 互动问答

YTX.features.chat = {
  tab: { key: 'chat', label: '问问AI', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
  prefix: 'CHAT',
  contentId: 'ytx-content-chat',
  actionsId: 'ytx-actions-chat',
  displayMode: 'flex',

  // 状态
  messages: [],
  replyText: '',
  isChatting: false,

  reset: function () {
    this.messages = [];
    this.replyText = '';
    this.isChatting = false;
    this.requestId = null;
  },

  actionsHtml: function () {
    return '<button id="ytx-clear-chat" class="ytx-btn ytx-btn-icon ytx-btn-secondary" title="清空对话">' + YTX.icons.trash + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-chat-messages" id="ytx-chat-messages">' +
             '<div class="ytx-empty">基于视频内容提问，AI 助教为你解答</div>' +
           '</div>' +
           '<div class="ytx-chat-input-wrap">' +
             '<input type="text" id="ytx-chat-input" placeholder="输入你的问题..." />' +
             '<button id="ytx-chat-send" class="ytx-btn ytx-btn-primary">发送</button>' +
           '</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-chat-send').addEventListener('click', function () { self.send(); });
    panel.querySelector('#ytx-chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.send(); }
    });
    panel.querySelector('#ytx-clear-chat').addEventListener('click', function () { self.clear(); });
  },

  send: async function () {
    if (this.isChatting || !YTX.panel) return;
    var input = YTX.panel.querySelector('#ytx-chat-input');
    var question = input.value.trim();
    if (!question) return;

    input.value = '';
    this.isChatting = true;
    this.replyText = '';
    var sendBtn = YTX.panel.querySelector('#ytx-chat-send');
    sendBtn.disabled = true;

    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    var empty = msgContainer.querySelector('.ytx-empty');
    if (empty) empty.remove();

    // 添加用户消息气泡
    var userBubble = document.createElement('div');
    userBubble.className = 'ytx-chat-bubble ytx-chat-user';
    userBubble.textContent = question;
    msgContainer.appendChild(userBubble);

    // 添加 AI 回复气泡（流式填充）
    var aiBubble = document.createElement('div');
    aiBubble.className = 'ytx-chat-bubble ytx-chat-ai';
    aiBubble.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div></div>';
    msgContainer.appendChild(aiBubble);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    this.messages.push({ role: 'user', content: question });
    // 保留最近 40 条消息（约 20 轮对话），防止超 token 限制
    if (this.messages.length > 40) this.messages = this.messages.slice(-40);

    var startVideoId = YTX.currentVideoId;

    try {
      aiBubble.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div><span>获取字幕中...</span></div>';
      await YTX.ensureTranscript();
      if (YTX.currentVideoId !== startVideoId) { this.isChatting = false; return; }

      var settings = await YTX.getSettings();
      if (YTX.currentVideoId !== startVideoId) { this.isChatting = false; return; }
      var payload = YTX.getContentPayload();

      this.requestId = YTX.makeRequestId();
      chrome.runtime.sendMessage(Object.assign({
        type: 'CHAT_ASK',
        messages: this.messages,
        provider: settings.provider,
        model: settings.model,
        requestId: this.requestId,
      }, payload));
    } catch (err) {
      if (YTX.currentVideoId !== startVideoId) { this.isChatting = false; return; }
      aiBubble.innerHTML = '<span class="ytx-chat-err">' + err.message + '</span>';
      this.isChatting = false;
      sendBtn.disabled = false;
    }
  },

  onChunk: function (text) {
    var aiBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
    if (aiBubble) {
      if (this.replyText === '' || aiBubble.querySelector('.ytx-loading')) {
        aiBubble.innerHTML = '';
      }
      this.replyText += text;
      aiBubble.innerHTML = YTX.renderMarkdown(this.replyText);
      var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  },

  onDone: function () {
    this.messages.push({ role: 'assistant', content: this.replyText });
    this.isChatting = false;
    YTX.panel.querySelector('#ytx-chat-send').disabled = false;
    YTX.panel.querySelector('#ytx-chat-input').focus();
  },

  onError: function (error) {
    var aiBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
    if (aiBubble) aiBubble.innerHTML = '<span class="ytx-chat-err">' + error + '</span>';
    this.isChatting = false;
    YTX.panel.querySelector('#ytx-chat-send').disabled = false;
  },

  clear: function () {
    this.messages = [];
    this.replyText = '';
    if (!YTX.panel) return;
    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    msgContainer.innerHTML = '<div class="ytx-empty">基于视频内容提问，AI 助教为你解答</div>';
  },
};
