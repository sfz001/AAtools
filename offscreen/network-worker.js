'use strict';

const ACTIVE_JOBS = new Map();
const ALLOWED_PARSE_FORMATS = new Set(['claude', 'openai', 'openai-responses', 'gemini', 'minimax', 'deepseek', 'kimi']);
const ALLOWED_PROVIDERS = new Set(['claude', 'openai', 'chatgpt', 'chatgpt-auth', 'gemini', 'minimax', 'deepseek', 'kimi', 'sub2api']);
const ALLOWED_HEADERS = new Set([
  'accept', 'authorization', 'content-type', 'x-api-key', 'x-goog-api-key',
  'anthropic-version', 'anthropic-dangerous-direct-browser-access',
  'openai-beta', 'originator', 'session_id', 'chatgpt-account-id',
]);
const DIRECT_ORIGINS = new Set([
  'https://api.anthropic.com', 'https://api.openai.com', 'https://chatgpt.com',
  'https://auth.openai.com',
  'https://generativelanguage.googleapis.com', 'https://api.minimax.io',
  'https://api.deepseek.com', 'https://api.moonshot.cn',
]);
const MAX_URL_CHARS = 4096;
const MAX_BODY_CHARS = 2_000_000;
const MAX_HEADER_VALUE_CHARS = 32_768;
const MAX_HEADER_TOTAL_CHARS = 65_536;
const MAX_ERROR_BODY_BYTES = 65_536;
const MAX_SSE_EVENT_CHARS = 2_000_000;
const MAX_SSE_TOTAL_BYTES = 8_000_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_IPC_CHUNK_CHARS = 8192;
const MAX_JSON_RESPONSE_BYTES = 600_000;

function sanitizeTerminalText(value, maxChars, fallback) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return text || fallback;
}

function postEvent(jobId, event) {
  let outbound = event;
  if (event?.kind === 'ERROR') {
    outbound = Object.assign({}, event, {
      code: sanitizeTerminalText(event.code, 64, 'network_error'),
      message: sanitizeTerminalText(event.message, 1000, '网络请求失败'),
    });
  } else if (event?.kind === 'DONE' && event.warning !== undefined) {
    outbound = Object.assign({}, event, {
      warning: sanitizeTerminalText(event.warning, 500, '模型提前结束，输出可能不完整'),
    });
  }
  self.postMessage({ type: 'EVENT', jobId, event: outbound });
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length <= max;
}

function validateNetworkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return '网络请求格式无效';
  if (!boundedText(request.url, MAX_URL_CHARS)) return '网络请求 URL 无效或过长';
  let url;
  try { url = new URL(request.url); } catch { return '网络请求 URL 无效'; }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !localHttp)) return '网络请求 URL 不安全';
  if (!boundedText(request.allowedOrigin, 512) || url.origin !== request.allowedOrigin) return '网络请求来源未获授权';
  if (!DIRECT_ORIGINS.has(url.origin) && request.provider !== 'sub2api') return '网络请求来源不在允许列表';
  if (!ALLOWED_PROVIDERS.has(request.provider)) return '网络请求服务商无效';
  const responseMode = request.responseMode || 'sse';
  if (!['sse', 'json'].includes(responseMode)) return '网络响应模式无效';
  if (responseMode === 'sse' && !ALLOWED_PARSE_FORMATS.has(request.parseAs)) return '网络请求解析格式无效';
  if (request.method !== 'POST') return '网络请求方法无效';
  if (!boundedText(request.body, MAX_BODY_CHARS)) return '网络请求体无效或过长';
  if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) return '网络请求头无效';
  const headerEntries = Object.entries(request.headers);
  if (headerEntries.length > ALLOWED_HEADERS.size) return '网络请求头数量过多';
  let headerChars = 0;
  for (const [name, value] of headerEntries) {
    const lower = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(lower) || name !== lower && name !== name.replace(/[A-Z]/g, c => c.toLowerCase())) {
      // Header names are normalized by the service worker; refusing aliases
      // keeps the allow-list unambiguous.
      if (!ALLOWED_HEADERS.has(lower)) return '网络请求头字段未获允许';
    }
    if (!boundedText(value, MAX_HEADER_VALUE_CHARS) || /[\r\n\0]/.test(value)) return '网络请求头值无效或过长';
    headerChars += name.length + value.length;
  }
  if (headerChars > MAX_HEADER_TOTAL_CHARS) return '网络请求头总长度过长';
  if (!Number.isInteger(request.maxOutputChars) || request.maxOutputChars < 1 || request.maxOutputChars > MAX_OUTPUT_CHARS) return '输出上限无效';
  if (request.provider === 'chatgpt-auth') {
    if (url.href !== 'https://auth.openai.com/oauth/token' || responseMode !== 'json') return 'OAuth 刷新端点无效';
    const entries = Object.entries(request.headers);
    if (entries.length !== 1 || entries[0][0].toLowerCase() !== 'content-type' || entries[0][1] !== 'application/json') return 'OAuth 请求头无效';
    let authBody;
    try { authBody = JSON.parse(request.body); } catch { return 'OAuth 请求体无效'; }
    const keys = Object.keys(authBody || {}).sort();
    if (keys.join(',') !== 'client_id,grant_type,refresh_token,scope' ||
        authBody.client_id !== 'app_EMoamEEZ73f0CkXaXp7hrann' || authBody.grant_type !== 'refresh_token' ||
        authBody.scope !== 'openid profile email' || !boundedText(authBody.refresh_token, 200000) || !authBody.refresh_token) {
      return 'OAuth 请求体字段无效';
    }
  }
  const timeouts = request.timeouts;
  if (!timeouts || !Number.isInteger(timeouts.firstByteMs) || !Number.isInteger(timeouts.idleMs) ||
      !Number.isInteger(timeouts.totalMs) || timeouts.firstByteMs < 1000 || timeouts.firstByteMs > 300000 ||
      timeouts.idleMs < 1000 || timeouts.idleMs > 300000 || timeouts.totalMs < 5000 || timeouts.totalMs > 3600000) {
    return '网络超时配置无效';
  }
  if (request.includeFullText !== undefined && typeof request.includeFullText !== 'boolean') return '完整结果配置无效';
  if (request.retry !== undefined) {
    const retry = request.retry;
    if (!retry || !Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 3 ||
        !Array.isArray(retry.statuses) || retry.statuses.length > 4 ||
        retry.statuses.some(status => ![429, 503].includes(status)) ||
        !Number.isInteger(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > 30000) {
      return '重试配置无效';
    }
  }
  return '';
}

function createSSEParser(onEvent, maxEventChars = MAX_SSE_EVENT_CHARS) {
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let dataChars = 0;
  let firstLine = true;
  let scanOffset = 0;

  const dispatch = () => {
    if (dataLines.length) onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
    dataChars = 0;
  };
  const processLine = (rawLine) => {
    if (rawLine.length > maxEventChars) throw new Error('SSE 单行超过安全上限');
    let line = rawLine;
    if (firstLine) {
      firstLine = false;
      if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
    }
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      if (dataChars + value.length > maxEventChars) throw new Error('SSE 单个事件超过安全上限');
      dataLines.push(value);
      dataChars += value.length + 1;
    } else if (field === 'event') eventName = value;
  };
  const drain = (eof) => {
    let consumed = 0;
    let searchFrom = Math.min(scanOffset, buffer.length);
    while (searchFrom < buffer.length) {
      let newlineAt = -1;
      let newlineLength = 1;
      for (let i = searchFrom; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n') { newlineAt = i; break; }
        if (ch === '\r') {
          if (i === buffer.length - 1 && !eof) break;
          newlineAt = i;
          newlineLength = buffer[i + 1] === '\n' ? 2 : 1;
          break;
        }
      }
      if (newlineAt < 0) {
        scanOffset = !eof && buffer.endsWith('\r') ? Math.max(consumed, buffer.length - 1) : buffer.length;
        break;
      }
      processLine(buffer.slice(consumed, newlineAt));
      consumed = newlineAt + newlineLength;
      searchFrom = consumed;
      scanOffset = consumed;
    }
    if (consumed) {
      buffer = buffer.slice(consumed);
      scanOffset = Math.max(0, scanOffset - consumed);
    }
    if (eof) {
      if (buffer.length) processLine(buffer);
      buffer = '';
      scanOffset = 0;
      dispatch();
    }
  };
  return {
    push(chunk) {
      if (!chunk) return;
      buffer += chunk;
      drain(false);
      if (buffer.length > maxEventChars) throw new Error('SSE 未换行数据超过安全上限');
    },
    finish(chunk = '') {
      if (chunk) buffer += chunk;
      if (buffer.length > maxEventChars) throw new Error('SSE 未换行数据超过安全上限');
      drain(true);
    },
  };
}

function streamErrorDetail(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const direct = value.message || value.detail || value.code || value.type;
  if (direct) return String(direct).slice(0, 500);
  try { return JSON.stringify(value).slice(0, 500); } catch { return '未知上游错误'; }
}

function streamContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    if (typeof item?.text?.value === 'string') return item.text.value;
    return '';
  }).join('');
  if (typeof content?.text === 'string') return content.text;
  return '';
}

function analyzeStreamPayload(provider, parsed, eventName) {
  const result = { text: '', terminal: false, error: '', abnormal: '' };
  const type = parsed?.type || eventName;
  if (parsed?.error || type === 'error' || eventName === 'error') {
    result.error = '上游流式错误：' + streamErrorDetail(parsed?.error || parsed);
    return result;
  }
  if (parsed?.base_resp && Number(parsed.base_resp.status_code || 0) !== 0) {
    result.error = 'MiniMax 上游错误：' + streamErrorDetail(parsed.base_resp.status_msg || parsed.base_resp);
    return result;
  }
  if (['openai', 'minimax', 'deepseek', 'kimi'].includes(provider)) {
    const choice = parsed?.choices?.[0];
    result.text = streamContentText(choice?.delta?.content);
    const finish = choice?.finish_reason;
    if (finish) {
      if (finish === 'stop') result.terminal = true;
      else result.abnormal = `模型异常结束（finish_reason=${finish}），输出可能不完整`;
    }
    return result;
  }
  if (provider === 'openai-responses') {
    if (parsed?.choices) return analyzeStreamPayload('openai', parsed, eventName);
    if (type === 'response.output_text.delta') result.text = streamContentText(parsed.delta);
    else if (type === 'response.failed') result.error = 'OpenAI Responses 请求失败：' + streamErrorDetail(parsed.response?.error || parsed.error || parsed.response || parsed);
    else if (type === 'response.incomplete') result.abnormal = 'OpenAI Responses 异常结束：' + streamErrorDetail(parsed.response?.incomplete_details || parsed.response || parsed);
    else if (type === 'response.completed' || type === 'response.done') {
      const status = parsed.response?.status;
      if (status && status !== 'completed') result.abnormal = `OpenAI Responses 异常结束（status=${status}）：` + streamErrorDetail(parsed.response?.error || parsed.response?.incomplete_details);
      else result.terminal = true;
    }
    return result;
  }
  if (provider === 'gemini') {
    const feedback = parsed?.promptFeedback;
    if (feedback?.blockReason) {
      result.error = 'Gemini 拒绝处理：' + feedback.blockReason + (feedback.blockReasonMessage ? ` - ${feedback.blockReasonMessage}` : '');
      return result;
    }
    const candidate = parsed?.candidates?.[0];
    result.text = (candidate?.content?.parts || []).map(part => typeof part?.text === 'string' ? part.text : '').join('');
    const finish = candidate?.finishReason;
    if (finish) {
      if (finish === 'STOP') result.terminal = true;
      else result.abnormal = `Gemini 异常结束（finishReason=${finish}）` + (candidate.finishMessage ? `：${candidate.finishMessage}` : '，输出可能不完整');
    }
    return result;
  }
  if (type === 'content_block_delta' && (!parsed.delta?.type || parsed.delta.type === 'text_delta')) {
    result.text = typeof parsed.delta?.text === 'string' ? parsed.delta.text : '';
  } else if (type === 'message_delta') {
    const stopReason = parsed.delta?.stop_reason;
    if (stopReason === 'refusal') {
      result.error = 'Claude 拒绝处理：' + streamErrorDetail(
        parsed.delta?.stop_details?.explanation || parsed.stop_details?.explanation || parsed.delta?.stop_details || '请求不符合模型安全要求'
      );
    } else if (stopReason && !['end_turn', 'stop_sequence'].includes(stopReason)) {
      result.abnormal = `Claude 异常结束（stop_reason=${stopReason}），输出可能不完整`;
    }
  } else if (type === 'message_stop') result.terminal = true;
  return result;
}

function waitWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body?.getReader) return '[错误响应体无法安全限界读取，已省略]';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    if (!value?.byteLength) continue;
    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
      try { await reader.cancel(); } catch {}
      return text + '\n[错误响应体已截断]';
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

async function readLimitedErrorBody(response) {
  return readLimitedBody(response, MAX_ERROR_BODY_BYTES);
}

function timeoutMessage(code, ms) {
  if (code === 'first_byte_timeout') return `请求超时：${Math.round(ms / 1000)} 秒内未收到响应内容`;
  if (code === 'idle_timeout') return `请求超时：连续 ${Math.round(ms / 1000)} 秒未收到新数据`;
  return `请求超时：总处理时间超过 ${Math.round(ms / 60000)} 分钟`;
}

async function executeJob(jobId, request, controller) {
  const retry = request.retry || { maxAttempts: 1, statuses: [], baseDelayMs: 0 };
  const startedAt = Date.now();
  let totalTimer = null;
  let abortCode = '';
  let abortMessage = '';
  let flushPendingOutput = null;
  const abort = (code, message) => {
    if (controller.signal.aborted) return;
    abortCode = code;
    abortMessage = message;
    controller.abort();
  };
  totalTimer = setTimeout(() => abort('total_timeout', timeoutMessage('total_timeout', request.timeouts.totalMs)), request.timeouts.totalMs);

  try {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let firstTimer = null;
      let idleTimer = null;
      const clearAttemptTimers = () => {
        if (firstTimer) clearTimeout(firstTimer);
        if (idleTimer) clearTimeout(idleTimer);
        firstTimer = null;
        idleTimer = null;
      };
      const markActivity = () => {
        if (firstTimer) clearTimeout(firstTimer);
        firstTimer = null;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle_timeout', timeoutMessage('idle_timeout', request.timeouts.idleMs)), request.timeouts.idleMs);
      };
      try {
        firstTimer = setTimeout(() => abort('first_byte_timeout', timeoutMessage('first_byte_timeout', request.timeouts.firstByteMs)), request.timeouts.firstByteMs);
        const response = await fetch(request.url, {
          method: 'POST', redirect: 'error', headers: request.headers, body: request.body, signal: controller.signal,
        });
        markActivity();
        if (!response.ok) {
          const body = await readLimitedErrorBody(response);
          clearAttemptTimers();
          if (retry.statuses.includes(response.status) && attempt < retry.maxAttempts) {
            const elapsed = Date.now() - startedAt;
            const waitMs = retry.baseDelayMs * attempt;
            if (elapsed + waitMs >= request.timeouts.totalMs) {
              postEvent(jobId, { kind: 'HTTP_ERROR', status: response.status, body, provider: request.provider });
              return;
            }
            await waitWithSignal(waitMs, controller.signal);
            continue;
          }
          postEvent(jobId, { kind: 'HTTP_ERROR', status: response.status, body, provider: request.provider });
          return;
        }
        if (request.responseMode === 'json') {
          const text = await readLimitedBody(response, MAX_JSON_RESPONSE_BYTES);
          clearAttemptTimers();
          if (text.endsWith('\n[错误响应体已截断]')) {
            postEvent(jobId, { kind: 'ERROR', code: 'json_too_large', message: 'JSON 响应超过安全上限' });
            return;
          }
          let json;
          try { json = JSON.parse(text); }
          catch {
            postEvent(jobId, { kind: 'ERROR', code: 'invalid_json', message: 'JSON 响应解析失败' });
            return;
          }
          if (!json || typeof json !== 'object' || Array.isArray(json)) {
            postEvent(jobId, { kind: 'ERROR', code: 'invalid_json', message: 'JSON 响应格式无效' });
            return;
          }
          postEvent(jobId, { kind: 'DONE', json });
          return;
        }
        if (!response.body?.getReader) {
          postEvent(jobId, { kind: 'ERROR', code: 'missing_body', message: '服务器未返回可读取的流式响应' });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let receivedBytes = 0;
        let outputChars = 0;
        let meaningfulText = false;
        let normalTerminal = false;
        let streamError = '';
        let abnormalFinish = '';
        let fullText = '';
        let minimaxLastContent = '';
        let minimaxContentMode = '';
        let pendingText = '';
        let chunkTimer = null;
        const flushOutput = (flushRemainder) => {
          if (chunkTimer) clearTimeout(chunkTimer);
          chunkTimer = null;
          while (pendingText.length >= MAX_IPC_CHUNK_CHARS) {
            postEvent(jobId, { kind: 'CHUNK', text: pendingText.slice(0, MAX_IPC_CHUNK_CHARS) });
            pendingText = pendingText.slice(MAX_IPC_CHUNK_CHARS);
          }
          if (flushRemainder && pendingText) {
            postEvent(jobId, { kind: 'CHUNK', text: pendingText });
            pendingText = '';
          } else if (pendingText && !chunkTimer) {
            chunkTimer = setTimeout(() => flushOutput(true), 50);
          }
        };
        flushPendingOutput = flushOutput;
        const emitText = (text) => {
          if (!text) return;
          if (outputChars + text.length > request.maxOutputChars) {
            streamError = `模型输出超过 ${request.maxOutputChars} 字符安全上限，已终止请求`;
            return;
          }
          outputChars += text.length;
          if (/\S/.test(text)) meaningfulText = true;
          fullText += text;
          pendingText += text;
          if (pendingText.length >= MAX_IPC_CHUNK_CHARS) flushOutput(false);
          else if (!chunkTimer) chunkTimer = setTimeout(() => flushOutput(true), 50);
        };
        const parser = createSSEParser(({ event, data }) => {
          if (normalTerminal || streamError || abnormalFinish) return;
          const trimmed = data.trim();
          if (!trimmed) return;
          if (trimmed === '[DONE]') { normalTerminal = true; return; }
          if (event === 'ping' || event === 'keepalive' || trimmed === 'ping' || trimmed === '[KEEPALIVE]') return;
          let parsed;
          try { parsed = JSON.parse(data); }
          catch { streamError = `流式响应格式异常，无法解析 SSE 数据：${trimmed.slice(0, 120)}`; return; }
          const analyzed = analyzeStreamPayload(request.parseAs, parsed, event);
          if (analyzed.text) {
            let text = analyzed.text;
            // MiniMax's OpenAI-compatible stream documents delta.content as a
            // cumulative buffer. Detect that mode on the second non-empty
            // payload and emit only its suffix; preserve compatibility with a
            // gateway that sends conventional incremental deltas.
            if (request.parseAs === 'minimax') {
              if (!minimaxLastContent) {
                minimaxLastContent = text;
              } else if (!minimaxContentMode) {
                if (text.startsWith(minimaxLastContent)) {
                  minimaxContentMode = 'cumulative';
                  const cumulative = text;
                  text = cumulative.slice(minimaxLastContent.length);
                  minimaxLastContent = cumulative;
                } else {
                  minimaxContentMode = 'incremental';
                }
              } else if (minimaxContentMode === 'cumulative') {
                if (!text.startsWith(minimaxLastContent)) {
                  streamError = 'MiniMax 流式正文累计序列不一致，已终止请求';
                  return;
                }
                const cumulative = text;
                text = cumulative.slice(minimaxLastContent.length);
                minimaxLastContent = cumulative;
              }
            }
            if (text) emitText(text);
          }
          if (analyzed.error) streamError = analyzed.error;
          if (analyzed.abnormal) abnormalFinish = analyzed.abnormal;
          if (analyzed.terminal) normalTerminal = true;
        });

        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          if (done) {
            try { parser.finish(decoder.decode()); } catch (error) { streamError = error?.message || 'SSE 数据超过安全上限'; }
            break;
          }
          if (value?.byteLength) {
            receivedBytes += value.byteLength;
            markActivity();
            if (receivedBytes > MAX_SSE_TOTAL_BYTES) streamError = `流式响应超过 ${MAX_SSE_TOTAL_BYTES} 字节安全上限，已终止请求`;
          }
          if (!streamError) {
            try { parser.push(decoder.decode(value, { stream: true })); }
            catch (error) { streamError = error?.message || 'SSE 数据超过安全上限'; }
          }
          if (normalTerminal || streamError || abnormalFinish) {
            try { await reader.cancel(); } catch {}
            break;
          }
        }
        clearAttemptTimers();
        flushOutput(true);
        flushPendingOutput = null;
        if (streamError) { postEvent(jobId, { kind: 'ERROR', code: 'stream_error', message: streamError }); return; }
        if (abnormalFinish) {
          if (meaningfulText) {
            postEvent(jobId, {
              kind: 'DONE', text: fullText,
              truncated: true, incomplete: true, warning: abnormalFinish,
            });
          } else {
            postEvent(jobId, { kind: 'ERROR', code: 'truncated', message: abnormalFinish });
          }
          return;
        }
        if (!meaningfulText) { postEvent(jobId, { kind: 'ERROR', code: 'empty', message: '模型未返回任何文本，请重试或更换模型' }); return; }
        if (!normalTerminal) { postEvent(jobId, { kind: 'ERROR', code: 'unexpected_eof', message: '流式响应意外中断（未收到正常结束标记），请重试' }); return; }
        // The terminal carries the bounded authoritative output for every
        // provider, not only transcription. If a service worker dies after a
        // CHUNK was posted but before it was delivered, the reconnected worker
        // can still replace the client's partial buffer exactly at DONE.
        postEvent(jobId, { kind: 'DONE', text: fullText });
        return;
      } finally {
        clearAttemptTimers();
      }
    }
  } catch (error) {
    if (flushPendingOutput) {
      flushPendingOutput(true);
      flushPendingOutput = null;
    }
    if (controller.signal.aborted || error?.name === 'AbortError') {
      postEvent(jobId, { kind: 'ERROR', code: abortCode || 'cancelled', message: abortMessage || '请求已取消', cancelled: (abortCode || 'cancelled') === 'cancelled' });
    } else {
      const message = String(error?.message || error || '').slice(0, 500);
      postEvent(jobId, { kind: 'ERROR', code: 'network_error', message: /Failed to fetch|NetworkError|net::/i.test(message) ? '网络连接失败，请检查网络后重试' : `请求失败: ${message}` });
    }
  } finally {
    if (flushPendingOutput) {
      // A terminal was already emitted or the job is being torn down. Never
      // leave a delayed timer capable of posting after that terminal.
      flushPendingOutput(true);
      flushPendingOutput = null;
    }
    if (totalTimer) clearTimeout(totalTimer);
    ACTIVE_JOBS.delete(jobId);
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'CANCEL') {
    const active = ACTIVE_JOBS.get(message.jobId);
    if (active && !active.controller.signal.aborted) {
      active.abortCode = 'cancelled';
      active.controller.abort();
    }
    return;
  }
  if (message.type !== 'START' || !boundedText(message.jobId, 128) || !/^[A-Za-z0-9-]{16,128}$/.test(message.jobId)) return;
  const validationError = validateNetworkRequest(message.request);
  if (validationError) {
    postEvent(message.jobId, { kind: 'ERROR', code: 'invalid_request', message: validationError });
    return;
  }
  if (ACTIVE_JOBS.has(message.jobId) || ACTIVE_JOBS.size >= 16) {
    postEvent(message.jobId, { kind: 'ERROR', code: 'capacity', message: '并发网络请求过多，请稍后重试' });
    return;
  }
  const controller = new AbortController();
  const record = { controller };
  ACTIVE_JOBS.set(message.jobId, record);
  executeJob(message.jobId, message.request, controller);
};
