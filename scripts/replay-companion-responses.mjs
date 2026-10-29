import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.argv[2]);
const report = JSON.parse(await readFile(source, 'utf8'));
if (!report.realModel || !Array.isArray(report.diagnostics)) throw new Error('EXPECTED_CAPTURED_REAL_REPORT');
const bundle = await build({ stdin: { contents: "export { createHttpProvider } from './src/server/providers';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { createHttpProvider } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const results = [];
for (const d of report.diagnostics) {
  if (typeof d.content !== 'string' || d.finishReason !== 'stop') continue;
  const provider = createHttpProvider({ url: 'https://offline-replay.invalid/v1/chat/completions', apiKey: 'NOT-A-REAL-KEY', model: 'offline', name: 'OFFLINE', timeoutMs: 1000, jsonMode: true },
    async (_url, init) => {
      if (JSON.parse(String(init.body)).response_format.type !== 'text') throw new Error('WRONG_CHAT_FORMAT');
      // In-memory response; this fake never opens a socket.
      return new Response(JSON.stringify({ choices: [{ finish_reason: d.finishReason, message: { content: d.content } }], usage: d.usage }));
    });
  try {
    const r = await provider.chat({ role: { id: 'offline-role', name: '小小', relationship: 'partner', personality: '温柔倾听', version: 1, createdAt: 1, description: '', boundaries: '' },
      messages: [{ speaker: 'assistant', text: '在呢，怎么啦？' }], memories: [], examples: [], message: '继续聊' });
    let expected = d.content.trim(); try { const legacy = JSON.parse(expected); if (typeof legacy?.text === 'string') expected = legacy.text.trim(); } catch {}
    results.push({ originalRound: d.call, accepted: r.output.text === expected, output: r.output.text });
  } catch(e) { results.push({ originalRound: d.call, accepted: false, error: typeof e?.code === 'string' ? e.code : 'REPLAY_FAILED' }); }
}
const out = path.join(root, '.local', 'protocol-fix-replay', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const summary = { scope: 'Offline replay of captured real response bodies; ZERO network/model calls', source,
  capturedResponses: results.length, accepted: results.filter(r => r.accepted).length, failed: results.filter(r => !r.accepted).length };
await writeFile(path.join(out, 'report.json'), JSON.stringify({ ...summary, results }, null, 2));
console.log(JSON.stringify({ ...summary, reportDir: out }));
if (!results.length || summary.failed) process.exitCode = 1;
