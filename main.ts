// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** For a path that arrived here by a move, the path it had before the patch (or the path it was created at). */
  readonly movedFrom = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Section 5: matching lines, and file line handling (Sections 3, 5) ----------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Positions where O occurs in lines at the given tier, at or after `from`. */
function occurrencesAt(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** A line of N: a context line (written as the file's own matched line) or an added line. */
type NewLine = { ctx: number } | { text: string };

/** Render N at a match: context lines come from the file, other lines are re-indented at tier 2. */
function renderNew(n: NewLine[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const f = tier === 2 && o.length > 0 ? leadWS(fileLines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWS(o[0]!) : '';
  return n.map((e) => {
    if ('ctx' in e) return fileLines[pos + e.ctx]!;
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

type BodyKind = 'ctx' | 'old' | 'new' | 'back';
interface BodyLine {
  kind: BodyKind;
  text: string;
  raw: string;
}

// ---------- Section 6: unified diffs ----------

interface UniHunk {
  a: number;
  o: string[];
  n: NewLine[];
  backslashAfterLastCtxPlus: boolean;
  plus: string[];
  lastPlusBackslash: boolean | null;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  fromDash: boolean;
  hunks: UniHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.*?) b\/(.*)$/;

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(s: string): string | null {
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', raw: l });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), raw: l });
      i++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), raw: l });
      i++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), raw: l });
      i++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'back', text: l.slice(1), raw: l });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw.trim() === '') body.pop();
  return { body, next: i };
}

function buildUniHunk(a: number, body: BodyLine[]): UniHunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  const plus: string[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ ctx: o.length - 1 });
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') {
      n.push({ text: b.text });
      plus.push(b.text);
    }
  }
  let backslashAfterLastCtxPlus = false;
  let lastPlusBackslash: boolean | null = null;
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') {
      backslashAfterLastCtxPlus = j + 1 < body.length && body[j + 1]!.kind === 'back';
      break;
    }
  }
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'new') {
      lastPlusBackslash = j + 1 < body.length && body[j + 1]!.kind === 'back';
      break;
    }
  }
  return { a, o, n, backslashAfterLastCtxPlus, plus, lastPlusBackslash };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const dg = DIFF_GIT_RE.exec(l);
      if (dg === null || dg[1] === '' || dg[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: dg[1]!, newPath: dg[2]!, isCreate: false, isDelete: false, fromDash: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.fromDash = true;
      } else {
        cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, fromDash: true, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        if (!cur.fromDash) cur.oldPath = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.fromDash) cur.newPath = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      const hm = HUNK_RE.exec(l);
      if (hm !== null) {
        const { body, next } = parseHunkBody(lines, i + 1);
        cur.hunks.push(buildUniHunk(Number(hm[1]), body));
        inHeader = false;
        i = next;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur !== null) {
      const hm = HUNK_RE.exec(l);
      if (hm !== null) {
        const { body, next } = parseHunkBody(lines, i + 1);
        cur.hunks.push(buildUniHunk(Number(hm[1]), body));
        i = next;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return sections;
}

function applyUniHunks(f: FileLines, hunks: UniHunk[], strict: boolean, errPath: string): FileLines {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const rendered = renderNew(h.n, cur.lines, pos, 0, []);
      const lines = [...cur.lines];
      lines.splice(pos, 0, ...rendered);
      let finalBreak = cur.finalBreak;
      if (pos === cur.lines.length) finalBreak = !h.backslashAfterLastCtxPlus;
      cur = { br: cur.br, lines, finalBreak };
      d += h.n.length;
      continue;
    }
    const found = findTier(cur.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', errPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rendered = renderNew(h.n, cur.lines, best, found.tier, h.o);
    const lines = [...cur.lines];
    lines.splice(best, h.o.length, ...rendered);
    let finalBreak = cur.finalBreak;
    if (best + h.o.length === cur.lines.length) finalBreak = !h.backslashAfterLastCtxPlus;
    cur = { br: cur.br, lines, finalBreak };
    d += h.n.length - h.o.length;
  }
  return cur;
}

function unifiedEdits(sections: UniSection[], strict: boolean): Edit[] {
  return sections.map(
    (s): Edit =>
      (tree) => {
        const create = s.oldPath === null || s.isCreate;
        const del = !create && (s.newPath === null || s.isDelete);
        if (create) {
          const np = s.newPath ?? '';
          if (!safe(np)) throw new Fail('unsafe', np);
          if (tree.get(np) !== null) throw new Fail('exists', np);
          const plusLines: string[] = [];
          let lastPlusBackslash = false;
          let havePlus = false;
          for (const h of s.hunks) {
            plusLines.push(...h.plus);
            if (h.lastPlusBackslash !== null) {
              havePlus = true;
              lastPlusBackslash = h.lastPlusBackslash;
            }
          }
          const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (!havePlus || !lastPlusBackslash ? '\n' : '');
          tree.now.set(np, text);
          return;
        }
        if (del) {
          const op = s.oldPath ?? '';
          if (!safe(op)) throw new Fail('unsafe', op);
          if (tree.get(op) === null) throw new Fail('missing', op);
          tree.now.set(op, null);
          return;
        }
        const op = s.oldPath!;
        const np = s.newPath!;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (op === np) {
          const after = applyUniHunks(splitFile(before), s.hunks, strict, op);
          const text = joinFile(after);
          if (text !== before) tree.now.set(op, text);
          return;
        }
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const after = applyUniHunks(splitFile(before), s.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, joinFile(after));
        const orig = tree.movedFrom.get(op) ?? op;
        tree.movedFrom.set(np, orig);
        tree.movedFrom.delete(op);
      },
  );
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map(
    (b): Edit =>
      (tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.oldLines.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
          tree.now.set(b.path, text);
          return;
        }
        const before = tree.get(b.path);
        if (before === null) throw new Fail('missing', b.path);
        const f = splitFile(before);
        const found = findTier(f.lines, b.oldLines, strict);
        if (found === null) throw new Fail('no-match', b.path);
        if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
        const pos = found.occ[0]!;
        const rendered = renderNew(
          b.newLines.map((t) => ({ text: t })),
          f.lines,
          pos,
          found.tier,
          b.oldLines,
        );
        const lines = [...f.lines];
        lines.splice(pos, b.oldLines.length, ...rendered);
        tree.now.set(b.path, joinFile({ ...f, lines }));
      },
  );
}

// ---------- Section 8: V4A patches ----------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

function v4aSectionKind(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
}

function buildV4AChunk(anchor: string | null, eof: boolean, body: BodyLine[]): V4AChunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ ctx: o.length - 1 });
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push({ text: b.text });
  }
  return { anchor, o, n, eof };
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = v4aSectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    if (kind === 'add') {
      const path = l.slice('*** Add File: '.length).trim();
      const content: string[] = [];
      i++;
      while (i < last) {
        const l2 = lines[i]!;
        if (v4aSectionKind(l2) !== null) break;
        if (blank(l2)) {
          content.push('');
          i++;
          continue;
        }
        if (l2.startsWith('+')) {
          content.push(l2.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      sections.push({ kind: 'add', path, lines: content });
      continue;
    }
    if (kind === 'delete') {
      const path = l.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path });
      i++;
      continue;
    }
    const headerLine = i + 1;
    const path = l.slice('*** Update File: '.length).trim();
    let moveTo: string | null = null;
    const chunks: V4AChunk[] = [];
    i++;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
    const finish = (trimEnd: boolean) => {
      if (cur !== null) {
        const body = [...cur.body];
        if (trimEnd) {
          while (body.length > 0 && body[body.length - 1]!.raw.trim() === '') body.pop();
        }
        chunks.push(buildV4AChunk(cur.anchor, cur.eof, body));
        cur = null;
      }
    };
    while (i < last) {
      const l2 = lines[i]!;
      if (v4aSectionKind(l2) !== null) break;
      if (l2.trim() === '*** End of File' && !l2.startsWith(' ')) {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        finish(false);
        i++;
        continue;
      }
      if (l2.startsWith('@@')) {
        finish(false);
        cur = { anchor: l2.slice(2).trim(), eof: false, body: [] };
        i++;
        continue;
      }
      if (l2 === '' || l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+')) {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, eof: false, body: [] };
        }
        const k: BodyKind = l2 === '' ? 'ctx' : l2[0] === ' ' ? 'ctx' : l2[0] === '-' ? 'old' : 'new';
        cur.body.push({ kind: k, text: l2 === '' ? '' : l2.slice(1), raw: l2 });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    finish(true);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    sections.push({ kind: 'update', path, moveTo, chunks });
  }
  return sections;
}

function v4aEdits(sections: V4ASection[], strict: boolean): Edit[] {
  return sections.map(
    (s): Edit =>
      (tree) => {
        if (s.kind === 'add') {
          if (!safe(s.path)) throw new Fail('unsafe', s.path);
          if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
          const text = s.lines.length === 0 ? '' : s.lines.join('\n') + '\n';
          tree.now.set(s.path, text);
          return;
        }
        if (s.kind === 'delete') {
          if (!safe(s.path)) throw new Fail('unsafe', s.path);
          if (tree.get(s.path) === null) throw new Fail('missing', s.path);
          tree.now.set(s.path, null);
          return;
        }
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
        const before = tree.get(s.path);
        if (before === null) throw new Fail('missing', s.path);
        if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
        let f = splitFile(before);
        let cursor = 0;
        for (const ch of s.chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const found = findTier(f.lines, [ch.anchor], strict, cursor);
            if (found === null) throw new Fail('no-match', s.path);
            cursor = found.occ[0]! + 1;
          }
          if (ch.o.length === 0) {
            const pos = ch.eof ? f.lines.length : cursor;
            const rendered = renderNew(ch.n, f.lines, pos, 0, []);
            const lines = [...f.lines];
            lines.splice(pos, 0, ...rendered);
            f = { br: f.br, lines, finalBreak: f.finalBreak };
            cursor = pos + rendered.length;
            continue;
          }
          const found = findTier(f.lines, ch.o, strict, cursor);
          if (found === null) throw new Fail('no-match', s.path);
          let pos: number | null = null;
          for (const p of found.occ) {
            if (ch.eof && p + ch.o.length !== f.lines.length) continue;
            pos = p;
            break;
          }
          if (pos === null) throw new Fail('no-match', s.path);
          const rendered = renderNew(ch.n, f.lines, pos, found.tier, ch.o);
          const lines = [...f.lines];
          lines.splice(pos, ch.o.length, ...rendered);
          f = { br: f.br, lines, finalBreak: f.finalBreak };
          cursor = pos + rendered.length;
        }
        const text = joinFile(f);
        if (s.moveTo !== null) {
          tree.now.set(s.path, null);
          tree.now.set(s.moveTo, text);
          const orig = tree.movedFrom.get(s.path) ?? s.path;
          tree.movedFrom.set(s.moveTo, orig);
          tree.movedFrom.delete(s.path);
        } else if (text !== before) {
          tree.now.set(s.path, text);
        }
      },
  );
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(parseUnified(lines), strict)
          : kind === 'search-replace'
            ? srEdits(parseSR(lines), strict)
            : v4aEdits(parseV4A(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoves) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rPairs = new Map<string, string>();
  for (const [np, orig] of tree.movedFrom) {
    if (orig === np) continue;
    if (tree.original(np) === null && tree.now.get(np) !== null && tree.now.get(np) !== undefined && tree.original(orig) !== null && tree.now.get(orig) === null) {
      rPairs.set(np, orig);
    }
  }
  const rOrigins = new Set(rPairs.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    if (rOrigins.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rPairs.has(p)) rows.push({ key: p, line: `R ${rPairs.get(p)} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now !== null && tree.original(p) !== now) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
