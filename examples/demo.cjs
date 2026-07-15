'use strict';
// demo.cjs — watch the router pick a lane per task (built-in echo model, no API key).
// Run: node examples/demo.cjs
const { optimize } = require('../lib/quorum.cjs');

const tasks = [
  { input: 'say hello to the team', kind: 'chat' },                 // -> delegate
  { input: 'summarize the CAP theorem in two sentences', kind: 'summarize' }, // -> delegate
  { input: 'write a debounce function with a cancel method', kind: 'code' },  // -> delegate (code, node --check-gated)
  { input: 'design a distributed rate limiter with failover and back-pressure', kind: 'general', full: true }, // -> full fusion
];

(async () => {
  for (const t of tasks) {
    const r = await optimize(t.input, { kind: t.kind, full: t.full });
    console.log(`\n• "${t.input.slice(0, 48)}${t.input.length > 48 ? '…' : ''}"`);
    console.log(`  lane=${r.lane}${r.escalated ? ' (escalated: ' + r.escalated + ')' : ''}  kind=${r.kind}  models=${r.model_source}`);
    console.log('  → ' + String(r.output).replace(/\n/g, ' ').slice(0, 90));
  }

  console.log('\n--- batch (spec-fusion lane) ---');
  const b = await optimize(['write a slugify function', 'write a clamp function'], { kind: 'code', batch: true });
  console.log(`lane=${b.lane}  batch=${b.batch}  accepted_first_pass=${b.accepted_first_pass}  judge_calls=${b.judge_calls}`);
})();
