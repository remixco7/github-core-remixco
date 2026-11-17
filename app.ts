// github-core-clone: a small in-memory GitHub-compatible git forge.
//
// Serves, from one process and one in-memory store:
//   - git smart HTTP (protocol v2 + v0): info/refs, ls-refs, fetch, receive-pack
//   - REST v3: repos, branches, commits, contents, git refs, issues, labels, pulls
//   - GraphQL v4: the repository/issue/pull-request documents gh speaks
//   - MCP (2026-07-28 server/discover era, with the legacy initialize handshake)
//
// No dependencies, no disk writes, no clock in any response: every timestamp the
// server invents comes from MAKEFUN_TRIAL_NOW (or a fixed fallback), and every id
// is a counter. Objects are stored byte-exactly as pushed and packs are built
// from those bytes, so a clone recomputes every SHA-1.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// constants
// -------------------------------------------------------------------------------------------

export const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'Ada Iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const AGENT = 'github-core-clone/1.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

/** The token the env hands the entry; every API call must carry it. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The only "now" the server may use: the trial's opening time, else a fixed stamp. */
const TRIAL_NOW_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.parse('2026-11-14T06:30:00.000Z');
})();
const TRIAL_NOW_S = Math.floor(TRIAL_NOW_MS / 1000);
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_MS).toISOString();
const IDENT = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

const JSON_TYPE = 'application/json; charset=utf-8';

// -------------------------------------------------------------------------------------------
// store
// -------------------------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer }
interface Label { name: string; color: string }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; seq: number;
}
interface Comment { id: number; body: string; seq: number }
interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; baseSha: string; headSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; seq: number;
}
interface Repo {
  id: number; name: string; owner: string; description: string; isPrivate: boolean;
  defaultBranch: string; refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Map<number, Issue>; labels: Map<string, Label>; pulls: Map<number, Pull>;
  nextIssue: number; nextPull: number; nextComment: number; seq: number;
}

const repos = new Map<string, Repo>();
let repoSeq = 0;
let reqSeq = 0;
let globalSeq = 0;
/** Fetch pack cache, keyed per repo: cleared whenever that repo's refs move. */
const packCache = new Map<string, Buffer>();

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function newRepo(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: ++repoSeq, name, owner: VIEWER_LOGIN, description, isPrivate,
    defaultBranch: 'main', refs: new Map(), objects: new Map(),
    issues: new Map(), labels: new Map(), pulls: new Map(),
    nextIssue: 1, nextPull: 1, nextComment: 1, seq: ++globalSeq,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

// -------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------

function sha1Hex(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }
function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}
function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function getObject(repo: Repo, oid: string): GitObject | undefined { return repo.objects.get(oid); }

interface CommitParts { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2).replace(/\n+$/, '');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
interface TagParts { object: string; type: string; tag: string; tagger: string; message: string }
function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2).replace(/\n+$/, '');
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) break;
    const mode = data.subarray(pos, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}
function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
/** git's tree sort: entries ordered by name, directories as if named with a trailing '/'. */
function treeSortKey(e: TreeEntry): string { return e.mode === '40000' ? `${e.name}/` : e.name; }
function sortTree(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
}

/** Build (and store) the tree for a flat path -> {oid, mode} map; returns the root tree oid. */
function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/').filter((s) => s !== '');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i]!;
      let next = node.dirs.get(seg);
      if (!next) { next = make(); node.dirs.set(seg, next); }
      node = next;
    }
    node.files.set(segs[segs.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    return storeObject(repo, 'tree', buildTreeBytes(sortTree(entries)));
  };
  return build(root);
}

/** Flatten a tree object into path -> {oid, mode}; missing trees yield an empty map. */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** All commits reachable from `tips` (newest-first walk order), following parents. */
function reachableCommits(repo: Repo, tips: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parts = parseCommit(obj.data);
    for (let i = parts.parents.length - 1; i >= 0; i -= 1) stack.push(parts.parents[i]!);
  }
  return out;
}

/** True when `ancestor` is reachable from `tip` by following commit parents. */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** The full object closure of a set of tips (commits, their trees/blobs, tag targets). */
function closureOf(repo: Repo, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const visitObject = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = getObject(repo, oid);
    if (!obj) return;
    out.add(oid);
    if (obj.type === 'commit') {
      const parts = parseCommit(obj.data);
      visitObject(parts.tree);
      for (const p of parts.parents) visitObject(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) visitObject(e.oid);
    } else if (obj.type === 'tag') {
      visitObject(parseTag(obj.data).object);
    }
  };
  for (const tip of tips) visitObject(tip);
  return out;
}

/** Peel a tag (recursively) to the commit it names, or the oid itself when it is not a tag. */
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

// -------------------------------------------------------------------------------------------
// packs
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeId = PACK_TYPE_IDS[type];
  const bytes: number[] = [];
  let s = size;
  bytes.push((typeId << 4) | (s & 0x0f));
  s >>>= 4;
  while (s > 0) { bytes[bytes.length - 1]! |= 0x80; bytes.push(s & 0x7f); s >>>= 7; }
  return Buffer.from(bytes);
}

function buildPack(objects: Map<string, GitObject> | GitObject[]): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects.values()];
  const oids = Array.isArray(objects) ? list.map((o) => hashObject(o.type, o.data)) : [...objects.keys()];
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (let i = 0; i < list.length; i += 1) {
    const obj = list[i]!;
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Inflate one zlib stream starting at `pos`, returning its bytes and the number of
 * compressed bytes it consumed. inflateSync with `{info: true}` reports the exact
 * number of input bytes the engine consumed (`bytesWritten`), so one call gives
 * both the output and the boundary — no binary search over the stream length.
 * (The old exponential+bisection search had a wrong lower bound: for data that
 * compresses better than 2:1 the midpoint probe succeeded, so the search returned
 * a length past the true stream end and the next pack object misparsed.)
 */
function inflateAt(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; length: number } {
  const remaining = buf.length - pos;
  try {
    const r = inflateSync(buf.subarray(pos), { info: true });
    const len = (r.engine as { bytesWritten?: unknown }).bytesWritten;
    if (typeof len === 'number' && len > 0 && len <= remaining && r.buffer.length === expectedSize) {
      return { data: r.buffer, length: len };
    }
  } catch { /* fall through to the bounded search */ }
  const tryAt = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(pos, pos + len));
      return out.length === expectedSize ? out : null;
    } catch { return null; }
  };
  let hi = Math.min(remaining, Math.max(16, expectedSize + 16));
  let found = tryAt(hi);
  while (found === null && hi < remaining) { hi = Math.min(remaining, hi * 2); found = tryAt(hi); }
  if (found === null) throw new Error('pack object does not inflate to its declared size');
  // Invariant: tryAt(lo) is known to fail (lo starts at 0, empty input throws),
  // tryAt(hi) is known to succeed; the search keeps that invariant.
  let lo = 0;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryAt(mid) !== null) hi = mid; else lo = mid;
  }
  const data = tryAt(hi);
  if (data === null) throw new Error('pack object does not inflate to its declared size');
  return { data, length: hi };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0; let shift = 0;
    for (;;) {
      const b = delta[pos++]!;
      out |= (b & 0x7f) << shift; shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return out;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0; let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= delta[pos++]! << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[pos++]! << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op; total += op;
    } else throw new Error('delta op 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

/** Parse a pack buffer into objects (full objects and deltas resolved). */
function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const ofsBases = new Map<number, GitObject>();
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let b = buf[pos++]!;
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = buf[pos++]!; size |= (b & 0x7f) << shift; shift += 7; }
    if (typeId === 6) {
      // ofs-delta: offset encoded in git's biased form
      let c = buf[pos++]!;
      let offset = c & 0x7f;
      while (c & 0x80) { c = buf[pos++]!; offset = ((offset + 1) << 7) | (c & 0x7f); }
      const basePos = start - offset;
      const base = ofsBases.get(basePos);
      if (!base) throw new Error('ofs-delta base not found');
      const { data, length } = inflateAt(buf, pos, size);
      pos += length;
      const resolved = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolved);
      const obj: GitObject = { type: base.type, data: resolved };
      objects.set(oid, obj);
      ofsBases.set(start, obj);
    } else if (typeId === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, length } = inflateAt(buf, pos, size);
      pos += length;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const resolved = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolved);
      const obj: GitObject = { type: base.type, data: resolved };
      objects.set(oid, obj);
      ofsBases.set(start, obj);
    } else {
      const type = PACK_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      const { data, length } = inflateAt(buf, pos, size);
      pos += length;
      const oid = hashObject(type, data);
      const obj: GitObject = { type, data };
      objects.set(oid, obj);
      ofsBases.set(start, obj);
    }
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

type Pkt = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };
function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, payload]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len < 4 || pos + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  if (pos !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}
function pktText(p: Pkt): string { return p.payload.toString('utf8'); }

// -------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------

interface FetchSelection { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] }

/**
 * Which objects a fetch sends. `wants` are the tips, `haves` the commits the client
 * already holds (their whole closure is excluded), `depth` a deepen limit (commit
 * generations from a want), `heldShallow` the client's shallow boundaries.
 * Boundary commits (the deepest generation included) are reported as shallow; a
 * previously shallow commit whose parents are now included is reported unshallow.
 */
function selectFetchObjects(repo: Repo, wants: string[], haves: string[], depth: number | null, heldShallow: string[]): FetchSelection {
  const held = new Set(heldShallow);
  // What the client actually holds. A shallow `have` is a boundary, not a full
  // history: it contributes only itself and its tree, never its parents — so a
  // deepen can walk through it to the next generation instead of stopping.
  const haveClosure = new Set<string>();
  for (const h of haves) {
    const haveObj = getObject(repo, h);
    if (!haveObj) continue;
    if (held.has(h) && haveObj.type === 'commit') {
      haveClosure.add(h);
      for (const o of closureOf(repo, [parseCommit(haveObj.data).tree])) haveClosure.add(o);
    } else {
      for (const o of closureOf(repo, [h])) haveClosure.add(o);
    }
  }
  const objects = new Map<string, GitObject>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const includeClosure = (oid: string): void => {
    for (const o of closureOf(repo, [oid])) {
      if (haveClosure.has(o)) continue;
      const obj = getObject(repo, o);
      if (obj) objects.set(o, obj);
    }
  };
  const includeTreeOnly = (commitOid: string): void => {
    const obj = getObject(repo, commitOid);
    if (!obj || obj.type !== 'commit') return;
    if (!haveClosure.has(commitOid)) objects.set(commitOid, obj);
    const tree = parseCommit(obj.data).tree;
    for (const o of closureOf(repo, [tree])) {
      if (haveClosure.has(o)) continue;
      const t = getObject(repo, o);
      if (t) objects.set(o, t);
    }
  };
  for (const want of wants) {
    const obj = getObject(repo, want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!haveClosure.has(want)) objects.set(want, obj);
      const target = peelToCommit(repo, want);
      const targetObj = getObject(repo, target);
      if (targetObj && targetObj.type === 'commit') {
        // a tag's commit counts as generation 0 for the depth window
        if (depth === null) includeClosure(target);
        else walkCommit(target, 0);
      } else includeClosure(target);
      continue;
    }
    if (obj.type !== 'commit') { if (!haveClosure.has(want)) objects.set(want, obj); continue; }
    if (depth === null) includeClosure(want);
    else walkCommit(want, 0);
  }
  function walkCommit(oid: string, gen: number): void {
    if (haveClosure.has(oid) && !held.has(oid)) {
      // fully held: its parents are held too (closure), nothing to send below it
      return;
    }
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return;
    includeTreeOnly(oid);
    if (held.has(oid)) unshallow.add(oid);
    if (gen >= (depth as number) - 1) {
      // deepest generation included: boundary, unless it has no parents at all
      if (parseCommit(obj.data).parents.length > 0) shallow.add(oid);
      return;
    }
    for (const p of parseCommit(obj.data).parents) walkCommit(p, gen + 1);
  }
  return { objects, shallow: [...shallow], unshallow: [...unshallow] };
}

// -------------------------------------------------------------------------------------------
// repo helpers: refs, commits, trees, contents
// -------------------------------------------------------------------------------------------

function refTip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
function branchTip(repo: Repo, branch: string): string | undefined { return repo.refs.get(`refs/heads/${branch}`); }

/** Resolve a ref-ish (branch name, full ref, or sha) to a commit oid, or undefined. */
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = getObject(repo, ref.toLowerCase());
    if (obj && obj.type === 'commit') return ref.toLowerCase();
    if (obj && obj.type === 'tag') return peelToCommit(repo, ref.toLowerCase());
    return undefined;
  }
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  const tip = branchTip(repo, ref);
  if (tip !== undefined) return tip;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  return undefined;
}

/** All branch refs sorted by name. */
function listBranches(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Commits reachable from `tip`, newest first (parents after their child). */
function listCommits(repo: Repo, tip: string | undefined): { sha: string; message: string }[] {
  if (tip === undefined) return [];
  return reachableCommits(repo, [tip]).map((sha) => {
    const obj = getObject(repo, sha)!;
    return { sha, message: parseCommit(obj.data).message };
  });
}

/** Build a server commit on `parent` (or root) with `files` as the whole tree. */
function makeCommit(repo: Repo, message: string, files: Map<string, { oid: string; mode: string }>, parents: string[]): string {
  const tree = buildTreeFromFiles(repo, files);
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${IDENT} ${TRIAL_NOW_S} +0000`);
  lines.push(`committer ${IDENT} ${TRIAL_NOW_S} +0000`);
  lines.push('', message.endsWith('\n') ? message : `${message}\n`);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  return storeObject(repo, 'commit', data);
}

/** The files of the tree at a commit (empty map when there is no commit). */
function filesAtCommit(repo: Repo, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (commitOid === undefined) return new Map();
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

interface ContentsResult { commitSha: string; contentSha: string; isNew: boolean }

/**
 * Write one file through the contents API. `branch` names the branch to commit on
 * (created from the default tip when missing, or at the new commit when the repo is
 * empty). Returns the new commit and blob shas.
 */
function putContents(repo: Repo, path: string, contentB64: string, message: string, branch: string | undefined, sha: string | undefined): ContentsResult {
  const content = Buffer.from(contentB64, 'base64');
  const blobSha = storeObject(repo, 'blob', content);
  const targetBranch = branch ?? repo.defaultBranch;
  const ref = `refs/heads/${targetBranch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined && branch !== undefined && branch !== repo.defaultBranch) {
    // a named branch that does not exist yet starts from the default branch tip
    tip = branchTip(repo, repo.defaultBranch);
  }
  const files = filesAtCommit(repo, tip);
  const isNew = !files.has(path);
  if (!isNew) {
    const current = files.get(path)!;
    if (sha === undefined) throw Object.assign(new Error('sha is required to update a file'), { status: 422 });
    if (sha.toLowerCase() !== current.oid.toLowerCase()) throw Object.assign(new Error('sha does not match the current blob'), { status: 409 });
  }
  files.set(path, { oid: blobSha, mode: '100644' });
  const commitSha = makeCommit(repo, message, files, tip === undefined ? [] : [tip]);
  repo.refs.set(ref, commitSha);
  packCacheClear(repo);
  return { commitSha, contentSha: blobSha, isNew };
}

function deleteContents(repo: Repo, path: string, message: string, branch: string | undefined, sha: string | undefined): string {
  const targetBranch = branch ?? repo.defaultBranch;
  const ref = `refs/heads/${targetBranch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
  const files = filesAtCommit(repo, tip);
  const current = files.get(path);
  if (!current) throw Object.assign(new Error('Not Found'), { status: 404 });
  if (sha !== undefined && sha.toLowerCase() !== current.oid.toLowerCase()) {
    throw Object.assign(new Error('sha does not match the current blob'), { status: 409 });
  }
  files.delete(path);
  const commitSha = makeCommit(repo, message, files, [tip]);
  repo.refs.set(ref, commitSha);
  packCacheClear(repo);
  return commitSha;
}

function packCacheClear(repo: Repo): void {
  const prefix = `${repo.id}|`;
  for (const key of [...packCache.keys()]) if (key.startsWith(prefix)) packCache.delete(key);
}

// -------------------------------------------------------------------------------------------
// REST shapes
// -------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate, description: repo.description,
    default_branch: repo.defaultBranch, has_issues: true, has_pull_requests: true,
    created_at: TRIAL_NOW_ISO, updated_at: TRIAL_NOW_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 10_000_000 + issue.number, number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_NOW_ISO, updated_at: TRIAL_NOW_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.head) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.base) ?? pull.baseSha;
  return {
    id: repo.id * 10_000_000 + 1_000_000 + pull.number, number: pull.number,
    title: pull.title, body: pull.body, state: pull.state,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_NOW_ISO, updated_at: TRIAL_NOW_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function createIssueIn(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const resolved: Label[] = [];
  for (const name of labels) {
    const label = repo.labels.get(name);
    if (!label) throw Object.assign(new Error(`Invalid label: ${name}`), { status: 422 });
    resolved.push(label);
  }
  const issue: Issue = {
    number: repo.nextIssue++, title, body: body ?? '', state: 'open',
    labels: resolved, comments: [], seq: ++globalSeq,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullIn(repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === undefined || baseTip === undefined) {
    throw Object.assign(new Error('head or base branch not found'), { status: 422 });
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      throw Object.assign(new Error('A pull request already exists for these branches'), { status: 422 });
    }
  }
  const pull: Pull = {
    number: repo.nextPull++, title, body: body ?? '', state: 'open',
    head, base, baseSha: baseTip, headSha: headTip,
    merged: false, mergedAt: null, mergeCommitSha: null, seq: ++globalSeq,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The file-level diff between two trees (base -> head). */
function diffTrees(repo: Repo, baseTree: string, headTree: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const countLines = (oid: string | undefined): number => {
    if (oid === undefined) return 0;
    const obj = getObject(repo, oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(path); const h = head.get(path);
    if (b && !h) {
      const del = countLines(b.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
    } else if (!b && h) {
      const add = countLines(h.oid);
      out.push({ filename: path, status: 'added', additions: Math.max(add, 1), deletions: 0, changes: Math.max(add, 1) });
    } else if (b && h && b.oid !== h.oid) {
      const add = countLines(h.oid); const del = countLines(b.oid);
      out.push({ filename: path, status: 'modified', additions: Math.max(add, 1), deletions: del, changes: Math.max(add, 1) + del });
    }
  }
  return out;
}

/**
 * Whether merging `pull` would conflict: a path changed in both the PR's diff
 * (base commit -> head tip) and the base branch's advance (base commit -> base tip)
 * with different resulting blobs.
 */
function mergeConflict(repo: Repo, pull: Pull): boolean {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head) ?? pull.headSha;
  if (baseTip === undefined) return false;
  const baseObj = getObject(repo, pull.baseSha);
  const headObj = getObject(repo, headTip);
  const tipObj = getObject(repo, baseTip);
  if (!baseObj || !headObj || !tipObj) return false;
  const baseFiles = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headFiles = flattenTree(repo, parseCommit(headObj.data).tree);
  const tipFiles = flattenTree(repo, parseCommit(tipObj.data).tree);
  for (const path of headFiles.keys()) {
    const b = baseFiles.get(path); const h = headFiles.get(path); const t = tipFiles.get(path);
    const headChanged = !b || b.oid !== h!.oid;
    const tipChanged = (b && !t) || (!b && t) || (b && t && b.oid !== t.oid);
    if (headChanged && tipChanged) {
      if ((t?.oid ?? null) !== h!.oid) return true;
    }
  }
  // paths deleted on the head side but changed on the base side also conflict
  for (const path of baseFiles.keys()) {
    if (headFiles.has(path)) continue;
    const b = baseFiles.get(path)!; const t = tipFiles.get(path);
    if ((t?.oid ?? null) !== b.oid) return true;
  }
  return false;
}

/** Squash-merge `pull` onto its base branch; returns the merge commit sha. */
function mergePull(repo: Repo, pull: Pull): string {
  const baseTip = branchTip(repo, pull.base)!;
  const headTip = branchTip(repo, pull.head) ?? pull.headSha;
  const baseObj = getObject(repo, pull.baseSha)!;
  const headObj = getObject(repo, headTip)!;
  const tipFiles = filesAtCommit(repo, baseTip);
  const baseFiles = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headFiles = flattenTree(repo, parseCommit(headObj.data).tree);
  for (const [path, entry] of headFiles) tipFiles.set(path, entry);
  for (const path of baseFiles.keys()) if (!headFiles.has(path)) tipFiles.delete(path);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
  const mergeSha = makeCommit(repo, message, tipFiles, [baseTip]);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = mergeSha;
  packCacheClear(repo);
  return mergeSha;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++reqSeq}`,
    ...headers,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${++reqSeq}`,
    ...headers,
  });
  res.end(body);
}
function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': `req-${++reqSeq}` });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try { return JSON.parse(raw.toString('utf8')) as unknown; }
  catch { throw Object.assign(new Error('Problems parsing JSON'), { status: 400 }); }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function strField(body: unknown, field: string): string {
  if (isRecord(body) && typeof body[field] === 'string') return body[field] as string;
  return '';
}
function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') return false;
  if (SHOP_TOKEN !== '' && auth.slice(7).trim() !== SHOP_TOKEN) return false;
  return true;
}
function urlOf(req: IncomingMessage): { pathname: string; search: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { pathname: u.pathname, search: u.searchParams };
  } catch { return { pathname: '/', search: new URLSearchParams() }; }
}
function pageParams(search: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(search.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(search.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}
function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}
function linkHeader(req: IncomingMessage, basePath: string, search: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const host = req.headers.host ?? 'entry';
  const mk = (p: number): string => {
    const q = new URLSearchParams(search);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `http://${host}${basePath}?${q.toString()}`;
  };
  return `<${mk(page + 1)}>; rel="next", <${mk(lastPage)}>; rel="last"`;
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

interface RefLine { name: string; oid: string; peeled?: string; symrefTarget?: string; unborn?: boolean }

function allRefLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const tip = branchTip(repo, repo.defaultBranch);
  if (tip !== undefined) lines.push({ name: 'HEAD', oid: tip, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  else lines.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ref, oid] of refs) {
    const line: RefLine = { name: ref, oid };
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'tag') line.peeled = peelToCommit(repo, oid);
    lines.push(line);
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = allRefLines(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = branchTip(repo, repo.defaultBranch);
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled !== undefined) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): Promise<void> {
  const repo = findRepo(owner, repoName);
  if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = isV2 ? v2Advertisement(repo) : v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack');
  const ct = service === 'git-upload-pack'
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';
  sendRaw(res, 200, body, ct);
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  for (const line of allRefLines(repo)) {
    if (!keep(line.name)) continue;
    if (line.unborn) {
      if (!args.unborn) continue;
      const extra = args.symrefs && line.symrefTarget ? ` symref-target:${line.symrefTarget}` : '';
      parts.push(pktLine(`unborn ${line.name}${extra}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (args.symrefs && line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
    if (args.peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Split a sideband pack into pkt-lines (band 1), each at most 65516 bytes of payload. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  // The pkt-line ceiling is 65520 total, i.e. 65516 of payload; the band byte
  // is part of the payload, so each pack chunk is at most 65515 bytes.
  const max = 65515;
  for (let i = 0; i < pack.length; i += max) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + max));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function fetchV2Response(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const key = `${repo.id}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...shallow].sort().join(',')}`;
  const sel = selectFetchObjects(repo, wants, haves, depth, shallow);
  let pack: Buffer | null = packCache.get(key) ?? null;
  if (pack === null && sel.objects.size > 0) {
    pack = buildPack(sel.objects);
    if (packCache.size > 128) packCache.clear();
    packCache.set(key, pack);
  }
  // Protocol v2: sections are separated by delim packets; only the final
  // section ends with a flush. The `acknowledgments` section exists only when
  // the client sent `have` lines (a fresh clone sends none, and its client
  // expects `packfile` — or `shallow-info` — as the first section). The
  // `packfile` section is always present, even when it carries an empty pack.
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
  }
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of sel.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sel.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack ?? buildPack(new Map())));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const sel = selectFetchObjects(repo, wants, haves, depth, shallow);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of sel.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of sel.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (sel.objects.size > 0) parts.push(...sidebandPackets(buildPack(sel.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = findRepo(owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const body = await readBody(req);
  let packets: Pkt[];
  try { packets = decodePktLines(body); }
  catch { sendJson(res, 400, { message: 'bad pkt-line' }); return; }
  const texts = packets.filter((p) => p.kind === 'data').map(pktText);
  const first = texts[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    const args = texts.slice(1);
    if (command === 'ls-refs') {
      const parsed = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const a of args) {
        const t = a.trim();
        if (t === 'peel') parsed.peel = true;
        else if (t === 'symrefs') parsed.symrefs = true;
        else if (t === 'unborn') parsed.unborn = true;
        else if (t.startsWith('ref-prefix ')) parsed.prefixes.push(t.slice('ref-prefix '.length));
      }
      sendRaw(res, 200, lsRefsResponse(repo, parsed), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
      let depth: number | null = null;
      for (const a of args) {
        const t = a.trim();
        if (t.startsWith('want ')) wants.push(t.slice(5).trim());
        else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) depth = Number.parseInt(t.slice(7).trim(), 10);
      }
      if (wants.length === 0) {
        sendRaw(res, 200, Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]), 'application/x-git-upload-pack-result');
        return;
      }
      sendRaw(res, 200, fetchV2Response(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: `unknown v2 command ${command}` });
    return;
  }
  // v0: wants section, flush, haves section, flush
  const sections: string[][] = [[]];
  for (const p of packets) {
    if (p.kind === 'flush') sections.push([]);
    else if (p.kind === 'data') sections[sections.length - 1]!.push(pktText(p));
  }
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of sections[0] ?? []) {
    const t = line.trim();
    const space = t.indexOf(' ');
    const head = space === -1 ? t : t.slice(0, space);
    const rest = space === -1 ? '' : t.slice(space + 1);
    if (head === 'want') wants.push(rest.split(' ')[0]!);
    else if (head === 'shallow') shallow.push(rest);
    else if (head === 'deepen') depth = Number.parseInt(rest, 10);
  }
  for (const line of sections[1] ?? []) {
    const t = line.trim();
    if (t.startsWith('have ')) haves.push(t.slice(5).trim());
  }
  if (wants.length === 0) {
    sendRaw(res, 200, Buffer.concat([pktLine('NAK\n'), PKT_FLUSH]), 'application/x-git-upload-pack-result');
    return;
  }
  sendRaw(res, 200, fetchV0Response(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = findRepo(owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const body = await readBody(req);
  // Walk the raw buffer by hand: the command section is pkt-lines, but the pack
  // that follows the flush packet is raw bytes and must not be pkt-decoded.
  let flushEnd = -1;
  const lines: { oldOid: string; newOid: string; ref: string }[] = [];
  // Re-walk the raw buffer to locate where the pack starts (after the flush packet).
  {
    let p = 0;
    while (p + 4 <= body.length) {
      const len = parseInt(body.subarray(p, p + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) { flushEnd = p + 4; break; }
      if (len < 4 || p + len > body.length) break;
      const payload = body.subarray(p + 4, p + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const cmd = (nul === -1 ? payload : payload.slice(0, nul)).trim();
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmd);
      if (m) lines.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
      p += len;
    }
  }
  const packBuf = flushEnd === -1 ? Buffer.alloc(0) : body.subarray(flushEnd);
  const report: { ok: boolean; ref: string; reason: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, GitObject>();
  if (packBuf.length > 0) {
    try {
      const parsed = readPack(packBuf);
      for (const [oid, obj] of parsed) newObjects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const updatesRef = lines.some((l) => l.newOid !== ZERO_OID);
  if (unpackOk && updatesRef && packBuf.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }
  if (unpackOk) for (const [oid, obj] of newObjects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  for (const cmd of lines) {
    if (!unpackOk) { report.push({ ok: false, ref: cmd.ref, reason: unpackDetail }); continue; }
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid === ZERO_OID) {
      // create: the ref must not exist yet
      if (current !== ZERO_OID) { report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' }); continue; }
    } else if (cmd.oldOid !== current) {
      report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) { repo.refs.delete(cmd.ref); report.push({ ok: true, ref: cmd.ref, reason: '' }); continue; }
    const obj = getObject(repo, cmd.newOid);
    if (!obj) { report.push({ ok: false, ref: cmd.ref, reason: 'object not found' }); continue; }
    if (cmd.ref.startsWith('refs/heads/') && cmd.oldOid !== ZERO_OID) {
      // a branch update must fast-forward: the new tip has to descend from the old one
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ok: true, ref: cmd.ref, reason: '' });
  }
  if (report.some((r) => r.ok)) packCacheClear(repo);
  const inner: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const r of report) inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), innerBuf])), PKT_FLUSH]);
  sendRaw(res, 200, outer, 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

function errStatus(err: unknown): number {
  if (isRecord(err) && typeof err.status === 'number') return err.status;
  return 500;
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Internal Server Error';
}

/** Load and validate a JSON body for a REST write; throws 400 on malformed JSON. */
async function restBody(req: IncomingMessage): Promise<unknown> {
  return parseJsonBody(await readBody(req));
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { pathname, search } = urlOf(req);
  if (!checkAuth(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  const segs = pathname.split('/').filter((s) => s !== '');
  // segs[0] === 'api', segs[1] === 'v3'
  const rest = segs.slice(2);

  // GET /api/v3/ — root
  if (rest.length === 0) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { installed_version: SERVER_VERSION });
    return;
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }
  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(search);
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const link = linkHeader(req, '/api/v3/user/repos', search, page, perPage, all.length);
      sendJson(res, 200, paginate(all, page, perPage).map(repoJson), link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      let body: unknown;
      try { body = await restBody(req); } catch (e) { sendJson(res, errStatus(e), { message: errMessage(e) }); return; }
      const name = strField(body, 'name');
      if (name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
      if (findRepo(VIEWER_LOGIN, name)) {
        sendJson(res, 422, { message: 'Repository creation failed. name already exists on this account' });
        return;
      }
      const repo = newRepo(name, isRecord(body) && body.private === true, strField(body, 'description'));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]!);
    const name = decodeURIComponent(rest[2]!);
    const repo = findRepo(owner, name);
    if (!repo || owner !== VIEWER_LOGIN) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const tail = rest.slice(3);
    try {
      await handleRepoRest(req, res, repo, tail, search, method);
    } catch (e) {
      sendJson(res, errStatus(e), { message: errMessage(e) });
    }
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRepoRest(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], search: URLSearchParams, method: string): Promise<void> {
  // /repos/{o}/{r} itself
  if (tail.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const body = await restBody(req);
      if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      packCacheClear(repo);
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const head = tail[0]!;
  // branches
  if (head === 'branches') {
    if (tail.length === 1) {
      if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const tip = branchTip(repo, decodeURIComponent(tail[1]!));
      if (tip === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { name: decodeURIComponent(tail[1]!), commit: { sha: tip } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // commits
  if (head === 'commits') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const shaParam = search.get('sha');
    const tip = shaParam !== null ? resolveRef(repo, shaParam) : branchTip(repo, repo.defaultBranch);
    const { page, perPage } = pageParams(search);
    const list = paginate(listCommits(repo, tip), page, perPage).map((c) => ({
      sha: c.sha, commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    }));
    sendJson(res, 200, list);
    return;
  }
  // git/refs
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = await restBody(req);
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha').toLowerCase();
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return;
      }
      if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
      const obj = getObject(repo, sha);
      if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
        sendJson(res, 422, { message: 'Object does not exist' });
        return;
      }
      repo.refs.set(ref, sha);
      packCacheClear(repo);
      sendJson(res, 201, { ref, object: { sha, type: obj.type } });
      return;
    }
    if (method === 'GET' && tail.length > 2) {
      const ref = tail.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const obj = getObject(repo, sha);
      sendJson(res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // contents
  if (head === 'contents') {
    const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = search.get('ref');
    if (method === 'GET') {
      const tip = refParam !== null ? resolveRef(repo, refParam) : branchTip(repo, repo.defaultBranch);
      if (tip === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const commitObj = getObject(repo, tip)!;
      const treeOid = parseCommit(commitObj.data).tree;
      const files = flattenTree(repo, treeOid);
      if (path === '') {
        // root directory listing
        const entries = dirEntries(repo, treeOid, '');
        sendJson(res, 200, entries);
        return;
      }
      const file = files.get(path);
      if (file) {
        const blob = getObject(repo, file.oid)!;
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', content: blob.data.toString('base64'),
          sha: file.oid, size: blob.data.length, name: path.split('/').pop(), path,
        });
        return;
      }
      // directory?
      const prefix = `${path}/`;
      let isDir = false;
      for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
      if (!isDir) {
        // maybe a subtree that is empty or a nested dir with no files: walk the tree
        const tree = findSubtree(repo, treeOid, path.split('/'));
        if (tree === null) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 200, dirEntries(repo, tree, path));
        return;
      }
      const tree = findSubtree(repo, treeOid, path.split('/'));
      if (tree === null) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, dirEntries(repo, tree, path));
      return;
    }
    if (method === 'PUT') {
      const body = await restBody(req);
      const message = strField(body, 'message');
      const content = strField(body, 'content');
      const sha = isRecord(body) && typeof body.sha === 'string' ? (body.sha as string) : undefined;
      const branch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : undefined;
      if (message === '' || content === '') { sendJson(res, 422, { message: 'message and content are required' }); return; }
      const result = putContents(repo, path, content, message, branch, sha);
      sendJson(res, result.isNew ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.contentSha, size: Buffer.from(content, 'base64').length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = await restBody(req);
      const message = strField(body, 'message');
      const sha = isRecord(body) && typeof body.sha === 'string' ? (body.sha as string) : undefined;
      const branch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : undefined;
      const commitSha = deleteContents(repo, path, message === '' ? 'Delete file' : message, branch, sha);
      sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // labels
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = await restBody(req);
      const name = strField(body, 'name');
      if (name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
      const color = isRecord(body) && typeof body.color === 'string' ? (body.color as string) : 'ededed';
      const existing = repo.labels.get(name);
      if (existing) { sendJson(res, 201, { name: existing.name, color: existing.color }); return; }
      const label: Label = { name, color };
      repo.labels.set(name, label);
      sendJson(res, 201, { name, color });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // issues
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = await restBody(req);
        const title = strField(body, 'title');
        const labels = isRecord(body) && Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        if (title === '') { sendJson(res, 422, { message: 'title is required' }); return; }
        const issue = createIssueIn(repo, title, strField(body, 'body'), labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = search.get('state') ?? 'open';
        const direction = search.get('direction') ?? 'desc';
        const { page, perPage } = pageParams(search);
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        sendJson(res, 200, paginate(list, page, perPage).map((i) => issueJson(repo, i)));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const number = Number.parseInt(tail[1]!, 10);
    const issue = repo.issues.get(number);
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 2) {
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        const body = await restBody(req);
        if (isRecord(body)) {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') {
        const body = await restBody(req);
        const comment: Comment = { id: repo.id * 10_000_000 + 2_000_000 + repo.nextComment++, body: strField(body, 'body'), seq: ++globalSeq };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: TRIAL_NOW_ISO });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: TRIAL_NOW_ISO })));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // pulls
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = await restBody(req);
        const pull = createPullIn(repo, strField(body, 'title'), strField(body, 'body'), strField(body, 'head'), strField(body, 'base'));
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = search.get('state') ?? 'open';
        const { page, perPage } = pageParams(search);
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => a.seq - b.seq);
        sendJson(res, 200, paginate(list, page, perPage).map((p) => pullJson(repo, p)));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const number = Number.parseInt(tail[1]!, 10);
    const pull = repo.pulls.get(number);
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (tail.length === 2) {
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const headTip = branchTip(repo, pull.head) ?? pull.headSha;
      const baseObj = getObject(repo, pull.baseSha);
      const headObj = getObject(repo, headTip);
      if (!baseObj || !headObj) { sendJson(res, 200, []); return; }
      sendJson(res, 200, diffTrees(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree));
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method !== 'PUT') { sendJson(res, 404, { message: 'Not Found' }); return; }
      await restBody(req).catch(() => undefined);
      if (pull.state === 'closed') { sendJson(res, 405, { message: 'Pull request has already been closed' }); return; }
      if (mergeConflict(repo, pull)) { sendJson(res, 405, { message: 'Merge conflict' }); return; }
      const sha = mergePull(repo, pull);
      sendJson(res, 200, { merged: true, sha, message: 'Pull request successfully merged' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** The immediate children of the tree at `path` ('' for the root), as contents entries. */
function dirEntries(repo: Repo, treeOid: string, path: string): Record<string, unknown>[] {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: path === '' ? e.name : `${path}/${e.name}`,
    sha: e.oid,
  }));
}

/** The tree oid of the subtree at `segments` below `treeOid`, or null when absent. */
function findSubtree(repo: Repo, treeOid: string, segments: string[]): string | null {
  let cur = treeOid;
  for (const seg of segments) {
    if (seg === '') continue;
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return cur;
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 — a small parser and executor for the documents gh speaks
// -------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias: string | null; name: string; args: { name: string; value: GqlValue }[];
  selections: GqlSelection[] | null;
}
type GqlSelection = GqlField | { fragment: string; selections: GqlSelection[] };
interface GqlOperation { kind: 'query' | 'mutation'; name: string | null; selections: GqlSelection[] }

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if ('{}():![]...'.includes(c) || c === '$' || c === '=' || c === '@') {
      if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
      tokens.push(c); i += 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; continue; }
        out += src[j]; j += 1;
      }
      tokens.push(JSON.stringify(out));
      i = j + 1; continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j; continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) { this.tokens = tokens; }
  private peek(): string | undefined { return this.tokens[this.pos]; }
  private next(): string { return this.tokens[this.pos++]!; }
  private expect(t: string): void { const got = this.next(); if (got !== t) throw new Error(`expected ${t}, got ${got}`); }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') { kind = this.next() as 'query' | 'mutation'; }
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '{' && maybeName !== '(') name = this.next();
    if (this.peek() === '(') {
      // variable definitions: skip them (names/types/defaults)
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
        if (t === '(') depth += 1;
        else if (t === ')') { depth -= 1; if (depth === 0) break; }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }
  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) out.push(this.parseSelection());
    this.expect('}');
    return out;
  }
  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      let fragment = '';
      if (this.peek() === 'on') { this.next(); fragment = this.next(); }
      else fragment = this.next();
      return { fragment, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
    const args: { name: string; value: GqlValue }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }
  private parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number.parseInt(t, 10) };
    if (/^-?\d+\.\d+(e[+-]?\d+)?$/i.test(t)) return { kind: 'float', value: Number.parseFloat(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': return vars[v.name];
    case 'string': case 'int': case 'float': case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.values.map((x) => resolveGqlValue(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveGqlValue(f.value, vars);
      return out;
    }
  }
}
function argMap(field: GqlField, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveGqlValue(a.value, vars);
  return out;
}

// Global ids: opaque base64, stable across reads.
function gid(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}
function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}
function repoByGid(id: string): Repo | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Repository') return undefined;
  const dbid = Number.parseInt(parsed.parts[0]!, 10);
  for (const repo of repos.values()) if (repo.id === dbid) return repo;
  return undefined;
}
function issueByGid(id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Issue') return undefined;
  const repo = repoByGid(gid('Repository', [parsed.parts[0]!]));
  if (!repo) return undefined;
  const issue = repo.issues.get(Number.parseInt(parsed.parts[1]!, 10));
  return issue ? { repo, issue } : undefined;
}
function pullByGid(id: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'PullRequest') return undefined;
  const repo = repoByGid(gid('Repository', [parsed.parts[0]!]));
  if (!repo) return undefined;
  const pull = repo.pulls.get(Number.parseInt(parsed.parts[1]!, 10));
  return pull ? { repo, pull } : undefined;
}

type GqlNode = { __type: string; [key: string]: unknown };
function nodeRepo(repo: Repo): GqlNode {
  return { __type: 'Repository', repo };
}
function nodeIssue(repo: Repo, issue: Issue): GqlNode {
  return { __type: 'Issue', repo, issue };
}
function nodePull(repo: Repo, pull: Pull): GqlNode {
  return { __type: 'PullRequest', repo, pull };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'closed', 'mergedAt', 'mergeCommit', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'defaultBranch', 'createdAt', 'url'],
};
const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

class GqlExecutor {
  errors: { message: string }[] = [];
  private vars: Record<string, unknown>;
  constructor(vars: Record<string, unknown>) { this.vars = vars; }

  execute(op: GqlOperation): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) this.resolveSelection(data, { __type: op.kind === 'mutation' ? 'Mutation' : 'Query' }, sel);
    return data;
  }

  private resolveSelection(out: Record<string, unknown>, parent: GqlNode, sel: GqlSelection): void {
    if ('fragment' in sel) {
      if (sel.fragment === '' || sel.fragment === parent.__type) {
        for (const inner of sel.selections) this.resolveSelection(out, parent, inner);
      }
      return;
    }
    const key = sel.alias ?? sel.name;
    const value = this.resolveField(parent, sel);
    if (value === undefined) return; // unknown field: error recorded, key omitted
    out[key] = value;
  }

  private sub(_parent: unknown, sel: GqlField, value: unknown): unknown {
    if (sel.selections === null || value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
          const obj: Record<string, unknown> = {};
          for (const s of sel.selections!) this.resolveSelection(obj, item as GqlNode, s);
          return obj;
        }
        return item;
      });
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      const obj: Record<string, unknown> = {};
      for (const s of sel.selections) this.resolveSelection(obj, value as GqlNode, s);
      return obj;
    }
    return value;
  }

  private unknownField(parent: GqlNode, field: GqlField): undefined {
    this.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__type}".` });
    return undefined;
  }

  private resolveField(parent: GqlNode, field: GqlField): unknown {
    const args = argMap(field, this.vars);
    switch (parent.__type) {
      case 'Query': return this.queryField(field, args);
      case 'Mutation': return this.mutationField(field, args);
      case 'Viewer': {
        if (field.name === 'login') return VIEWER_LOGIN;
        return this.unknownField(parent, field);
      }
      case 'Repository': return this.repositoryField(parent.repo as Repo, field, args);
      case 'Issue': return this.issueField(parent.repo as Repo, parent.issue as Issue, field);
      case 'PullRequest': return this.pullField(parent.repo as Repo, parent.pull as Pull, field, args);
      case 'User': {
        if (field.name === 'login') return parent.login as string;
        return this.unknownField(parent, field);
      }
      case 'Ref': {
        if (field.name === 'name') return parent.name as string;
        return this.unknownField(parent, field);
      }
      case 'IssueConnection': case 'PullRequestConnection': {
        if (field.name === 'nodes') return this.sub(parent, field, parent.nodes as GqlNode[]);
        if (field.name === 'pageInfo') return this.sub(parent, field, parent.pageInfo as GqlNode);
        if (field.name === 'totalCount') return (parent.nodes as unknown[]).length;
        return this.unknownField(parent, field);
      }
      case 'PageInfo': {
        if (field.name === 'hasNextPage') return parent.hasNextPage as boolean;
        if (field.name === 'endCursor') return parent.endCursor as string | null;
        return this.unknownField(parent, field);
      }
      case '__Type': {
        if (field.name === 'fields') {
          const names = TYPE_FIELDS[parent.typeName as string] ?? [];
          return names.map((n) => ({ name: n }));
        }
        if (field.name === 'enumValues') {
          if (parent.typeName === 'SearchType') return SEARCH_TYPE_ENUMS.map((n) => ({ name: n }));
          return [];
        }
        if (field.name === 'name') return parent.typeName as string;
        return this.unknownField(parent, field);
      }
      case 'CreateIssuePayload': case 'CloseIssuePayload': {
        if (field.name === 'issue') return this.sub(parent, field, parent.issue as GqlNode);
        return this.unknownField(parent, field);
      }
      case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
        if (field.name === 'pullRequest') return this.sub(parent, field, parent.pull as GqlNode);
        return this.unknownField(parent, field);
      }
      case 'AddCommentPayload': {
        if (field.name === 'commentEdge') return this.sub(parent, field, { __type: 'IssueCommentEdge', node: parent.comment as GqlNode });
        return this.unknownField(parent, field);
      }
      case 'IssueCommentEdge': {
        if (field.name === 'node') return this.sub(parent, field, parent.node as GqlNode);
        return this.unknownField(parent, field);
      }
      case 'IssueComment': {
        if (field.name === 'id') return parent.id as string;
        if (field.name === 'body') return parent.body as string;
        return this.unknownField(parent, field);
      }
      case 'PullRequestFile': {
        if (field.name === 'path') return parent.path as string;
        return this.unknownField(parent, field);
      }
      default: return this.unknownField(parent, field);
    }
  }

  private queryField(field: GqlField, args: Record<string, unknown>): unknown {
    if (field.name === 'viewer') {
      return this.sub(field, field, { __type: 'Viewer' });
    }
    if (field.name === 'repository') {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo || String(args.owner ?? '') !== VIEWER_LOGIN) return null;
      return this.sub(field, field, nodeRepo(repo));
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGid(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoByGid(id);
        return repo ? this.sub(field, field, nodeRepo(repo)) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = issueByGid(id);
        return found ? this.sub(field, field, nodeIssue(found.repo, found.issue)) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = pullByGid(id);
        return found ? this.sub(field, field, nodePull(found.repo, found.pull)) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (!TYPE_FIELDS[name] && name !== 'SearchType') return null;
      return this.sub(field, field, { __type: '__Type', typeName: name });
    }
    this.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    return undefined;
  }

  private mutationField(field: GqlField, args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    try {
      if (field.name === 'createIssue') {
        const repo = repoByGid(String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const issue = createIssueIn(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return this.sub(field, field, { __type: 'CreateIssuePayload', issue: nodeIssue(repo, issue) });
      }
      if (field.name === 'closeIssue') {
        const found = issueByGid(String(input.issueId ?? ''));
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        return this.sub(field, field, { __type: 'CloseIssuePayload', issue: nodeIssue(found.repo, found.issue) });
      }
      if (field.name === 'createPullRequest') {
        const repo = repoByGid(String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const pull = createPullIn(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        return this.sub(field, field, { __type: 'CreatePullRequestPayload', pull: nodePull(repo, pull) });
      }
      if (field.name === 'mergePullRequest') {
        const found = pullByGid(String(input.pullRequestId ?? ''));
        if (!found) throw new Error('pull request not found');
        if (found.pull.state === 'closed') throw new Error('pull request already closed');
        if (mergeConflict(found.repo, found.pull)) throw new Error('merge conflict');
        mergePull(found.repo, found.pull);
        return this.sub(field, field, { __type: 'MergePullRequestPayload', pull: nodePull(found.repo, found.pull) });
      }
      if (field.name === 'addComment') {
        const found = issueByGid(String(input.subjectId ?? ''));
        if (!found) throw new Error('subject not found');
        const comment: Comment = { id: found.repo.id * 10_000_000 + 2_000_000 + found.repo.nextComment++, body: String(input.body ?? ''), seq: ++globalSeq };
        found.issue.comments.push(comment);
        const node: GqlNode = { __type: 'IssueComment', id: gid('IssueComment', [found.repo.id, comment.id]), body: comment.body };
        return this.sub(field, field, { __type: 'AddCommentPayload', comment: node });
      }
    } catch (e) {
      this.errors.push({ message: e instanceof Error ? e.message : 'mutation failed' });
      return null;
    }
    this.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    return undefined;
  }

  private repositoryField(repo: Repo, field: GqlField, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'id': return gid('Repository', [repo.id]);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return this.sub(field, field, { __type: 'User', login: repo.owner });
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        if (tip === undefined) return null;
        return this.sub(field, field, { __type: 'Ref', name: repo.defaultBranch });
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'private': return repo.isPrivate;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? this.sub(field, field, nodeIssue(repo, issue)) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
        const direction = orderBy && String(orderBy.direction ?? '').toUpperCase() === 'DESC' ? 'desc' : 'asc';
        list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
        const after = cursorNumber(args.after);
        if (after !== null) list = list.filter((i) => i.number > after);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const hasNext = list.length > first;
        const endCursor = page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null;
        const conn: GqlNode = {
          __type: 'IssueConnection',
          nodes: page.map((i) => nodeIssue(repo, i)),
          pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor },
        };
        return this.sub(field, field, conn);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? this.sub(field, field, nodePull(repo, pull)) : null;
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
        list.sort((a, b) => a.seq - b.seq);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const conn: GqlNode = {
          __type: 'PullRequestConnection',
          nodes: page.map((p) => nodePull(repo, p)),
          pageInfo: { __type: 'PageInfo', hasNextPage: list.length > first, endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null },
        };
        return this.sub(field, field, conn);
      }
      default: return this.unknownField({ __type: 'Repository', repo }, field);
    }
  }

  private issueField(repo: Repo, issue: Issue, field: GqlField): unknown {
    switch (field.name) {
      case 'id': return gid('Issue', [repo.id, issue.number]);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt': return TRIAL_NOW_ISO;
      default: return this.unknownField({ __type: 'Issue', repo, issue }, field);
    }
  }

  private pullField(repo: Repo, pull: Pull, field: GqlField, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'id': return gid('PullRequest', [repo.id, pull.number]);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'mergeable': {
        if (pull.state === 'closed') return 'UNKNOWN';
        return mergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'files': {
        const headTip = branchTip(repo, pull.head) ?? pull.headSha;
        const baseObj = getObject(repo, pull.baseSha);
        const headObj = getObject(repo, headTip);
        if (!baseObj || !headObj) return this.sub(field, field, { __type: 'PullRequestConnection', nodes: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null } });
        const diff = diffTrees(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree);
        const first = typeof args.first === 'number' ? args.first : diff.length;
        const nodes = diff.slice(0, first).map((d) => ({ __type: 'PullRequestFile', path: d.filename }));
        return this.sub(field, field, { __type: 'PullRequestConnection', nodes, pageInfo: { __type: 'PageInfo', hasNextPage: diff.length > first, endCursor: null } });
      }
      case 'createdAt': return TRIAL_NOW_ISO;
      default: return this.unknownField({ __type: 'PullRequest', repo, pull }, field);
    }
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  let body: unknown;
  try { body = parseJsonBody(await readBody(req)); }
  catch (e) { sendJson(res, 400, { message: errMessage(e) }); return; }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (!isRecord(op) || typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'operation must carry a query string' }] };
    }
    const vars = isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {};
    try {
      const parsed = new GqlParser(tokenizeGql(op.query)).parseOperation();
      const ex = new GqlExecutor(vars);
      const data = ex.execute(parsed);
      const out: Record<string, unknown> = { data };
      if (ex.errors.length > 0) out.errors = ex.errors;
      return out;
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(body));
}

// -------------------------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over Streamable HTTP at /mcp
// -------------------------------------------------------------------------------------------

const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login (the token owner).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolTextResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function resolveToolRepo(args: Record<string, unknown>): { owner: string; name: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    if (owner === '') owner = o ?? '';
    if (name === '') name = r ?? '';
  }
  if (name === '' && typeof args.name === 'string') name = args.name;
  return { owner, name };
}

function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = name.replace(/^github__/, '').toLowerCase();
  const { owner, name: repoName } = resolveToolRepo(args);
  const need = (fields: string[]): string | null => {
    for (const f of fields) if (args[f] === undefined || args[f] === '') return f;
    return null;
  };
  if (norm === 'create_repo') {
    const missing = need(['name']);
    if (missing) return toolErrorResult(`missing required argument: ${missing}`);
    const repoName2 = String(args.name);
    const owner2 = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
    if (owner2 !== VIEWER_LOGIN) return toolErrorResult(`cannot create a repository for ${owner2}`);
    if (findRepo(VIEWER_LOGIN, repoName2)) return toolErrorResult(`repository ${repoName2} already exists`);
    const repo = newRepo(repoName2, args.private === true, typeof args.description === 'string' ? args.description : '');
    return toolTextResult({ ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` });
  }
  if (owner === '' || repoName === '') return toolErrorResult('missing required argument: owner or repo');
  if (owner !== VIEWER_LOGIN) return toolErrorResult(`repository ${owner}/${repoName} not found`);
  const repo = findRepo(owner, repoName);
  if (!repo) return toolErrorResult(`repository ${owner}/${repoName} not found`);
  if (norm === 'get_repo') {
    return toolTextResult({ ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` });
  }
  if (norm === 'create_issue') {
    const missing = need(['title']);
    if (missing) return toolErrorResult(`missing required argument: ${missing}`);
    const issue = createIssueIn(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolTextResult({ ...issueJson(repo, issue), full_name: `${repo.owner}/${repo.name}` });
  }
  if (norm === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, b) => a.seq - b.seq);
    return toolTextResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (norm === 'create_pull_request') {
    const missing = need(['title', 'head', 'base']);
    if (missing) return toolErrorResult(`missing required argument: ${missing}`);
    try {
      const pull = createPullIn(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      return toolTextResult({ ...pullJson(repo, pull), full_name: `${repo.owner}/${repo.name}` });
    } catch (e) {
      return toolErrorResult(e instanceof Error ? e.message : 'could not create pull request');
    }
  }
  if (norm === 'merge_pull_request') {
    const num = Number(args.pull_number);
    if (!Number.isInteger(num)) return toolErrorResult('missing required argument: pull_number');
    const pull = repo.pulls.get(num);
    if (!pull) return toolErrorResult(`pull request #${num} not found`);
    if (pull.state === 'closed') return toolErrorResult('pull request already closed');
    if (mergeConflict(repo, pull)) return toolErrorResult('merge conflict');
    const sha = mergePull(repo, pull);
    return toolTextResult({ ...pullJson(repo, pull), merged: true, sha });
  }
  return toolErrorResult(`unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let body: unknown;
  try { body = JSON.parse(text) as unknown; }
  catch {
    // Parse error: HTTP 400, JSON-RPC -32700, echoing the id when it can be read.
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
    let id: unknown = null;
    if (m) {
      const token = m[1]!;
      id = token.startsWith('"') ? token.slice(1, -1) : Number.parseInt(token, 10);
    }
    sendJson(res, 400, mcpError(id, -32700, 'Parse error'));
    return;
  }
  if (!checkAuth(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, mcpError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};
  const method = body.method;
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
    return;
  }
  if (method === 'initialize') {
    const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    sendEmpty(res, 202);
    return;
  }
  if (method === 'ping') { sendJson(res, 200, mcpResult(id, {})); return; }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((t) => t.name === toolName || `github__${t.name}` === toolName);
    if (!known) { sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${toolName}`)); return; }
    const result = runMcpTool(toolName, args);
    sendJson(res, 200, mcpResult(id, result));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// -------------------------------------------------------------------------------------------
// top-level router
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const { pathname, search } = urlOf(req);
        if (method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (pathname === '/mcp') { await handleMcp(req, res); return; }
        if (pathname === '/api/graphql') {
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          await handleGraphql(req, res);
          return;
        }
        if (pathname.startsWith('/api/v3')) { await handleRest(req, res); return; }
        // git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const service = gitMatch[3]!;
          if (method === 'GET' && service === 'info/refs') {
            await handleInfoRefs(req, res, owner, repoName, search.get('service') ?? '');
            return;
          }
          if (method === 'POST' && service === 'git-upload-pack') {
            await handleUploadPack(req, res, owner, repoName);
            return;
          }
          if (method === 'POST' && service === 'git-receive-pack') {
            await handleReceivePack(req, res, owner, repoName);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else res.destroy();
      }
    })();
  });
}
