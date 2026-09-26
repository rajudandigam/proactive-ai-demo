import { inspectRun, step } from 'agent-inspect';

await inspectRun('manual-consumer-smoke', async () => {
  await step.tool('echo', async () => ({ ok: true }));
  return 'ok';
}, { silent: true, traceDir: './.agent-inspect' });

console.log(JSON.stringify({ ok: true, lane: 'manual' }));
