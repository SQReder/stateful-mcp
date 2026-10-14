import { z } from 'zod';

export interface Snapshot { path: string; content: string; contentHash: string; estimatedTokens: number }
export interface Edit { search: string; replace: string }
/** One file of a candidate: the generation-time base (null for a new file), the resulting full text and the edits as the model wrote them. */
export interface CandidateFile { readonly path: string; readonly base: Snapshot | null; readonly content: string; readonly diff: string; readonly edits?: Edit[] }
export interface Problem { code: string; message: string; path?: string; edit?: number }

// Long anchors break on JSON escaping and drift from the snapshot; several short edits or a whole-file content work better.
export const MAX_SEARCH_LINES = 12;
// Old x new lines of the changed middle; above it the middle is shown as one replaced block instead of running LCS.
const LCS_CELL_LIMIT = 1_000_000, DIFF_CONTEXT = 3;
// The closest-line hint compares at most this many characters per line, so its cost stays linear in the file size.
const SIMILARITY_CHARS = 200;
const BOM = '﻿';
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```$/i;
const COMMENT = String.raw`(?:\/\/|#|\/\*+|\*|<!--|\{\/\*)`, DOTS = String.raw`(?:\.{3}|…)`;
// Lines that stand for omitted code: `...` alone (optionally commented) or comments such as `// rest of the code`, `// existing code`,
// `// other cases unchanged`. Spread syntax (`...args`) never stands alone on a line, and an ordinary comment like
// `// value stays unchanged` passes: "unchanged" counts only after a word that refers to omitted code (rest, other, remaining…).
const PLACEHOLDER = new RegExp([
  String.raw`^\s*(?:${COMMENT}\s*)?${DOTS}\s*(?:\*\/\}?|-->)?\s*$`,
  String.raw`^\s*${COMMENT}.*(?:\brest\s+of\s+(?:the\s+)?(?:code|file)\b|\bexisting\s+code\b)`,
  String.raw`^\s*(?:\/\/|#|\/\*+)\s*${DOTS}?\s*\(?(?:rest|others?|remaining|everything|existing|previous)\b[\w\s-]*\bunchanged\)?\s*${DOTS}?\s*(?:\*\/)?\s*$`,
].join('|'), 'i');
// `12 | code` (optionally right-aligned) or `12: code` at column 0; indented `1: 'one'` object keys do not count.
const LINE_NUMBER = /^(?:\s*\d+\s*\|(?:\s|$)|\d+:\s)/;

const editSchema = z.object({ search: z.string(), replace: z.string() }).strict();
const replySchema = z.object({ files: z.array(z.object({ path: z.string(), edits: z.array(editSchema).optional(), content: z.string().optional() }).strict()).min(1) }).strict();
const legacySchema = z.object({ path: z.string(), content: z.string() }).strict();

const lf = (text: string): string => text.replaceAll('\r\n', '\n');
const lineEndings = (text: string): 'lf' | 'crlf' | 'mixed' => {
  const crlf = text.includes('\r\n'), lone = /(?<!\r)\n/.test(text);
  return crlf && lone ? 'mixed' : crlf ? 'crlf' : 'lf';
};
/** Start indexes where `needle` equals a run of whole lines, compared through `key`. */
const occurrences = (lines: string[], needle: string[], key = (line: string): string => line): number[] => {
  const want = needle.map(key), found: number[] = [];
  for (let start = 0; start + want.length <= lines.length; start++) if (want.every((line, offset) => key(lines[start + offset]) === line)) found.push(start);
  return found;
};
const bigrams = (line: string): Set<string> => {
  const text = line.trim().slice(0, SIMILARITY_CHARS), grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index++) grams.add(text.slice(index, index + 2));
  return grams;
};
/** Index of the line most similar to `target` (Dice coefficient on character bigrams). */
const closest = (lines: string[], target: string): number => {
  const want = bigrams(target);
  let best = 0, bestScore = -1;
  lines.forEach((line, index) => {
    const grams = bigrams(line);
    let shared = 0;
    for (const gram of grams) if (want.has(gram)) shared++;
    const score = 2 * shared / (grams.size + want.size || 1);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return best;
};
const show = (char: string | undefined): string => char === undefined ? 'end of line' : JSON.stringify(char);

/** Hint for a search block that matches nowhere: an indentation-only difference, or the first differing line and column near the closest line. */
function notFound(lines: string[], needle: string[]): string {
  const advice = ' Copy complete lines exactly from the target snapshot; an existing file may instead be replaced with its complete "content".';
  const loose = occurrences(lines, needle, line => line.replace(/\s+/g, ' ').trim());
  if (loose.length === 1) {
    return `"search" differs only in indentation/whitespace from lines ${loose[0] + 1}-${loose[0] + needle.length}, which are exactly: ${JSON.stringify(lines.slice(loose[0], loose[0] + needle.length).join('\n'))}.${advice}`;
  }
  const first = needle.findIndex(line => line.trim()), start = closest(lines, needle[first]) - first;
  for (let offset = 0; offset < needle.length; offset++) {
    const actual = lines[start + offset], wanted = needle[offset];
    if (actual === wanted) continue;
    if (actual === undefined) return `"search" not found; the closest match starts at line ${start + first + 1}, but the file has no line ${start + offset + 1} for search line ${offset + 1}.${advice}`;
    let column = 0;
    while (wanted[column] === actual[column]) column++;
    return `"search" not found; closest: search line ${offset + 1} vs line ${start + offset + 1} ${JSON.stringify(actual)}, first difference at column ${column + 1} (search has ${show(wanted[column])}, file has ${show(actual[column])}).${advice}`;
  }
  return `"search" not found.${advice}`;
}

/** Why `text` (a replace block or whole-file content) is not real code, if it is not. */
function filler(text: string): { code: string; message: string } | undefined {
  const lines = text.split(/\r?\n/), placeholder = lines.findIndex(line => PLACEHOLDER.test(line));
  if (placeholder >= 0) return { code: 'placeholder', message: `line ${placeholder + 1} ${JSON.stringify(lines[placeholder].trim())} stands for omitted code; write the complete code (edits already leave the rest of the file as it is).` };
  const filled = lines.filter(line => line.trim());
  if (filled.length && filled.filter(line => LINE_NUMBER.test(line)).length * 2 > filled.length) {
    return { code: 'line_numbers', message: 'lines start with line-number prefixes such as "12 | " or "12: "; write the code without them.' };
  }
}

/** Applies `edits` to the base in LF, keeping CRLF and a BOM; reports every failing edit and returns undefined if any failed. */
function applyEdits(base: string, edits: Edit[], problem: (code: string, message: string, edit?: number) => void): string | undefined {
  const endings = lineEndings(base);
  if (endings === 'mixed') return void problem('mixed_line_endings', 'the file mixes CRLF and LF line endings, which edits cannot keep; replace the whole file with its complete "content".');
  const bom = base.startsWith(BOM), text = lf(bom ? base.slice(1) : base), trailing = text.endsWith('\n');
  let lines = (trailing ? text.slice(0, -1) : text).split('\n'), failed = false;
  edits.forEach((edit, index) => {
    const fail = (code: string, message: string): void => { failed = true; problem(code, message, index); };
    const search = lf(edit.search).replace(/\n$/, ''), replace = lf(edit.replace).replace(/\n$/, ''), needle = search.split('\n');
    if (!search.trim()) return fail('invalid_candidate', `"search" is blank; copy 1-${MAX_SEARCH_LINES} complete lines from the target.`);
    if (needle.length > MAX_SEARCH_LINES) return fail('search_too_long', `"search" has ${needle.length} lines; use at most ${MAX_SEARCH_LINES} distinctive lines, or split the change into several edits.`);
    const bad = filler(replace);
    if (bad) return fail(bad.code, `"replace": ${bad.message}`);
    const found = occurrences(lines, needle);
    if (found.length > 1) return fail('search_ambiguous', `"search" matches ${found.length} times (lines ${found.map(start => start + 1).join(', ')}); add neighbouring lines to make it unique.`);
    if (!found.length) return fail('search_not_found', notFound(lines, needle));
    lines = [...lines.slice(0, found[0]), ...(replace ? replace.split('\n') : []), ...lines.slice(found[0] + needle.length)];
  });
  if (failed) return undefined;
  const result = lines.join('\n') + (trailing ? '\n' : '');
  return (bom ? BOM : '') + (endings === 'crlf' ? result.replaceAll('\n', '\r\n') : result);
}

/**
 * Builds candidate files from a worker reply against the generation-time `targets`. Atomic: any problem in any file means no files,
 * and every problem found is returned so the worker can fix them all in one turn.
 */
export function parseCandidate(reply: string, targets: Array<{ path: string; base: Snapshot | null }>, maxBytes: number): { files: CandidateFile[] } | { problems: Problem[] } {
  const fenced = FENCE.exec(reply.trim());
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : reply); } catch {
    return { problems: [{ code: 'invalid_candidate', message: 'Reply is not one JSON object; return only {"files":[...]} without other text.' }] };
  }
  const legacy = typeof value === 'object' && value !== null && !('files' in value);
  const parsed = legacy ? legacySchema.safeParse(value) : replySchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'reply'}: ${issue.message}`).join('; ');
    return { problems: [{ code: 'invalid_candidate', message: `Reply must be {"files":[{"path", "edits" or "content"}]} without other fields: ${issues}` }] };
  }
  const entries: Array<{ path: string; edits?: Edit[]; content?: string }> = 'files' in parsed.data ? parsed.data.files : [parsed.data];
  const problems: Problem[] = [], files: CandidateFile[] = [], seen = new Set<string>();
  for (const entry of entries) {
    const problem = (code: string, message: string, edit?: number): void => {
      problems.push({ code, message: `${entry.path}${edit === undefined ? '' : ` edits[${edit}]`}: ${message}`, path: entry.path, ...(edit === undefined ? {} : { edit }) });
    };
    const target = targets.find(target => target.path === entry.path);
    if (!target) { problem('invalid_path', `not one of allowedPaths (${targets.map(target => target.path).join(', ')}).`); continue; }
    if (seen.has(entry.path)) { problem('invalid_path', 'appears more than once; put all edits of a file into one entry.'); continue; }
    seen.add(entry.path);
    const { base } = target;
    if (base === null && entry.edits !== undefined) { problem('invalid_candidate', 'is a new file: give its complete "content"; edits need an existing file.'); continue; }
    if ((entry.edits === undefined) === (entry.content === undefined) || entry.edits?.length === 0) {
      problem('invalid_candidate', 'give exactly one of a non-empty "edits" list or the complete "content".');
      continue;
    }
    let content: string | undefined;
    if (entry.edits) content = applyEdits(base!.content, entry.edits, problem);
    else if (!entry.content!.trim()) problem('invalid_candidate', '"content" is blank; give the complete file.');
    else {
      const bad = filler(entry.content!);
      if (bad) problem(bad.code, `"content": ${bad.message}`);
      // A whole-file replacement keeps the base's CRLF endings and BOM, like edits do.
      else content = base && lineEndings(base.content) === 'crlf' ? entry.content!.replace(/\r?\n/g, '\r\n') : entry.content!;
      if (content !== undefined && base?.content.startsWith(BOM) && !content.startsWith(BOM)) content = BOM + content;
    }
    if (content === undefined) continue;
    // Apply and restore compare files through budget-limited reads, so a larger candidate could never be recognised and restored.
    if (Buffer.byteLength(content, 'utf8') > maxBytes) { problem('too_large', `the resulting file exceeds ${maxBytes} bytes.`); continue; }
    files.push({ path: entry.path, base, content, diff: unifiedDiff(entry.path, base?.content ?? null, content), ...(entry.edits ? { edits: entry.edits } : {}) });
  }
  return problems.length ? { problems } : { files };
}

/** Minimal unified diff (3 lines of context) from `base` (null: new file) to `content`. */
export function unifiedDiff(path: string, base: string | null, content: string): string {
  if (base === content) return '';
  // A last line without a newline keeps a trailing '\n' marker, so it differs from the same text with a newline.
  const split = (text: string): string[] => {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop(); else lines[lines.length - 1] += '\n';
    return lines;
  };
  const before = split(base ?? ''), after = split(content);
  let head = 0, tail = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const ops = [...before.slice(0, head).map(line => ' ' + line), ...middle(before.slice(head, before.length - tail), after.slice(head, after.length - tail)),
    ...before.slice(before.length - tail).map(line => ' ' + line)];
  const changed = ops.flatMap((op, index) => op[0] === ' ' ? [] : [index]);
  let diff = `--- ${base === null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n`;
  for (let first = 0; first < changed.length;) {
    let last = first;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] - 1 <= 2 * DIFF_CONTEXT) last++;
    const from = Math.max(0, changed[first] - DIFF_CONTEXT), hunk = ops.slice(from, changed[last] + DIFF_CONTEXT + 1);
    const count = (ops: string[], skip: string): number => ops.filter(op => op[0] !== skip).length;
    const oldBefore = count(ops.slice(0, from), '+'), newBefore = count(ops.slice(0, from), '-'), oldCount = count(hunk, '+'), newCount = count(hunk, '-');
    diff += `@@ -${oldCount ? oldBefore + 1 : oldBefore},${oldCount} +${newCount ? newBefore + 1 : newBefore},${newCount} @@\n`
      + hunk.map(op => op.endsWith('\n') ? `${op}\\ No newline at end of file\n` : `${op}\n`).join('');
    first = last + 1;
  }
  return diff;
}

/** Edit script for the changed middle: LCS when small enough, otherwise all old lines removed and all new lines added. */
function middle(before: string[], after: string[]): string[] {
  if (before.length * after.length > LCS_CELL_LIMIT) return [...before.map(line => '-' + line), ...after.map(line => '+' + line)];
  const width = after.length + 1, common = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i * width + j] = before[i] === after[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const ops: string[] = [];
  for (let i = 0, j = 0; i < before.length || j < after.length;) {
    if (i < before.length && j < after.length && before[i] === after[j]) { ops.push(' ' + before[i++]); j++; }
    else if (j === after.length || (i < before.length && common[(i + 1) * width + j] >= common[i * width + j + 1])) ops.push('-' + before[i++]);
    else ops.push('+' + after[j++]);
  }
  return ops;
}
