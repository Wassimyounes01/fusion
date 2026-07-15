'use strict';
/**
 * fusion.cjs — the front door. optimize() routes each task to the cheapest lane that still verifies.
 *
 *   DELEGATE     simple kinds or short asks -> ONE model call (node --check-gated for code)
 *   SPEC-FUSION  a batch -> draft cheap, verify the block in one judge pass, re-work only failures
 *   FULL FUSION  heavy / high-stakes / flagged -> author -> cross-watch refine -> judge (floor + elevate)
 *
 * Escalation is automatic and one-way: a delegate code draft that fails node --check falls through to
 * full fusion. Models are injected via lib/models.cjs; a built-in echo model runs every lane $0.
 *
 *   const { optimize } = require('./fusion.cjs');
 *   const r = await optimize('summarize the CAP theorem', { kind: 'summarize' });   // -> { output, lane, ... }
 *   const b = await optimize(['write slugify', 'write debounce'], { kind: 'code', batch: true });
 */
const fs = require('fs');
const models = require('./models.cjs');
const { specFuse, deterministicCheck } = require('./spec-fusion.cjs');

const CODE_KINDS = new Set(['code', 'debug', 'implementation', 'refactor', 'script', 'algo']);
const SIMPLE_KINDS = new Set(['chat', 'copy', 'classify', 'summarize', 'label', 'extract', 'intent', 'reply', 'general']);
const DELEGATE_MAX_CHARS = 240;
const clip = (s, n) => String(s || '').slice(0, n);

function inferKind(input) {
  const t = String(input || '').toLowerCase();
  if (/\b(function|code|script|implement|refactor|debug|algorithm|regex|parser|api)\b/.test(t)) return 'code';
  if (/\b(summar|tl;dr|shorten|condense)\b/.test(t)) return 'summarize';
  if (/\b(classify|label|categor|which|is this)\b/.test(t)) return 'classify';
  return 'general';
}

/**
 * delegateEligible(input, opts, kind) — pure heuristic, NO model call.
 * True  = the DELEGATE lane (one model call) is enough.
 * False = escalate to SPEC-FUSION / FULL FUSION.
 */
function delegateEligible(input, opts = {}, kind) {
  if (process.env.FUSION_DELEGATE === '0') return false;             // kill-switch
  if (opts.delegate === false) return false;                        // caller force-OFF
  if (opts.delegate === true) return true;                          // caller force-ON
  if (opts.mode || opts.full === true) return false;                // caller pinned a heavier lane
  if (opts.judge === true || opts.precision === true) return false; // explicit high-quality request
  if (opts.taskFile) return false;                                  // a task-file bundle is heavy work
  const k = String(kind || '').toLowerCase();
  if (k === 'precision') return false;
  // Code is delegate-eligible but node --check-gated downstream; long/complex code should escalate.
  if (CODE_KINDS.has(k)) {
    if (process.env.FUSION_DELEGATE_CODE === '0') return false;
    return String(input || '').length < 600 && !/\b(multi-file|architecture|security|payment|deploy|migration)\b/i.test(String(input));
  }
  return SIMPLE_KINDS.has(k) || String(input || '').length < DELEGATE_MAX_CHARS;
}

// ── DELEGATE lane — one author call ──────────────────────────────────────────────────────────────
async function runDelegate(input, kind, opts) {
  const isCode = CODE_KINDS.has(kind);
  const sys = `You are a capable assistant. Answer the task directly, correctly, and concisely. No preamble, no meta.${isCode ? ' Output the complete runnable solution only — no placeholders or TODOs.' : ''}`;
  let text = '';
  try { const r = await models.author(sys, String(input), { ...opts, kind, max_tokens: opts.max_tokens || 1500 }); text = (r && r.text) || ''; } catch { /* fall through */ }
  return text;
}

// ── FULL FUSION lane — author -> cross-watch refine -> judge ─────────────────────────────────────
async function runFullFusion(input, kind, opts) {
  const isCode = CODE_KINDS.has(kind);
  const authorSys = `You are the AUTHOR. Produce the first complete, correct, ship-ready solution; two reviewers will check it next. Be strong and self-contained. No preamble.${isCode ? ' Production-grade code only — complete, runnable, no placeholders/TODOs.' : ''}`;
  let draft = '';
  try { const r = await models.author(authorSys, String(input), { ...opts, kind, max_tokens: opts.max_tokens || 2000 }); draft = (r && r.text) || ''; } catch {}

  // Cross-watch: a second model critiques + refines the draft.
  const cwSys = `You are the CROSS-WATCH reviewer. Find and fix every weakness in the DRAFT below — correctness bugs, missing cases, unsupported claims, unclear parts. Output ONLY the improved full answer, nothing else.`;
  let refined = draft;
  try { const r = await models.crossWatch(cwSys, `TASK:\n${clip(input, 3000)}\n\nDRAFT:\n${clip(draft, 5000)}`, { ...opts, kind, max_tokens: opts.max_tokens || 2000 }); if (r && r.text) refined = r.text; } catch {}

  // Judge: floor-then-elevate final pass over the refined candidate.
  const judgeSys = `You are the FINAL JUDGE / RE-MODIFIER. Verify the CANDIDATE fully solves the TASK; fix any remaining bug or unsupported claim; your final MUST be at least as strong as the best single expert would produce, then elevate it if you can. Output ONLY the final answer.${isCode ? ' For code, output the COMPLETE runnable solution — no diff, no notes.' : ''}`;
  let out = refined;
  try { const r = await models.judge(judgeSys, `TASK:\n${clip(input, 3000)}\n\nCANDIDATE:\n${clip(refined, 6000)}`, { ...opts, kind, max_tokens: opts.max_tokens || 2500 }); if (r && r.text) out = r.text; } catch {}

  // For code, one grounded re-draft if the final still fails node --check.
  if (isCode) {
    const det = deterministicCheck(kind, out);
    if (det.applicable && !det.pass) {
      try {
        const r = await models.author(authorSys, `${String(input)}\n\n[PREVIOUS ATTEMPT FAILED node --check]\n${det.signal}\nFix it and output the complete solution.`, { ...opts, kind, max_tokens: opts.max_tokens || 2000 });
        if (r && r.text && deterministicCheck(kind, r.text).pass) out = r.text;
      } catch {}
    }
  }
  return out;
}

/**
 * optimize(input, opts) — the front door.
 * opts: { kind, batch, full, delegate, judge, precision, taskFile, max_tokens, ... }
 * returns (single) { output, lane, kind, model_source, ms }
 *         (batch)  { outputs, lane:'spec-fusion', ... , ms }   (pass-through of specFuse)
 */
async function optimize(input, opts = {}) {
  const started = Date.now();

  // Batch → spec-fusion lane.
  if (opts.batch || Array.isArray(input)) {
    const r = await specFuse(input, opts);
    return { ...r, lane: 'spec-fusion', model_source: models.source(), ms: Date.now() - started };
  }

  const kind = String(opts.kind || inferKind(input)).toLowerCase();

  // Delegate lane (with one-way escalation for failed code).
  if (delegateEligible(input, opts, kind)) {
    const text = await runDelegate(input, kind, opts);
    if (CODE_KINDS.has(kind)) {
      const det = deterministicCheck(kind, text);
      if (det.applicable && !det.pass) {
        const out = await runFullFusion(input, kind, opts);
        return { output: out, lane: 'full-fusion', escalated: 'delegate-code-check-failed', kind, model_source: models.source(), ms: Date.now() - started };
      }
    }
    if (text) return { output: text, lane: 'delegate', kind, model_source: models.source(), ms: Date.now() - started };
    // empty delegate → fall through to full fusion
  }

  // Full fusion lane.
  const out = await runFullFusion(input, kind, opts);
  return { output: out, lane: 'full-fusion', kind, model_source: models.source(), ms: Date.now() - started };
}

module.exports = { optimize, delegateEligible, inferKind, runFullFusion, runDelegate };

// CLI: node lib/fusion.cjs [--kind=code] [--full] [--batch] [--task-file=f] "task" ["task2" ...]
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const kind = (argv.find(a => a.startsWith('--kind=')) || '').split('=')[1] || '';
    const full = argv.includes('--full');
    const batch = argv.includes('--batch');
    const taskFile = (argv.find(a => a.startsWith('--task-file=')) || '').split('=').slice(1).join('=');
    let inputs = argv.filter(a => !a.startsWith('--'));
    if (taskFile) { try { inputs = fs.readFileSync(taskFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean); } catch { console.error('task-file not found: ' + taskFile); process.exit(1); } }
    if (!inputs.length) { console.log('Usage: node lib/fusion.cjs [--kind=code] [--full] [--batch] [--task-file=f] "task" ...'); process.exit(0); }

    const opts = { kind: kind || undefined, full };
    if (batch || inputs.length > 1) {
      const r = await optimize(inputs, { ...opts, batch: true });
      console.log(JSON.stringify({ lane: r.lane, model_source: r.model_source, batch: r.batch, accepted_first_pass: r.accepted_first_pass, judge_calls: r.judge_calls, ms: r.ms }, null, 2));
      r.outputs.forEach((o, i) => { console.log(`\n=== ITEM ${i + 1} (${o.kind} · ${o.cached ? 'CACHED' : o.verdict}) ===\n${clip(o.output, 1000) || '(no output)'}`); });
    } else {
      const r = await optimize(inputs[0], opts);
      console.log(`[lane=${r.lane}${r.escalated ? ' escalated:' + r.escalated : ''} · kind=${r.kind} · models=${r.model_source} · ${r.ms}ms]\n`);
      console.log(clip(r.output, 2000) || '(no output)');
    }
    process.stdout.write('', () => process.exit(0));
  })();
}
