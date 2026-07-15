'use strict';
/**
 * spec-fusion.cjs — Fusion's batch lane (Lane 2).
 *
 * Speculative decoding's trick, lifted to the orchestration layer:
 *   draft model proposes a block of K            ->  a fast AUTHOR drafts K tasks in parallel
 *   confidence head + early-stop                 ->  deterministic `node --check` early-accepts code, no judge call
 *   target verifies the whole block in one pass  ->  BATCHED JUDGE: K drafts verified in ONE judge call
 *   residual sampling on rejected tokens         ->  TARGETED RE-DRAFT: only failed items recurse
 *   target cache                                 ->  DRAFT CACHE: verified blocks keyed by task signature
 *
 * The amortization (K judge calls -> 1) is the lever: easy work flies, hard work is scrutinized more
 * than a per-task judge, and the expensive judge runs a fraction as often. Models are injected via
 * lib/models.cjs (author + judge roles). Graceful at every stage; never throws.
 *
 *   const { specFuse } = require('./spec-fusion.cjs');
 *   const r = await specFuse([{ input: 'write slugify' }, { input: 'write debounce' }], { kind: 'code' });
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const models = require('./models.cjs');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.FUSION_DATA_DIR ? path.resolve(process.env.FUSION_DATA_DIR) : path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'draft-cache.jsonl');
const CACHE_TTL_MS = 7 * 864e5;   // verified blocks reusable for 7 days
const CACHE_MAX = 2000;           // newest-N retained on compaction
const BATCH_JUDGE_MAX = 8;        // items per single judge pass (chunked above this)
const CODE_KINDS = new Set(['code', 'debug', 'implementation', 'refactor', 'script', 'algo']);

function safe(fn, d) { try { return fn(); } catch { return d; } }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function clip(s, n) { return String(s || '').slice(0, n); }
function ensureData() { if (!fs.existsSync(DATA)) safe(() => fs.mkdirSync(DATA, { recursive: true })); }

// ── Draft cache (speculative target cache) ────────────────────────────────────────────────────
function sigOf(kind, input) { return crypto.createHash('sha1').update(String(kind || '') + ':' + norm(input)).digest('hex'); }
function cacheLoad() {
  try {
    const byKey = new Map();
    for (const l of fs.readFileSync(CACHE, 'utf8').trim().split('\n').filter(Boolean)) {
      safe(() => { const e = JSON.parse(l); if (e && e.sig) byKey.set(e.sig, e); }); // last-wins
    }
    const now = Date.now();
    for (const [k, e] of byKey) if (now - Date.parse(e.ts || 0) > CACHE_TTL_MS) byKey.delete(k); // TTL
    return byKey;
  } catch { return new Map(); }
}
function cacheGet(map, kind, input) { const e = map.get(sigOf(kind, input)); return e ? e.output : null; }
function cachePut(kind, input, output) {
  ensureData();
  safe(() => {
    const e = { sig: sigOf(kind, input), kind, ts: new Date().toISOString(), output };
    let lead = '';
    try { const b = fs.readFileSync(CACHE, 'utf8'); if (b.length && !b.endsWith('\n')) lead = '\n'; } catch {}
    fs.appendFileSync(CACHE, lead + JSON.stringify(e) + '\n');
  });
}
/** Compact the append-only cache to the newest CACHE_MAX live entries (best-effort). */
function cacheCompact() {
  safe(() => {
    const entries = [...cacheLoad().values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-CACHE_MAX);
    const tmp = CACHE + '.tmp';
    fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    fs.renameSync(tmp, CACHE);
  });
}

// ── Confidence head: deterministic `node --check` (grounded early-accept) ──────────────────────
function looksJS(text) {
  const t = String(text || '');
  if (/\bdef\s+\w+\s*\(|^\s*import\s+\w+\s*$/m.test(t)) return false; // python tell -> not JS
  return /\b(require\(|module\.exports|=>|function\s|const\s|let\s|console\.)/.test(t);
}
function extractCode(text) {
  const m = String(text || '').match(/```[a-z]*\n([\s\S]*?)```/i);
  return (m ? m[1] : String(text || '')).trim();
}
/** Deterministic check for a candidate. { applicable, pass, signal } — applicable:false when no grounded check fits. */
function deterministicCheck(kind, text) {
  if (!CODE_KINDS.has(String(kind || '').toLowerCase())) return { applicable: false, pass: false, signal: '' };
  const code = extractCode(text);
  if (!code || !looksJS(code)) return { applicable: false, pass: false, signal: '' };
  const tmp = path.join(os.tmpdir(), `fusion-${process.pid}-${crypto.randomBytes(4).toString('hex')}.cjs`);
  try { fs.writeFileSync(tmp, code + '\n'); } catch { return { applicable: false, pass: false, signal: '' }; }
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return { applicable: true, pass: r.status === 0, signal: r.status === 0 ? '' : clip(r.stderr || r.stdout || 'node --check failed', 400) };
  } catch (e) { return { applicable: false, pass: false, signal: e.message }; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function deterministicPass(kind, text) { const d = deterministicCheck(kind, text); return d.applicable && d.pass; }

// ── In-process concurrency cap ─────────────────────────────────────────────────────────────────
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(lanes);
  return out;
}

// ── Stage 1: speculative draft ─────────────────────────────────────────────────────────────────
async function draftOne(item, kind, opts) {
  const isCode = CODE_KINDS.has(kind);
  const sys = `You are the AUTHOR. Produce the first complete, correct, ship-ready solution; a verifier will check it next, so make it strong and self-contained. No preamble, no meta.${isCode ? ' Production-grade code only: fully correct incl. edge cases + error handling, idiomatic, NO placeholders/TODOs/stubs. Output the complete runnable solution.' : ''}`;
  try {
    const r = await models.author(sys, String(item.input) + (item.context ? `\n\n[CONTEXT]\n${item.context}` : ''), { ...opts, kind, max_tokens: opts.max_tokens || 2000, timeout: opts.modelTimeout || 90000 });
    const text = (r && r.text) ? r.text : '';
    return { drafter: (r && r.model) || 'author', text, ok: !!text };
  } catch (e) { return { drafter: 'author', text: '', ok: false, err: e.message }; }
}

// ── Stage 3: batched judge (block verify — ONE judge pass over the whole block) ─────────────────
const SENTINEL = /@@ITEM\s+(\d+)@@[\s\S]*?VERDICT:\s*(accept|revise)[^\n]*\n@@FINAL@@\n([\s\S]*?)@@END@@/gi;
function buildJudgePrompt(items, kind) {
  const isCode = CODE_KINDS.has(kind);
  const sys = `You are the FINAL JUDGE / RE-MODIFIER for a batch of independent tasks, all of one KIND (named on the last line). For EACH item you see its TASK and a CANDIDATE answer. Work A-D internally per item, then output the final:
A) CORRECTNESS — verify the task is fully + correctly solved; for code/algorithm kinds mentally EXECUTE the critical path and fix any bug, off-by-one, wrong API, unhandled case; for other kinds check every claim.
B) HALLUCINATION SWEEP — remove/qualify any unsupported specific (number, name, date, URL, citation, API signature).
C) FLOOR — your final MUST be at least as strong as the best single expert would produce; never weaker than the candidate.
D) ELEVATE — the FLOOR is the minimum; if YOU can make it materially better, DO IT NOW.
VERDICT = "accept" if the candidate already meets your ceiling (FINAL = the candidate, lightly polished); "revise" if you materially improved it (FINAL = your improved version).${isCode ? ' For code kinds FINAL must be the COMPLETE runnable solution, no diff/notes.' : ''}
Output EXACTLY one block per item, nothing else between blocks:
@@ITEM <n>@@
VERDICT: accept|revise
@@FINAL@@
<the complete final answer for item n>
@@END@@
KIND: ${kind}`;
  const user = items.map((it, i) => `@@ITEM ${i + 1}@@\nTASK:\n${clip(it.input, 3000)}\n\nCANDIDATE:\n${clip(it.draft, 4000)}`).join('\n\n');
  return { sys, user };
}
function parseJudge(text, n) {
  const out = new Array(n).fill(null);
  let m;
  SENTINEL.lastIndex = 0;
  while ((m = SENTINEL.exec(text)) !== null) {
    const i = (parseInt(m[1], 10) || 0) - 1;
    if (i >= 0 && i < n) out[i] = { verdict: m[2].toLowerCase(), final: m[3].trim() };
  }
  return out;
}
async function judgeBlock(items, kind, opts) {
  const { sys, user } = buildJudgePrompt(items, kind);
  const maxTok = Math.min(8000, 1300 * items.length + 1000);
  let jr; try { jr = await models.judge(sys, user, { ...opts, kind, max_tokens: maxTok, timeout: opts.judgeTimeout || 240000 }); } catch { jr = { text: '' }; }
  const parsed = (jr && jr.text) ? parseJudge(jr.text, items.length) : new Array(items.length).fill(null);
  return { verdicts: parsed, calls: 1 };
}

/**
 * specFuse(items, opts) — speculative BATCH fusion.
 * items: array of strings OR { input, context?, kind? }.
 * opts:  { kind, max_tokens, modelTimeout, judgeTimeout, maxResidualRounds=2, cache=true, concurrency, earlyExit=true }
 */
async function specFuse(items, opts = {}) {
  const started = Date.now();
  const list = (Array.isArray(items) ? items : [items]).map(it => (typeof it === 'string' ? { input: it } : { ...it }));
  if (!list.length) return { mode: 'spec', outputs: [], batch: 0, ms: 0 };
  const defKind = String(opts.kind || '').toLowerCase();
  for (const it of list) it.kind = String(it.kind || defKind || 'general').toLowerCase();
  const useCache = opts.cache !== false;
  const concurrency = Math.max(1, Math.min(opts.concurrency || 8, list.length, (os.cpus().length - 2) || 4));
  const maxResidual = Math.max(0, opts.maxResidualRounds != null ? opts.maxResidualRounds : 2);
  const batchJudgeMax = Math.max(1, Math.min(32, opts.batchJudgeMax || BATCH_JUDGE_MAX));

  let judgeCalls = 0, residualRounds = 0;
  const out = list.map(it => ({ input: it.input, kind: it.kind, output: '', drafter: null, cached: false, accepted: false, verdict: null, residual_round: 0 }));

  // 0. CACHE
  const cacheMap = useCache ? cacheLoad() : new Map();
  const pending = [];
  list.forEach((it, i) => {
    const hit = useCache ? cacheGet(cacheMap, it.kind, it.input) : null;
    if (hit) { out[i].output = hit; out[i].cached = true; out[i].accepted = true; out[i].verdict = 'cached'; }
    else pending.push(i);
  });

  // 1. SPECULATIVE DRAFT (parallel, capped)
  await mapLimit(pending, concurrency, async (i) => {
    const d = await draftOne(list[i], list[i].kind, opts);
    out[i].drafter = d.drafter; list[i]._draftText = d.text; list[i]._draftOk = d.ok;
  });

  // 2. CONFIDENCE HEAD (early-exit)
  const needJudge = [];
  for (const i of pending) {
    if (!list[i]._draftOk) { needJudge.push(i); continue; }
    if (opts.earlyExit !== false) {
      const det = deterministicCheck(list[i].kind, list[i]._draftText);
      if (det.applicable && det.pass) { out[i].output = list[i]._draftText; out[i].accepted = true; out[i].verdict = 'early-accept'; continue; }
    }
    needJudge.push(i);
  }

  // 3. BATCHED JUDGE (block verify — the amortization lever)
  for (let c = 0; c < needJudge.length; c += batchJudgeMax) {
    const idx = needJudge.slice(c, c + batchJudgeMax);
    const blockItems = idx.map(i => ({ input: list[i].input, draft: list[i]._draftText || '(draft failed — produce the solution from the task)' }));
    const { verdicts, calls } = await judgeBlock(blockItems, list[idx[0]].kind, opts);
    judgeCalls += calls;
    idx.forEach((i, j) => {
      const v = verdicts[j];
      if (v && v.final) { out[i].output = v.final; out[i].verdict = v.verdict; out[i].accepted = v.verdict === 'accept'; }
      else { out[i].output = list[i]._draftText || ''; out[i].verdict = 'judge-miss'; out[i].accepted = false; }
    });
  }

  // 4. RESIDUAL (targeted re-work)
  let residualSet = needJudge.filter(i => {
    if (!CODE_KINDS.has(list[i].kind)) return false;
    const det = deterministicCheck(list[i].kind, out[i].output);
    return det.applicable && !det.pass;
  });
  for (let round = 1; round <= maxResidual && residualSet.length; round++) {
    residualRounds++;
    await mapLimit(residualSet, concurrency, async (i) => {
      const det = deterministicCheck(list[i].kind, out[i].output);
      const fixItem = { input: list[i].input, context: `Previous attempt FAILED verification:\n${det.signal}\nFix it.`, kind: list[i].kind };
      const d = await draftOne(fixItem, list[i].kind, opts);
      list[i]._draftText = d.text || list[i]._draftText;
    });
    for (let c = 0; c < residualSet.length; c += batchJudgeMax) {
      const idx = residualSet.slice(c, c + batchJudgeMax);
      const blockItems = idx.map(i => ({ input: list[i].input, draft: list[i]._draftText || '' }));
      const { verdicts, calls } = await judgeBlock(blockItems, list[idx[0]].kind, opts);
      judgeCalls += calls;
      idx.forEach((i, j) => { const v = verdicts[j]; if (v && v.final) { out[i].output = v.final; out[i].verdict = v.verdict; out[i].accepted = v.verdict === 'accept'; out[i].residual_round = round; } });
    }
    residualSet = residualSet.filter(i => { const det = deterministicCheck(list[i].kind, out[i].output); return det.applicable && !det.pass; });
  }

  // 5. ACCEPT + CACHE
  let acceptedFirst = 0;
  out.forEach((o) => {
    if (o.cached) return;
    const firstPass = o.residual_round === 0 && (o.verdict === 'early-accept' || o.verdict === 'accept');
    if (firstPass) acceptedFirst++;
    if (useCache && o.output) {
      const det = deterministicCheck(o.kind, o.output);
      const cacheable = det.applicable ? det.pass : (o.accepted || o.verdict === 'accept' || o.verdict === 'revise');
      if (cacheable) cachePut(o.kind, o.input, o.output);
    }
  });

  const nonCached = out.filter(o => !o.cached).length;
  const ms = Date.now() - started;
  return { mode: 'spec', outputs: out, batch: out.length, cached: out.length - nonCached, accepted_first_pass: acceptedFirst, residual_rounds: residualRounds, judge_calls: judgeCalls, acceptance_rate: nonCached ? +(acceptedFirst / nonCached).toFixed(2) : null, ms };
}

module.exports = { specFuse, deterministicPass, deterministicCheck, sigOf, cacheCompact, mapLimit };
