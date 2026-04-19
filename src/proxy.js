'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const converters = require('./converters');

// ══════════════════════════════════════════════
//  CONFIG DEFAULTS
// ══════════════════════════════════════════════
const ENDPOINT_PATHS = {
  chat: '/v1/chat/completions',
  messages: '/v1/messages',
  responses: '/v1/responses',
};

// ══════════════════════════════════════════════
//  DETECT INBOUND FORMAT
// ══════════════════════════════════════════════
function detectInboundFormat(path) {
  if (path.includes('/chat/completions')) return 'chat';
  if (path.includes('/messages')) return 'messages';
  if (path.includes('/responses')) return 'responses';
  return 'chat'; // default
}

// ══════════════════════════════════════════════
//  PARSE INBOUND BODY
// ══════════════════════════════════════════════
function parseInbound(format, body) {
  switch (format) {
    case 'chat': return converters.fromChatCompletions(body);
    case 'messages': return converters.fromMessages(body);
    case 'responses': return converters.fromResponses(body);
    default: return converters.fromChatCompletions(body);
  }
}

// ══════════════════════════════════════════════
//  BUILD OUTBOUND BODY
// ══════════════════════════════════════════════
function buildOutbound(internal, targetFormat) {
  switch (targetFormat) {
    case 'chat': return converters.toChatCompletions(internal);
    case 'messages': return converters.toMessages(internal);
    case 'responses': return converters.toResponses(internal);
    default: return converters.toChatCompletions(internal);
  }
}

// ══════════════════════════════════════════════
//  TRANSLATE RESPONSE (non-streaming)
// ══════════════════════════════════════════════
function translateResponse(backendBody, backendFormat, clientFormat) {
  if (backendFormat === clientFormat) return backendBody;

  if (backendFormat === 'chat' && clientFormat === 'messages') return converters.responseChatToMessages(backendBody);
  if (backendFormat === 'chat' && clientFormat === 'responses') return converters.responseChatToResponses(backendBody);
  if (backendFormat === 'messages' && clientFormat === 'chat') return converters.responseMessagesToChat(backendBody);
  if (backendFormat === 'messages' && clientFormat === 'responses') return converters.responseMessagesToResponses(backendBody);
  if (backendFormat === 'responses' && clientFormat === 'chat') return converters.responseResponsesToChat(backendBody);
  if (backendFormat === 'responses' && clientFormat === 'messages') return converters.responseResponsesToMessages(backendBody);
  return backendBody;
}

// ══════════════════════════════════════════════
//  STREAMING CHUNK TRANSLATOR
// ══════════════════════════════════════════════
function getStreamTranslator(backendFormat, clientFormat) {
  if (backendFormat === clientFormat) return null; // passthrough

  if (backendFormat === 'chat' && clientFormat === 'messages') return converters.streamChunkChatToMessages;
  if (backendFormat === 'chat' && clientFormat === 'responses') return converters.streamChunkChatToResponses;
  if (backendFormat === 'messages' && clientFormat === 'chat') return converters.streamChunkMessagesToChat;
  if (backendFormat === 'messages' && clientFormat === 'responses') return converters.streamChunkMessagesToResponses;
  if (backendFormat === 'responses' && clientFormat === 'chat') return converters.streamChunkResponsesToChat;
  if (backendFormat === 'responses' && clientFormat === 'messages') return converters.streamChunkResponsesToMessages;
  return null;
}

// ══════════════════════════════════════════════
//  FORWARD REQUEST TO BACKEND
// ══════════════════════════════════════════════
async function forwardRequest({ backendUrl, targetFormat, outboundBody, inboundHeaders, config }) {
  // Strip trailing slash AND any trailing /v1 from backendUrl before appending
  // the full endpoint path (which always starts with /v1/...).
  // This correctly handles both:
  //   https://api.openai.com          → https://api.openai.com/v1/chat/completions
  //   https://openrouter.ai/api/v1    → https://openrouter.ai/api/v1/chat/completions
  const base = backendUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(base + ENDPOINT_PATHS[targetFormat]);
  const bodyStr = JSON.stringify(outboundBody);

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyStr),
  };

  // Forward auth headers
  if (inboundHeaders.authorization) headers['Authorization'] = inboundHeaders.authorization;
  if (inboundHeaders['x-api-key']) headers['x-api-key'] = inboundHeaders['x-api-key'];
  if (inboundHeaders['anthropic-version']) headers['anthropic-version'] = inboundHeaders['anthropic-version'];

  // Override with config headers if specified
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
    headers['x-api-key'] = config.apiKey;
  }
  if (config.anthropicVersion) headers['anthropic-version'] = config.anthropicVersion;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(options, resolve);
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ══════════════════════════════════════════════
//  SSE PARSER for streaming responses
// ══════════════════════════════════════════════
async function* parseSSEStream(responseStream) {
  let buffer = '';
  for await (const chunk of responseStream) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // incomplete last line

    let eventType = '';
    let dataLine = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine = line.slice(5).trim();
      } else if (line === '') {
        // End of event block
        if (dataLine === '[DONE]') {
          yield { type: '__done__' };
          eventType = '';
          dataLine = '';
          continue;
        }
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine);
            // Annotate with SSE event type for Anthropic streams
            if (eventType) parsed.__sseEvent = eventType;
            yield parsed;
          } catch {
            // non-JSON line, skip
          }
        }
        eventType = '';
        dataLine = '';
      }
    }
  }
}

// ══════════════════════════════════════════════
//  MAIN PROXY HANDLER
// ══════════════════════════════════════════════
async function proxyRequest(req, res, config, stats) {
  const clientFormat = detectInboundFormat(req.path || req.url);
  const targetFormat = config.backendFormat; // 'chat' | 'messages' | 'responses'

  // Express has already parsed the body via express.json() / express.text().
  // req.body is either already an object or a JSON string — never re-read the stream.
  let inboundBody;
  try {
    inboundBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!inboundBody || typeof inboundBody !== 'object') throw new Error('empty');
  } catch {
    return sendError(res, 400, 'Invalid or missing JSON body');
  }

  // Convert inbound → internal → outbound
  const internal = parseInbound(clientFormat, inboundBody);
  const outboundBody = buildOutbound(internal, targetFormat);

  const isStreaming = internal.stream;

  // Track stats
  stats.totalRequests++;
  stats.activeRequests++;
  stats.lastRequest = new Date().toISOString();
  const startTime = Date.now();

  try {
    const backendRes = await forwardRequest({
      backendUrl: config.backendUrl,
      targetFormat,
      outboundBody,
      inboundHeaders: req.headers,
      config,
    });

    if (isStreaming) {
      await handleStreamingResponse(backendRes, res, targetFormat, clientFormat, stats);
    } else {
      await handleJsonResponse(backendRes, res, targetFormat, clientFormat, stats);
    }

    stats.successRequests++;
  } catch (err) {
    stats.errorRequests++;
    console.error('[proxy] Backend request failed:', err.message);
    sendError(res, 502, 'Backend request failed: ' + err.message);
  } finally {
    stats.activeRequests--;
    stats.totalLatencyMs += Date.now() - startTime;
  }
}

async function handleJsonResponse(backendRes, res, backendFormat, clientFormat, stats) {
  const bodyChunks = [];
  for await (const chunk of backendRes) bodyChunks.push(chunk);
  const bodyStr = Buffer.concat(bodyChunks).toString();

  // Forward non-200 verbatim
  if (backendRes.statusCode >= 400) {
    res.status(backendRes.statusCode).set('Content-Type', 'application/json').send(bodyStr);
    return;
  }

  let backendBody;
  try {
    backendBody = JSON.parse(bodyStr);
  } catch {
    res.status(502).json({ error: 'Backend returned invalid JSON', raw: bodyStr });
    return;
  }

  const translated = translateResponse(backendBody, backendFormat, clientFormat);
  res.status(200).json(translated);
}

async function handleStreamingResponse(backendRes, res, backendFormat, clientFormat, stats) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const translator = getStreamTranslator(backendFormat, clientFormat);

  if (!translator) {
    // Pure passthrough
    for await (const chunk of backendRes) {
      res.write(chunk);
    }
    res.end();
    return;
  }

  const state = {};
  let sentDone = false;

  for await (const chunk of parseSSEStream(backendRes)) {
    if (chunk.type === '__done__') {
      if (!sentDone && clientFormat === 'chat') {
        res.write('data: [DONE]\n\n');
        sentDone = true;
      }
      break;
    }
    for (const line of translator(chunk, state)) {
      res.write(line);
    }
  }
  res.end();
}

// ── Utilities ────────────────────────────────

function sendError(res, status, message) {
  res.status(status).json({ error: { message, type: 'proxy_error', code: status } });
}

module.exports = { proxyRequest, ENDPOINT_PATHS };