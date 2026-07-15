'use strict';
/**
 * echo-model.cjs — the deterministic built-in model adapter.
 *
 * It performs NO network calls and needs NO API key. Its only job is to make every QUORUM lane
 * run end-to-end for tests, demos, and CI: the author emits a valid stub (syntactically correct
 * JS for code kinds, so node --check passes and early-accept fires), cross-watch echoes it, and
 * the judge speaks the two prompt shapes QUORUM uses — the batched @@ITEM@@ sentinel format used
 * by spec-fusion, and the single-candidate format used by full-fusion.
 *
 * Replace this with a real adapter (see examples/models-echo.cjs) by setting QUORUM_MODELS.
 */

function isCodeKind(opts) {
  const k = String((opts && opts.kind) || '').toLowerCase();
  return ['code', 'debug', 'implementation', 'refactor', 'script', 'algo'].includes(k);
}

// A valid, node --check-passing stub so code lanes have something concrete to verify.
function codeStub(prompt) {
  const name = (String(prompt).toLowerCase().match(/\b([a-z][a-z0-9]{2,20})\b/) || [, 'solution'])[1];
  return '```js\n' +
    `// echo-model stub for: ${String(prompt).slice(0, 60).replace(/\n/g, ' ')}\n` +
    `function ${name}(input) {\n  // TODO: replace the built-in echo model with a real one via QUORUM_MODELS\n  return input;\n}\n` +
    `module.exports = ${name};\n` +
    '```';
}

async function author(system, prompt, opts = {}) {
  if (isCodeKind(opts)) return { text: codeStub(prompt), model: 'echo' };
  const first = String(prompt).split('\n').find(Boolean) || String(prompt);
  return { text: `Echo draft — ${first.slice(0, 200)}`, model: 'echo' };
}

async function crossWatch(system, prompt, opts = {}) {
  // The refine prompt embeds the draft after a "DRAFT:" marker; echo it back unchanged.
  const m = String(prompt).match(/DRAFT:\n([\s\S]*)$/);
  const draft = m ? m[1].trim() : String(prompt);
  return { text: draft, model: 'echo' };
}

// Parse "CANDIDATE:\n...", stopping at the next sentinel/section if present.
function extractCandidate(block) {
  const m = block.match(/CANDIDATE:\n([\s\S]*?)(?:\n@@END@@|\n@@ITEM|\s*$)/);
  return m ? m[1].trim() : '';
}

async function judge(system, user, opts = {}) {
  const text = String(user || '');
  if (text.includes('@@ITEM')) {
    // Batched (spec-fusion) shape: emit one accept block per item, FINAL = the candidate.
    const blocks = [];
    const re = /@@ITEM\s+(\d+)@@[\s\S]*?CANDIDATE:\n([\s\S]*?)(?=\n@@ITEM|\s*$)/g;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const n = mm[1];
      const cand = mm[2].trim();
      blocks.push(`@@ITEM ${n}@@\nVERDICT: accept\n@@FINAL@@\n${cand}\n@@END@@`);
    }
    return { text: blocks.join('\n\n'), model: 'echo' };
  }
  // Single-candidate (full-fusion) shape: return the candidate as the accepted final.
  const cand = extractCandidate(text);
  return { text: cand || 'Echo judge: no candidate found.', model: 'echo' };
}

module.exports = { author, crossWatch, judge };
