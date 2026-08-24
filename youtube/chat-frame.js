(function () {
  'use strict';

  var params = new URLSearchParams(location.hash.slice(1));
  var token = params.get('token') || '';
  var videoId = params.get('videoId') || '';
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var send = document.getElementById('chat-send');
  var status = document.getElementById('chat-status');
  var busy = false;

  function setBusy(value) {
    busy = value === true;
    input.disabled = busy;
    send.disabled = busy;
    send.textContent = busy ? '发送中…' : '发送';
  }

  function setError(message) {
    status.textContent = typeof message === 'string' ? message.slice(0, 500) : '';
  }

  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(token) || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    setBusy(true);
    setError('输入框初始化失败，请重新打开面板');
    return;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var question = input.value.trim();
    if (!question) return;
    if (question.length > 10000) {
      setError('问题不能超过 10000 个字符');
      return;
    }

    setBusy(true);
    setError('');
    chrome.runtime.sendMessage({
      type: 'YTX_CHAT_FRAME_SUBMIT',
      token: token,
      videoId: videoId,
      text: question,
    }, function (response) {
      if (chrome.runtime.lastError || !response || response.ok !== true) {
        setBusy(false);
        setError((response && response.error) ||
          (chrome.runtime.lastError && chrome.runtime.lastError.message) || '发送失败，请重试');
      }
    });
  });

  input.addEventListener('keydown', function (event) {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!sender || sender.id !== chrome.runtime.id || !message ||
        message.type !== 'YTX_CHAT_FRAME_STATE' || message.token !== token ||
        message.videoId !== videoId || !message.state || typeof message.state !== 'object') return;
    var state = message.state;
    document.documentElement.toggleAttribute('dark', state.dark === true);
    if (state.clear) input.value = '';
    setBusy(state.busy === true);
    setError(typeof state.error === 'string' ? state.error : '');
    if (state.focus && !busy) input.focus({ preventScroll: true });
  });
})();
