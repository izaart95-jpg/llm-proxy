'use strict';

// ─────────────────────────────────────────────
//  NORMALISED INTERNAL MESSAGE FORMAT
//  { role, content: string | ContentBlock[] }
//  ContentBlock: { type, text?, image_url?, ... }
// ─────────────────────────────────────────────

// ══════════════════════════════════════════════
//  INBOUND: any format → internal
// ══════════════════════════════════════════════

function normaliseMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (Array.isArray(msg.content)) {
      // Already a content-block array – keep as-is
      return msg;
    }
    return { ...msg, content: msg.content ?? '' };
  });
}

// ── Chat Completions → internal ──────────────
function fromChatCompletions(body) {
  return {
    model: body.model,
    messages: normaliseMessages(body.messages || []),
    system: extractSystemFromMessages(body.messages),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    stop: body.stop,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
    n: body.n,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
    logit_bias: body.logit_bias,
    user: body.user,
    response_format: body.response_format,
    seed: body.seed,
    _raw: body,
  };
}

// ── Anthropic Messages → internal ───────────
function fromMessages(body) {
  return {
    model: body.model,
    messages: normaliseMessages(body.messages || []),
    system: body.system,
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    stop: body.stop_sequences,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
    metadata: body.metadata,
    _raw: body,
  };
}

// ── Responses API → internal ─────────────────
function fromResponses(body) {
  // Responses API uses `input` (string or array) instead of `messages`
  let messages = [];
  if (typeof body.input === 'string') {
    messages = [{ role: 'user', content: body.input }];
  } else if (Array.isArray(body.input)) {
    messages = normaliseMessages(body.input);
  }

  return {
    model: body.model,
    messages,
    system: body.instructions ?? body.system,
    max_tokens: body.max_output_tokens ?? body.max_tokens ?? 1024,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    stream: body.stream ?? false,
    tools: body.tools,
    tool_choice: body.tool_choice,
    user: body.user,
    response_format: body.text?.format ?? body.response_format,
    _raw: body,
  };
}

// ══════════════════════════════════════════════
//  OUTBOUND: internal → target format (request)
// ══════════════════════════════════════════════

function toChatCompletions(internal) {
  const messages = buildChatMessages(internal);
  const body = {
    model: internal.model,
    messages,
    stream: internal.stream,
    max_tokens: internal.max_tokens,
  };
  if (internal.temperature !== undefined) body.temperature = internal.temperature;
  if (internal.top_p !== undefined) body.top_p = internal.top_p;
  if (internal.stop) body.stop = internal.stop;
  // Translate Anthropic-style tools → OpenAI-style { type, function: { name, description, parameters } }
  if (internal.tools) body.tools = internal.tools.map(anthropicToolToChatTool);
  if (internal.tool_choice) body.tool_choice = translateToolChoiceToChat(internal.tool_choice);
  if (internal.n) body.n = internal.n;
  if (internal.presence_penalty !== undefined) body.presence_penalty = internal.presence_penalty;
  if (internal.frequency_penalty !== undefined) body.frequency_penalty = internal.frequency_penalty;
  if (internal.user) body.user = internal.user;
  if (internal.response_format) body.response_format = internal.response_format;
  if (internal.seed !== undefined) body.seed = internal.seed;
  return body;
}

function toMessages(internal) {
  const body = {
    model: internal.model,
    messages: buildAnthropicMessages(internal),
    max_tokens: internal.max_tokens,
    stream: internal.stream,
  };
  if (internal.system) body.system = internal.system;
  if (internal.temperature !== undefined) body.temperature = internal.temperature;
  if (internal.top_p !== undefined) body.top_p = internal.top_p;
  if (internal.top_k !== undefined) body.top_k = internal.top_k;
  if (internal.stop) body.stop_sequences = Array.isArray(internal.stop) ? internal.stop : [internal.stop];
  // Translate OpenAI-style tools → Anthropic-style { name, description, input_schema }
  if (internal.tools) body.tools = internal.tools.map(chatToolToAnthropicTool);
  if (internal.tool_choice) body.tool_choice = translateToolChoiceToAnthropic(internal.tool_choice);
  if (internal.metadata) body.metadata = internal.metadata;
  return body;
}

function toResponses(internal) {
  const messages = buildChatMessages(internal);
  // Responses API prefers a single string for simple user prompts
  const lastUser = messages.filter(m => m.role === 'user').pop();
  const input = messages.length === 1 && lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content : lastUser.content)
    : messages;

  const body = {
    model: internal.model,
    input,
    stream: internal.stream,
    max_output_tokens: internal.max_tokens,
  };
  if (internal.system) body.instructions = internal.system;
  if (internal.temperature !== undefined) body.temperature = internal.temperature;
  if (internal.top_p !== undefined) body.top_p = internal.top_p;
  if (internal.stop) body.stop = internal.stop;
  if (internal.tools) body.tools = internal.tools;
  if (internal.tool_choice) body.tool_choice = internal.tool_choice;
  if (internal.user) body.user = internal.user;
  if (internal.response_format) body.text = { format: internal.response_format };
  return body;
}

// ══════════════════════════════════════════════
//  RESPONSE TRANSLATION (non-streaming)
// ══════════════════════════════════════════════

// ── Chat Completions response → target format ─

function responseChatToMessages(chatResp) {
  const choice = chatResp.choices?.[0];
  const msg = choice?.message ?? {};
  const content = buildAnthropicContent(msg);

  return {
    id: `msg_${chatResp.id ?? randomId()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: chatResp.model,
    stop_reason: mapChatStopToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: chatResp.usage?.prompt_tokens ?? 0,
      output_tokens: chatResp.usage?.completion_tokens ?? 0,
    },
  };
}

function responseChatToResponses(chatResp) {
  const choice = chatResp.choices?.[0];
  const msg = choice?.message ?? {};
  const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);

  return {
    id: `resp_${chatResp.id ?? randomId()}`,
    object: 'response',
    created_at: chatResp.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatResp.model,
    output: [
      {
        type: 'message',
        id: `msg_${randomId()}`,
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: {
      input_tokens: chatResp.usage?.prompt_tokens ?? 0,
      output_tokens: chatResp.usage?.completion_tokens ?? 0,
      total_tokens: chatResp.usage?.total_tokens ?? 0,
    },
  };
}

function responseMessagesToChat(msgResp) {
  const text = extractAnthropicText(msgResp.content);
  return {
    id: `chatcmpl-${msgResp.id ?? randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msgResp.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapAnthropicStopToChat(msgResp.stop_reason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: msgResp.usage?.input_tokens ?? 0,
      completion_tokens: msgResp.usage?.output_tokens ?? 0,
      total_tokens: (msgResp.usage?.input_tokens ?? 0) + (msgResp.usage?.output_tokens ?? 0),
    },
  };
}

function responseMessagesToResponses(msgResp) {
  const text = extractAnthropicText(msgResp.content);
  return {
    id: `resp_${msgResp.id ?? randomId()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: msgResp.model,
    output: [
      {
        type: 'message',
        id: `msg_${randomId()}`,
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: {
      input_tokens: msgResp.usage?.input_tokens ?? 0,
      output_tokens: msgResp.usage?.output_tokens ?? 0,
      total_tokens: (msgResp.usage?.input_tokens ?? 0) + (msgResp.usage?.output_tokens ?? 0),
    },
  };
}

function responseResponsesToChat(respResp) {
  const text = extractResponsesText(respResp.output);
  return {
    id: `chatcmpl-${respResp.id ?? randomId()}`,
    object: 'chat.completion',
    created: respResp.created_at ?? Math.floor(Date.now() / 1000),
    model: respResp.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: respResp.usage?.input_tokens ?? 0,
      completion_tokens: respResp.usage?.output_tokens ?? 0,
      total_tokens: respResp.usage?.total_tokens ?? 0,
    },
  };
}

function responseResponsesToMessages(respResp) {
  const text = extractResponsesText(respResp.output);
  return {
    id: `msg_${respResp.id ?? randomId()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: respResp.model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: respResp.usage?.input_tokens ?? 0,
      output_tokens: respResp.usage?.output_tokens ?? 0,
    },
  };
}

// ══════════════════════════════════════════════
//  STREAMING SSE TRANSLATION
// ══════════════════════════════════════════════

// Each translator returns an array of SSE lines (strings) to emit

// Chat → Messages stream
function* streamChunkChatToMessages(chunk, state) {
  if (chunk.choices?.[0]?.delta?.content) {
    const text = chunk.choices[0].delta.content;
    if (!state.started) {
      state.started = true;
      state.inputTokens = 0;
      state.outputTokens = 0;
      yield sseEvent('message_start', {
        type: 'message_start',
        message: { id: `msg_${chunk.id ?? randomId()}`, type: 'message', role: 'assistant', content: [], model: chunk.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
      yield sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      yield sseEvent('ping', { type: 'ping' });
    }
    state.outputTokens += estimateTokens(text);
    yield sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  }
  if (chunk.choices?.[0]?.finish_reason) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    yield sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapChatStopToAnthropic(chunk.choices[0].finish_reason), stop_sequence: null },
      usage: { output_tokens: state.outputTokens },
    });
    yield sseEvent('message_stop', { type: 'message_stop' });
  }
}

// Chat → Responses stream
function* streamChunkChatToResponses(chunk, state) {
  if (!state.started && (chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.finish_reason)) {
    state.started = true;
    state.responseId = `resp_${chunk.id ?? randomId()}`;
    state.itemId = `msg_${randomId()}`;
    yield sseEvent('response.created', { type: 'response.created', response: { id: state.responseId, object: 'response', status: 'in_progress', model: chunk.model, output: [] } });
    yield sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: state.itemId, role: 'assistant', content: [] } });
    yield sseEvent('response.content_part.added', { type: 'response.content_part.added', item_id: state.itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
  }
  if (chunk.choices?.[0]?.delta?.content) {
    yield sseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: state.itemId, output_index: 0, content_index: 0, delta: chunk.choices[0].delta.content });
  }
  if (chunk.choices?.[0]?.finish_reason) {
    yield sseEvent('response.output_text.done', { type: 'response.output_text.done', item_id: state.itemId, output_index: 0, content_index: 0 });
    yield sseEvent('response.content_part.done', { type: 'response.content_part.done', item_id: state.itemId, output_index: 0, content_index: 0 });
    yield sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: state.itemId, role: 'assistant' } });
    yield sseEvent('response.completed', { type: 'response.completed', response: { id: state.responseId, object: 'response', status: 'completed', model: chunk.model } });
  }
}

// Messages → Chat stream
function* streamChunkMessagesToChat(chunk, state) {
  if (chunk.type === 'message_start') {
    state.messageId = chunk.message?.id ?? randomId();
    state.model = chunk.message?.model;
  }
  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
    const text = chunk.delta.text;
    state.outputTokens = (state.outputTokens ?? 0) + estimateTokens(text);
    yield sseEvent('', {
      id: `chatcmpl-${state.messageId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }],
    });
  }
  if (chunk.type === 'message_delta' && chunk.delta?.stop_reason) {
    yield sseEvent('', {
      id: `chatcmpl-${state.messageId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: mapAnthropicStopToChat(chunk.delta.stop_reason), logprobs: null }],
      usage: { prompt_tokens: 0, completion_tokens: state.outputTokens ?? 0, total_tokens: state.outputTokens ?? 0 },
    });
    yield 'data: [DONE]\n\n';
  }
}

// Messages → Responses stream
function* streamChunkMessagesToResponses(chunk, state) {
  if (chunk.type === 'message_start') {
    state.messageId = chunk.message?.id ?? randomId();
    state.model = chunk.message?.model;
    state.responseId = `resp_${randomId()}`;
    state.itemId = `msg_${randomId()}`;
    yield sseEvent('response.created', { type: 'response.created', response: { id: state.responseId, object: 'response', status: 'in_progress', model: state.model, output: [] } });
    yield sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: state.itemId, role: 'assistant', content: [] } });
    yield sseEvent('response.content_part.added', { type: 'response.content_part.added', item_id: state.itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
  }
  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
    yield sseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: state.itemId, output_index: 0, content_index: 0, delta: chunk.delta.text });
  }
  if (chunk.type === 'message_stop') {
    yield sseEvent('response.output_text.done', { type: 'response.output_text.done', item_id: state.itemId, output_index: 0, content_index: 0 });
    yield sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: state.itemId, role: 'assistant' } });
    yield sseEvent('response.completed', { type: 'response.completed', response: { id: state.responseId, object: 'response', status: 'completed', model: state.model } });
  }
}

// Responses → Chat stream
function* streamChunkResponsesToChat(chunk, state) {
  if (chunk.type === 'response.created') {
    state.responseId = chunk.response?.id ?? randomId();
    state.model = chunk.response?.model;
  }
  if (chunk.type === 'response.output_text.delta') {
    yield sseEvent('', {
      id: `chatcmpl-${state.responseId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null, logprobs: null }],
    });
  }
  if (chunk.type === 'response.completed') {
    yield sseEvent('', {
      id: `chatcmpl-${state.responseId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
    });
    yield 'data: [DONE]\n\n';
  }
}

// Responses → Messages stream
function* streamChunkResponsesToMessages(chunk, state) {
  if (chunk.type === 'response.created') {
    state.model = chunk.response?.model;
    state.responseId = chunk.response?.id ?? randomId();
    yield sseEvent('message_start', {
      type: 'message_start',
      message: { id: `msg_${state.responseId}`, type: 'message', role: 'assistant', content: [], model: state.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    yield sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield sseEvent('ping', { type: 'ping' });
  }
  if (chunk.type === 'response.output_text.delta') {
    yield sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk.delta } });
  }
  if (chunk.type === 'response.completed') {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    yield sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    yield sseEvent('message_stop', { type: 'message_stop' });
  }
}

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════

function extractSystemFromMessages(messages = []) {
  const sys = messages.find(m => m.role === 'system');
  return sys ? (typeof sys.content === 'string' ? sys.content : extractText(sys.content)) : undefined;
}

function buildChatMessages(internal) {
  const msgs = [];
  if (internal.system) msgs.push({ role: 'system', content: internal.system });
  for (const m of internal.messages) {
    if (m.role === 'system') continue; // already added
    msgs.push({ role: m.role, content: flattenContent(m.content) });
  }
  return msgs;
}

function buildAnthropicMessages(internal) {
  return internal.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: toAnthropicContent(m.content) }));
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Try to flatten to string if all blocks are text
    const allText = content.every(b => b.type === 'text' || b.type === 'output_text');
    if (allText) return content.map(b => b.text ?? '').join('');
    return content;
  }
  return String(content ?? '');
}

function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'text' || block.type === 'output_text') return { type: 'text', text: block.text };
      if (block.type === 'image_url') return { type: 'image', source: { type: 'url', url: block.image_url?.url ?? block.image_url } };
      return block;
    });
  }
  return String(content ?? '');
}

function buildAnthropicContent(msg) {
  if (!msg.content && !msg.tool_calls) return [{ type: 'text', text: '' }];
  const blocks = [];
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeParseJson(tc.function?.arguments) });
    }
  }
  return blocks;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => b.text ?? '').join('');
  return '';
}

function extractAnthropicText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
}

function extractResponsesText(output) {
  if (!Array.isArray(output)) return '';
  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      return item.content.filter(b => b.type === 'output_text').map(b => b.text ?? '').join('');
    }
  }
  return '';
}

function mapChatStopToAnthropic(reason) {
  const map = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };
  return map[reason] ?? 'end_turn';
}

function mapAnthropicStopToChat(reason) {
  const map = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };
  return map[reason] ?? 'stop';
}

function sseEvent(event, data) {
  const jsonData = JSON.stringify(data);
  if (event) return `event: ${event}\ndata: ${jsonData}\n\n`;
  return `data: ${jsonData}\n\n`;
}

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 4);
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}


// ══════════════════════════════════════════════
//  TOOL FORMAT TRANSLATORS
// ══════════════════════════════════════════════

// Anthropic tool → OpenAI tool
// { name, description, input_schema } → { type, function: { name, description, parameters } }
function anthropicToolToChatTool(tool) {
  // Already OpenAI format — has a `function` key or `type: "function"`
  if (tool.type === "function" || tool.function) return tool;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    },
  };
}

// OpenAI tool → Anthropic tool
// { type, function: { name, description, parameters } } → { name, description, input_schema }
function chatToolToAnthropicTool(tool) {
  // Already Anthropic format — has input_schema
  if (tool.input_schema) return tool;
  const fn = tool.function ?? tool;
  return {
    name: fn.name,
    description: fn.description ?? "",
    input_schema: fn.parameters ?? { type: "object", properties: {} },
  };
}

// tool_choice: Anthropic → OpenAI
function translateToolChoiceToChat(tc) {
  if (!tc) return undefined;
  if (typeof tc === "string") {
    // "auto" | "any" | "none"
    if (tc === "any") return "required";
    return tc; // "auto", "none" are identical
  }
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  return tc;
}

// tool_choice: OpenAI → Anthropic
function translateToolChoiceToAnthropic(tc) {
  if (!tc) return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "none") return { type: "none" };  // Anthropic doesn't have "none" but pass through
  if (tc === "required") return { type: "any" };
  if (typeof tc === "object" && tc.type === "function") return { type: "tool", name: tc.function?.name };
  return tc;
}

// ══════════════════════════════════════════════
//  MESSAGE CONTENT: tool_use / tool_result blocks
// ══════════════════════════════════════════════

// Build chat messages, translating Anthropic tool_use/tool_result blocks → OpenAI format
function buildChatMessages(internal) {
  const msgs = [];
  if (internal.system) msgs.push({ role: "system", content: internal.system });
  for (const m of internal.messages) {
    if (m.role === "system") continue;

    // Anthropic assistant message with tool_use blocks
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const textParts = m.content.filter(b => b.type === "text").map(b => b.text).join("");
      const toolCalls = m.content
        .filter(b => b.type === "tool_use")
        .map(b => ({
          id: b.id ?? ("call_" + randomId()),
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: "assistant", content: textParts || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      msgs.push(msg);
      continue;
    }

    // Anthropic user message with tool_result blocks
    if (m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_result")) {
      for (const block of m.content) {
        if (block.type === "tool_result") {
          msgs.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: typeof block.content === "string"
              ? block.content
              : (Array.isArray(block.content) ? block.content.map(b => b.text ?? "").join("") : ""),
          });
        } else if (block.type === "text" && block.text) {
          msgs.push({ role: "user", content: block.text });
        }
      }
      continue;
    }

    msgs.push({ role: m.role, content: flattenContent(m.content) });
  }
  return msgs;
}

// Build Anthropic messages, translating OpenAI tool_calls/tool role → Anthropic format
function buildAnthropicMessages(internal) {
  const out = [];
  for (const m of internal.messages) {
    if (m.role === "system") continue;

    // OpenAI assistant message with tool_calls
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name,
          input: safeParseJson(tc.function?.arguments ?? "{}"),
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    // OpenAI tool result message
    if (m.role === "tool") {
      // Anthropic expects tool_result inside a user turn
      const last = out[out.length - 1];
      const resultBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content ?? "",
      };
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }

    out.push({ role: m.role, content: toAnthropicContent(m.content) });
  }
  return out;
}

module.exports = {
  fromChatCompletions, fromMessages, fromResponses,
  toChatCompletions, toMessages, toResponses,
  responseChatToMessages, responseChatToResponses,
  responseMessagesToChat, responseMessagesToResponses,
  responseResponsesToChat, responseResponsesToMessages,
  streamChunkChatToMessages, streamChunkChatToResponses,
  streamChunkMessagesToChat, streamChunkMessagesToResponses,
  streamChunkResponsesToChat, streamChunkResponsesToMessages,
};
