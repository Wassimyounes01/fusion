'use strict';
/**
 * models.cjs — the injectable model layer shared by every Fusion lane.
 *
 * Fusion never calls a specific vendor. Instead it resolves three roles through an adapter:
 *   author(system, prompt, opts)      -> { text, model? }   // drafts the first solution
 *   crossWatch(system, prompt, opts)  -> { text, model? }   // critiques + refines a draft
 *   judge(system, prompt, opts)       -> { text, model? }   // final correctness + elevate pass
 *
 * Set env FUSION_MODELS to a module path exporting those three functions to use real models
 * (see examples/models-echo.cjs). If it's unset or invalid, a deterministic built-in echo model
 * runs every lane with no API key — so tests, demos, and CI work out of the box.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
let _cache = null;

function resolveModels() {
  if (_cache) return _cache;
  const p = process.env.FUSION_MODELS;
  if (p) {
    try {
      const m = require(path.isAbsolute(p) ? p : path.resolve(ROOT, p));
      if (m && typeof m.author === 'function' && typeof m.judge === 'function') {
        // crossWatch is optional — fall back to author if an adapter omits it.
        _cache = {
          author: m.author,
          crossWatch: typeof m.crossWatch === 'function' ? m.crossWatch : m.author,
          judge: m.judge,
          source: p,
        };
        return _cache;
      }
    } catch { /* fall through to echo */ }
  }
  _cache = require('./echo-model.cjs');
  _cache.source = 'echo';
  return _cache;
}

module.exports = {
  get author() { return resolveModels().author; },
  get crossWatch() { return resolveModels().crossWatch; },
  get judge() { return resolveModels().judge; },
  source() { return resolveModels().source; },
  // test hook: force re-resolution after changing env in-process
  _reset() { _cache = null; },
};
