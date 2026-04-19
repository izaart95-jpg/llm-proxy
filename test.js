#!/usr/bin/env node
'use strict';

/**
 * Test suite for LLM Universal Proxy converters
 * Run: node test.js
 */

const converters = require('./src/converters');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
  }
}

// ══════════════════════════════════════════════
//  INBOUND PARSING
// ══════════════════════════════════════════════
console.log('\n── Inbound Parsing ──────────────────────────────');

test('fromChatCompletions: basic', () => {
  const body = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    stream: false,
  };
  const r = converters.fromChatCompletions(body);
  assertEqual(r.model, 'gpt-4o');
  assertEqual(r.messages[0].role, 'user');
  assertEqual(r.max_tokens, 100);
  assertEqual(r.stream, false);
});

test('fromChatCompletions: system message extracted', () => {
  const body = {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ],
  };
  const r = converters.fromChatCompletions(body);
  assertEqual(r.system, 'Be helpful');
  assertEqual(r.messages.length, 2);
});

test('fromMessages: basic Anthropic format', () => {
  const body = {
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: 'Hello' }],
    system: 'Be terse',
    max_tokens: 512,
  };
  const r = converters.fromMessages(body);
  assertEqual(r.model, 'claude-3-5-sonnet-20241022');
  assertEqual(r.system, 'Be terse');
  assertEqual(r.max_tokens, 512);
});

test('fromResponses: string input', () => {
  const body = {
    model: 'gpt-4o',
    input: 'Hello world',
    instructions: 'Be brief',
    max_output_tokens: 200,
  };
  const r = converters.fromResponses(body);
  assertEqual(r.messages[0].role, 'user');
  assertEqual(r.messages[0].content, 'Hello world');
  assertEqual(r.system, 'Be brief');
  assertEqual(r.max_tokens, 200);
});

test('fromResponses: array input', () => {
  const body = {
    model: 'gpt-4o',
    input: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Bye' }],
  };
  const r = converters.fromResponses(body);
  assertEqual(r.messages.length, 3);
});

// ══════════════════════════════════════════════
//  OUTBOUND BUILDING
// ══════════════════════════════════════════════
console.log('\n── Outbound Building ────────────────────────────');

test('toChatCompletions: produces valid body', () => {
  const internal = converters.fromMessages({
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: 'Hi' }],
    system: 'Be brief',
    max_tokens: 256,
  });
  const out = converters.toChatCompletions(internal);
  assert(out.messages[0].role === 'system', 'system msg first');
  assert(out.messages[1].role === 'user', 'user msg second');
  assertEqual(out.model, 'claude-3-5-sonnet-20241022');
});

test('toMessages: produces valid body', () => {
  const internal = converters.fromChatCompletions({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ],
    max_tokens: 100,
  });
  const out = converters.toMessages(internal);
  assertEqual(out.system, 'Be helpful');
  assert(!out.messages.find(m => m.role === 'system'), 'no system in messages array');
  assert(out.max_tokens === 100);
});

test('toResponses: string input for single user msg', () => {
  const internal = converters.fromChatCompletions({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  const out = converters.toResponses(internal);
  assertEqual(out.input, 'Hello');
});

test('toResponses: multi-turn preserves array', () => {
  const internal = converters.fromChatCompletions({
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Bye' },
    ],
  });
  const out = converters.toResponses(internal);
  assert(Array.isArray(out.input), 'should be array for multi-turn');
});

// ══════════════════════════════════════════════
//  RESPONSE TRANSLATION
// ══════════════════════════════════════════════
console.log('\n── Response Translation ─────────────────────────');

const mockChatResp = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there!' }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const mockMsgResp = {
  id: 'msg_test123',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hi there!' }],
  model: 'claude-3-5-sonnet-20241022',
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

const mockRespResp = {
  id: 'resp_test123',
  object: 'response',
  created_at: 1700000000,
  status: 'completed',
  model: 'gpt-4o',
  output: [{ type: 'message', id: 'msg_abc', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there!' }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

test('responseChatToMessages: converts correctly', () => {
  const r = converters.responseChatToMessages(mockChatResp);
  assertEqual(r.type, 'message');
  assertEqual(r.role, 'assistant');
  assert(r.content[0].type === 'text' && r.content[0].text === 'Hi there!');
  assertEqual(r.stop_reason, 'end_turn');
  assertEqual(r.usage.input_tokens, 10);
  assertEqual(r.usage.output_tokens, 5);
});

test('responseChatToResponses: converts correctly', () => {
  const r = converters.responseChatToResponses(mockChatResp);
  assertEqual(r.object, 'response');
  assertEqual(r.status, 'completed');
  assert(r.output[0].content[0].text === 'Hi there!');
  assertEqual(r.usage.input_tokens, 10);
});

test('responseMessagesToChat: converts correctly', () => {
  const r = converters.responseMessagesToChat(mockMsgResp);
  assertEqual(r.object, 'chat.completion');
  assertEqual(r.choices[0].message.content, 'Hi there!');
  assertEqual(r.choices[0].finish_reason, 'stop');
  assertEqual(r.usage.prompt_tokens, 10);
  assertEqual(r.usage.completion_tokens, 5);
});

test('responseMessagesToResponses: converts correctly', () => {
  const r = converters.responseMessagesToResponses(mockMsgResp);
  assertEqual(r.object, 'response');
  assert(r.output[0].content[0].text === 'Hi there!');
});

test('responseResponsesToChat: converts correctly', () => {
  const r = converters.responseResponsesToChat(mockRespResp);
  assertEqual(r.object, 'chat.completion');
  assertEqual(r.choices[0].message.content, 'Hi there!');
  assertEqual(r.choices[0].finish_reason, 'stop');
});

test('responseResponsesToMessages: converts correctly', () => {
  const r = converters.responseResponsesToMessages(mockRespResp);
  assertEqual(r.type, 'message');
  assertEqual(r.content[0].text, 'Hi there!');
});

// ══════════════════════════════════════════════
//  STREAMING TRANSLATION
// ══════════════════════════════════════════════
console.log('\n── Streaming Chunk Translation ──────────────────');

test('streamChunkChatToMessages: text delta', () => {
  const chunk = {
    id: 'chatcmpl-test',
    model: 'gpt-4o',
    choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
  };
  const state = {};
  const lines = [...converters.streamChunkChatToMessages(chunk, state)];
  // Should have: message_start, content_block_start, ping, content_block_delta
  assert(lines.some(l => l.includes('message_start')), 'has message_start');
  assert(lines.some(l => l.includes('text_delta')), 'has text_delta');
  assert(state.started === true);
});

test('streamChunkChatToMessages: stop reason', () => {
  const chunk = {
    id: 'chatcmpl-test',
    model: 'gpt-4o',
    choices: [{ delta: {}, finish_reason: 'stop' }],
  };
  const state = { started: true, outputTokens: 3 };
  const lines = [...converters.streamChunkChatToMessages(chunk, state)];
  assert(lines.some(l => l.includes('message_stop')), 'has message_stop');
});

test('streamChunkMessagesToChat: text delta', () => {
  const chunk = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' }, __sseEvent: 'content_block_delta' };
  const state = { messageId: 'test123', model: 'claude-3-5', outputTokens: 0 };
  const lines = [...converters.streamChunkMessagesToChat(chunk, state)];
  assert(lines.some(l => l.includes('"Hi"')), 'has text content');
});

test('streamChunkMessagesToChat: emits [DONE] on stop', () => {
  const chunk = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
  const state = { messageId: 'test123', model: 'claude', outputTokens: 5 };
  const lines = [...converters.streamChunkMessagesToChat(chunk, state)];
  assert(lines.includes('data: [DONE]\n\n'), 'has DONE sentinel');
});

test('streamChunkChatToResponses: creates response.created on first chunk', () => {
  const chunk = {
    id: 'chatcmpl-test',
    model: 'gpt-4o',
    choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
  };
  const state = {};
  const lines = [...converters.streamChunkChatToResponses(chunk, state)];
  assert(lines.some(l => l.includes('response.created')), 'has response.created');
  assert(lines.some(l => l.includes('response.output_text.delta')), 'has text delta');
});

test('streamChunkResponsesToChat: translates delta correctly', () => {
  const state = { responseId: 'resp_test', model: 'gpt-4o', started: true, itemId: 'item_1' };
  const chunk = { type: 'response.output_text.delta', item_id: 'item_1', output_index: 0, content_index: 0, delta: 'Hello' };
  const lines = [...converters.streamChunkResponsesToChat(chunk, state)];
  assert(lines.some(l => l.includes('"Hello"')), 'has text content');
});

// ══════════════════════════════════════════════
//  ROUNDTRIP TESTS
// ══════════════════════════════════════════════
console.log('\n── Roundtrip Tests ──────────────────────────────');

test('chat → messages → chat roundtrip (body)', () => {
  const orig = {
    model: 'gpt-4o',
    messages: [{ role: 'system', content: 'Be terse' }, { role: 'user', content: 'Count to 3' }],
    max_tokens: 50,
  };
  const internal = converters.fromChatCompletions(orig);
  const asMessages = converters.toMessages(internal);
  const internalBack = converters.fromMessages(asMessages);
  const back = converters.toChatCompletions(internalBack);

  assertEqual(back.model, orig.model);
  assert(back.messages.find(m => m.role === 'system')?.content === 'Be terse');
  assert(back.messages.find(m => m.role === 'user')?.content === 'Count to 3');
});

test('messages → responses → messages roundtrip (response objects)', () => {
  const r1 = converters.responseMessagesToResponses(mockMsgResp);
  const r2 = converters.responseResponsesToMessages(r1);
  assertEqual(r2.content[0].text, 'Hi there!');
  assertEqual(r2.usage.input_tokens, 10);
});

test('chat → responses → chat roundtrip (response objects)', () => {
  const r1 = converters.responseChatToResponses(mockChatResp);
  const r2 = converters.responseResponsesToChat(r1);
  assertEqual(r2.choices[0].message.content, 'Hi there!');
  assertEqual(r2.usage.prompt_tokens, 10);
});

// ══════════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════════
console.log(`\n${'─'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('  🎉 All tests passed!\n');
  process.exit(0);
} else {
  console.log('  ❌ Some tests failed.\n');
  process.exit(1);
}