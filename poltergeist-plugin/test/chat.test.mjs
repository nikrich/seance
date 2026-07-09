import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChat } = require('../src/lib/chat.cjs');

const WS = '/Users/test/seance/sandbox';

function okResult(sessionId, result) {
  return { code: 0, stdout: JSON.stringify({ session_id: sessionId, result }), stderr: '' };
}

test('first send starts a session, later sends resume it', async () => {
  const calls = [];
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async (args) => {
      calls.push(args);
      return okResult('s1', 'hello there');
    },
  });

  const r1 = await chat.send(WS, 'what is happening?', 'sonnet');
  assert.equal(r1.answer, 'hello there');
  assert.ok(!calls[0].includes('--resume'));
  const prompt1 = calls[0][calls[0].indexOf('-p') + 1];
  assert.ok(prompt1.startsWith('Invoke the seance-concierge skill'));
  assert.ok(prompt1.includes('what is happening?'));
  assert.ok(calls[0].includes('--model') && calls[0].includes('sonnet'));

  await chat.send(WS, 'and now?', 'sonnet');
  assert.ok(calls[1].includes('--resume'));
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], 's1');
  assert.equal(calls[1][calls[1].indexOf('-p') + 1], 'and now?');

  const hist = chat.history(WS);
  assert.deepEqual(hist.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('reset clears the session', async () => {
  const calls = [];
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async (args) => {
      calls.push(args);
      return okResult('s2', 'ok');
    },
  });
  await chat.send(WS, 'one', 'sonnet');
  chat.reset(WS);
  assert.deepEqual(chat.history(WS), []);
  await chat.send(WS, 'two', 'sonnet');
  assert.ok(!calls[1].includes('--resume'));
});

test('failure surfaces stderr and records an error message', async () => {
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async () => ({ code: 1, stdout: '', stderr: 'rate limit reached for today' }),
  });
  await assert.rejects(() => chat.send(WS, 'hi', 'sonnet'), /rate limit/);
  const hist = chat.history(WS);
  assert.deepEqual(hist.map((m) => m.role), ['user', 'error']);
});

test('rejects a concurrent send for the same workspace', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async () => {
      await gate;
      return okResult('s3', 'done');
    },
  });
  const first = chat.send(WS, 'slow one', 'sonnet');
  await assert.rejects(() => chat.send(WS, 'impatient', 'sonnet'), /deliberating/);
  release();
  assert.equal((await first).answer, 'done');
});

const STDIN_WARNING =
  'Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.';

test('a timed-out run reports a timeout, not stray stderr noise', async () => {
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async () => ({ code: 1, stdout: '', stderr: STDIN_WARNING, killed: true }),
  });
  await assert.rejects(() => chat.send(WS, 'hello', 'sonnet'), /timed out/);
});

test('failure with only the stdin warning on stderr falls back to stdout', async () => {
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async () => ({
      code: 1,
      stdout: 'Error: real failure detail printed to stdout',
      stderr: `${STDIN_WARNING}\n`,
      killed: false,
    }),
  });
  await assert.rejects(
    () => chat.send(WS, 'hello', 'sonnet'),
    (e) => e.message.includes('real failure detail') && !e.message.includes('no stdin data'),
  );
});

test('real stderr wins over stdout on failure, with the stdin warning stripped', async () => {
  const chat = createChat({
    dataDir: mkdtempSync(join(tmpdir(), 'seance-chat-')),
    runClaude: async () => ({
      code: 1,
      stdout: 'irrelevant',
      stderr: `${STDIN_WARNING}\nError: vault index corrupted`,
      killed: false,
    }),
  });
  await assert.rejects(
    () => chat.send(WS, 'hi', 'sonnet'),
    (e) => e.message.includes('vault index corrupted') && !e.message.includes('no stdin data'),
  );
});

test('sessions persist across instances via dataDir', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seance-chat-'));
  const calls = [];
  const mk = () =>
    createChat({ dataDir, runClaude: async (args) => (calls.push(args), okResult('s9', 'x')) });
  await mk().send(WS, 'one', 'sonnet');
  await mk().send(WS, 'two', 'sonnet');
  assert.ok(calls[1].includes('--resume'));
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], 's9');
});
