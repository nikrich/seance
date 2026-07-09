'use strict';
// Chat with the séance: one `claude -p` per message, `--resume <session>` for
// continuity. Session ids and display transcripts persist in the plugin's
// dataDir; the real conversational memory lives in the claude session.

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');

const PREAMBLE =
  'Invoke the seance-concierge skill. You are being used as a chat interface inside Poltergeist. ';

// A concierge answer is an agentic run over the workspace files — 2 minutes
// was routinely too short and surfaced as a mystery failure.
const CHAT_TIMEOUT_MS = 300_000;

function slugFor(wsPath) {
  return basename(wsPath).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

function createChat({ dataDir, runClaude }) {
  const sessionsFile = () => join(dataDir, 'chat-sessions.json');
  const transcriptFile = (ws) => join(dataDir, 'chat', `${slugFor(ws)}.json`);
  const inFlight = new Set();

  function sessions() {
    return readJson(sessionsFile(), {});
  }

  function setSession(ws, id) {
    mkdirSync(dataDir, { recursive: true });
    const s = sessions();
    if (id === null) delete s[ws];
    else s[ws] = id;
    writeFileSync(sessionsFile(), JSON.stringify(s, null, 2));
  }

  function history(ws) {
    return readJson(transcriptFile(ws), []);
  }

  function appendMessages(ws, messages) {
    mkdirSync(join(dataDir, 'chat'), { recursive: true });
    writeFileSync(transcriptFile(ws), JSON.stringify([...history(ws), ...messages], null, 2));
  }

  async function send(ws, text, model) {
    if (inFlight.has(ws)) {
      throw new Error('the spirits are still deliberating — wait for the current answer');
    }
    inFlight.add(ws);
    const ts = new Date().toISOString();
    try {
      const sessionId = sessions()[ws];
      const prompt = sessionId ? text : PREAMBLE + text;
      const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
        '--model',
        model,
      ];
      if (sessionId) args.push('--resume', sessionId);

      const { code, stdout, stderr, killed } = await runClaude(args, ws, CHAT_TIMEOUT_MS);
      if (killed) {
        throw new Error(
          `séance chat timed out after ${Math.round(CHAT_TIMEOUT_MS / 1000)}s — try again, or ask something smaller`,
        );
      }
      if (code !== 0) {
        // the CLI's stdin-timeout warning is noise, and real errors sometimes
        // land on stdout — report the most useful thing we actually have
        const detail =
          (stderr ?? '').replace(/Warning: no stdin data received[^\n]*\n?/g, '').trim() ||
          (stdout ?? '').trim() ||
          'no output';
        throw new Error(`séance chat failed: ${detail.slice(-300)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`séance chat returned unparseable output: ${stdout.slice(-200)}`);
      }
      if (parsed.session_id) setSession(ws, parsed.session_id);
      const answer = String(parsed.result ?? '');
      appendMessages(ws, [
        { role: 'user', text, ts },
        { role: 'assistant', text: answer, ts: new Date().toISOString() },
      ]);
      return { answer };
    } catch (err) {
      appendMessages(ws, [
        { role: 'user', text, ts },
        { role: 'error', text: err instanceof Error ? err.message : String(err), ts: new Date().toISOString() },
      ]);
      throw err;
    } finally {
      inFlight.delete(ws);
    }
  }

  function reset(ws) {
    setSession(ws, null);
    mkdirSync(join(dataDir, 'chat'), { recursive: true });
    writeFileSync(transcriptFile(ws), '[]');
  }

  return { send, history, reset };
}

module.exports = { createChat };
