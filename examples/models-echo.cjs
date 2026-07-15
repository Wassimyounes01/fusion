'use strict';
/*
 * models-echo.cjs — a copyable FUSION_MODELS adapter template.
 *
 * Fusion injects three roles through this module:
 *   author(system, prompt, opts)      -> { text, model? }   // drafts the first solution
 *   crossWatch(system, prompt, opts)  -> { text, model? }   // critiques + refines a draft (optional; omit to reuse author)
 *   judge(system, prompt, opts)       -> { text, model? }   // final correctness + elevate pass
 *
 * `opts` includes { kind, max_tokens, timeout, ... }. Return the model's text; Fusion handles
 * routing, node --check gating, batching, and caching around you.
 *
 * Use it:  FUSION_MODELS=./examples/models-echo.cjs node lib/fusion.cjs --full "design a rate limiter"
 *
 * To wire a REAL provider, replace `call()` with an HTTP request to your model. A single
 * chat-completions call is enough for all three roles; give each a different model or temperature
 * if you like (e.g. a cheap author, a stronger judge). Sketch:
 *
 *   async function call(system, prompt, { max_tokens = 1024 } = {}, model = 'your-model') {
 *     const res = await fetch('https://api.your-provider.com/v1/chat/completions', {
 *       method: 'POST',
 *       headers: { 'Authorization': `Bearer ${process.env.YOUR_API_KEY}`, 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ model, max_tokens, messages: [
 *         { role: 'system', content: system }, { role: 'user', content: prompt } ] }),
 *     });
 *     const j = await res.json();
 *     return { text: j.choices?.[0]?.message?.content || '', model };
 *   }
 *   module.exports = {
 *     author:     (s, p, o) => call(s, p, o, 'cheap-fast-model'),
 *     crossWatch: (s, p, o) => call(s, p, o, 'cheap-fast-model'),
 *     judge:      (s, p, o) => call(s, p, o, 'strong-model'),
 *   };
 *
 * The stub below is deterministic and offline so this file runs as-is.
 */

async function call(system, prompt, opts = {}, model = 'echo-adapter') {
  const line = String(prompt).split('\n').find(Boolean) || String(prompt);
  return { text: `[${model}] ${line.slice(0, 200)}`, model };
}

module.exports = {
  author: (s, p, o) => call(s, p, o, 'echo-author'),
  crossWatch: (s, p, o) => call(s, p, o, 'echo-crosswatch'),
  judge: (s, p, o) => call(s, p, o, 'echo-judge'),
};
