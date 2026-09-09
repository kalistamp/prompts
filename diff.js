/* ============================================================
   PROMPT STUDIO — line diff

   A prompt is prose, and the useful question when comparing two
   versions of one is "which lines moved", not "which characters".
   So this is a line-level LCS, rendered as a run of same/add/remove
   rows.

   Written rather than imported: the CSP admits no script origins
   beyond the pinned Supabase bundle, and a diff this small is not
   worth widening it for.
   ============================================================ */

(function () {
  'use strict';

  /* The LCS table is O(before x after) in memory. Prompts are short
     enough that this never matters, but a pasted transcript could be
     thousands of lines, and a 5000x5000 table is 25M cells — enough
     to hang the tab. Past the cap, fall back to reporting the whole
     body as replaced, which is accurate if coarse. */
  const MAX_CELLS = 4000000;

  function splitLines(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return text.split('\n');
  }

  /**
   * @returns {Array<{type:'same'|'add'|'remove', text:string}>}
   */
  function diffLines(before, after) {
    const a = splitLines(before);
    const b = splitLines(after);

    if (a.length * b.length > MAX_CELLS) {
      return [
        ...a.map(text => ({ type: 'remove', text })),
        ...b.map(text => ({ type: 'add', text }))
      ];
    }

    // lengths[i][j] = LCS length of a[i..] and b[j..]
    const lengths = [];
    for (let i = 0; i <= a.length; i += 1) lengths.push(new Uint32Array(b.length + 1));

    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        lengths[i][j] = a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
      }
    }

    const rows = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        rows.push({ type: 'same', text: a[i] });
        i += 1;
        j += 1;
      } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
        rows.push({ type: 'remove', text: a[i] });
        i += 1;
      } else {
        rows.push({ type: 'add', text: b[j] });
        j += 1;
      }
    }
    while (i < a.length) { rows.push({ type: 'remove', text: a[i] }); i += 1; }
    while (j < b.length) { rows.push({ type: 'add', text: b[j] }); j += 1; }

    return rows;
  }

  function summarise(rows) {
    let added = 0;
    let removed = 0;
    rows.forEach(row => {
      if (row.type === 'add') added += 1;
      else if (row.type === 'remove') removed += 1;
    });
    return { added, removed, changed: added > 0 || removed > 0 };
  }

  /* Long runs of identical lines are noise in a diff of a 200-line
     prompt. Keep `context` unchanged lines either side of a change
     and replace the rest with a gap marker. */
  function collapse(rows, context = 3) {
    const keep = new Array(rows.length).fill(false);
    rows.forEach((row, index) => {
      if (row.type === 'same') return;
      for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k += 1) {
        keep[k] = true;
      }
    });

    const out = [];
    let skipped = 0;
    rows.forEach((row, index) => {
      if (keep[index]) {
        if (skipped > 0) {
          out.push({ type: 'gap', text: `${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'}` });
          skipped = 0;
        }
        out.push(row);
      } else {
        skipped += 1;
      }
    });
    if (skipped > 0) out.push({ type: 'gap', text: `${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'}` });
    return out;
  }

  window.PromptDiff = { diffLines, summarise, collapse, MAX_CELLS };
})();
