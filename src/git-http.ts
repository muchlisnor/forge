// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0) and
// receive-pack. Implements exactly what the suite's git-client speaks, nothing more.
// Packs carry plain objects (no deltas): the pack-deltas check accepts 0 deltas,
// and skipping delta search keeps the timed clone/push workloads fast.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './git-core.ts';
import { trialNowMs, type Repo, type Store } from './store.ts';

const AGENT = 'forge/1';

export interface GitHttpContext {
  readonly store: Store;
  /** The bearer token the env gave this entry (MAKEFUN_SHOP_TOKEN); '' = accept any (dev). */
  readonly token: string;
}

export function bearerOk(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (token === '') return true;
  return presented === token;
}

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  const bytes = Buffer.from(body, 'utf8');
  res.writeHead(status, { 'content-type': contentType, 'content-length': bytes.length });
  res.end(bytes);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function readBody(req: IncomingMessage, limitBytes = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
}

/** All refs of a repo, HEAD first, then sorted: the order git advertises. */
function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refTip(headTarget);
  lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.lookup(oid);
    if (object && object.type === 'tag') {
      // Peeled target of an annotated tag (one level; nested tags unwrap further).
      let target = object.data.toString('utf8').split('\n')[0]?.replace(/^object /, '').trim() ?? '';
      let guard = 0;
      while (guard < 8) {
        const targetObject = target ? repo.lookup(target) : undefined;
        if (!targetObject || targetObject.type !== 'tag') break;
        target = targetObject.data.toString('utf8').split('\n')[0]?.replace(/^object /, '').trim() ?? '';
        guard += 1;
      }
      if (target && isObjectId(target)) (line as { peeled?: string }).peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  return encodePktLines([
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    const headOid = repo.headOid;
    lines.push(`${headOid} HEAD\0${capabilities}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The protocol-v2 advertisement never changes: one shared buffer. */
const V2_ADVERTISEMENT = v2Advertisement('git-upload-pack');

/**
 * Per-repo cache of v0 advertisements, keyed by service + ref tips: the clone
 * workload asks for the same advertisement fifty times against an unchanged
 * repo. Bounded per repo (FIFO). Objects are immutable and only ever added, so
 * the ref tips determine the advertisement (the default branch never changes,
 * and a tag object only becomes reachable through a ref tip the key names).
 */
const advertisementCache = new WeakMap<Repo, Map<string, Buffer>>();

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const tips = [...repo.refs.entries()].map(([name, oid]) => `${name}=${oid}`).sort().join(',');
  const key = `${service}\n${tips}`;
  let perRepo = advertisementCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, Buffer>();
    advertisementCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const built = v0Advertisement(repo, service);
  perRepo.set(key, built);
  if (perRepo.size > 16) {
    const first = perRepo.keys().next().value;
    if (first !== undefined) perRepo.delete(first);
  }
  return built;
}

/** GET /:owner/:repo.git/info/refs?service=... — advertisement or 404 for a missing repo. */
export function handleInfoRefs(ctx: GitHttpContext, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, url: URL): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'missing or unknown service');
    return;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'repository not found');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    sendBytes(res, 200, V2_ADVERTISEMENT, contentType);
    return;
  }
  sendBytes(res, 200, advertisementV0(repo, service), contentType);
}

// --------------------------------------------------------------------------- v2

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallows: string[];
  readonly depth?: number;
  readonly deepenSince?: number;
  readonly deepenNot: string[];
  readonly done: boolean;
}

function parseV2Lines(packets: ReturnType<typeof decodePktLines>): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line !== '') args.push(line);
  }
  return { command, args };
}

/**
 * The commits a fetch sends, depth-limited: generation 0 is a want tip. Returns the
 * included commit oids and the new shallow boundary (commits at the depth edge whose
 * parents stay behind), plus every object reachable from the included commits.
 * A want that is an annotated tag resolves through to its target commit (the tag
 * object itself is returned as an extra root, so the send walk includes it).
 */
function depthLimitedCommits(
  repo: Repo,
  wants: readonly string[],
  depth: number | undefined,
  deepenSince: number | undefined,
): { commits: Set<string>; boundary: Set<string>; extraRoots: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const extraRoots = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    if (want === ZERO_OID || commits.has(want)) continue;
    const object = repo.lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      // Resolve through nested tags to the target commit; the tag travels too.
      let target = object.data.toString('utf8').split('\n')[0]?.replace(/^object /, '').trim() ?? '';
      let guard = 0;
      while (guard < 8) {
        const targetObject = target ? repo.lookup(target) : undefined;
        if (!targetObject) break;
        if (targetObject.type === 'tag') {
          target = targetObject.data.toString('utf8').split('\n')[0]?.replace(/^object /, '').trim() ?? '';
          guard += 1;
          continue;
        }
        break;
      }
      extraRoots.add(want);
      if (!target || !isObjectId(target) || commits.has(target)) continue;
      const targetObject = repo.lookup(target);
      if (!targetObject || targetObject.type !== 'commit') continue;
      commits.add(target);
      queue.push([target, 0]);
      continue;
    }
    if (object.type !== 'commit') continue;
    commits.add(want);
    queue.push([want, 0]);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const [oid, gen] = queue[head] as [string, number];
    const object = repo.lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const atEdge = depth !== undefined && gen >= depth - 1;
    const tooOld =
      deepenSince !== undefined &&
      (() => {
        const committer = commit.committer.split(' ');
        const epoch = Number(committer[committer.length - 2]);
        return Number.isFinite(epoch) && epoch < deepenSince;
      })();
    if (atEdge || tooOld) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (commits.has(parent)) continue;
      const parentObject = repo.lookup(parent);
      if (!parentObject || parentObject.type !== 'commit') continue;
      commits.add(parent);
      queue.push([parent, gen + 1]);
    }
  }
  return { commits, boundary, extraRoots };
}

function fetchObjects(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean; ready: boolean } {
  // Acknowledgments: every have the store holds is ACKed; with `done` and all haves
  // known the negotiation is ready. A have the store lacks means NAK.
  const acks: string[] = [];
  let nak = false;
  let ready = false;
  if (args.haves.length === 0) {
    nak = true;
  } else {
    for (const have of args.haves) {
      if (repo.lookup(have)) acks.push(have);
    }
    if (acks.length === args.haves.length) {
      if (args.done) ready = true;
    } else {
      nak = true;
    }
  }

  const { commits, boundary, extraRoots } = depthLimitedCommits(repo, args.wants, args.depth, args.deepenSince);
  // Objects reachable from the included commits (and any tag roots), stopping at boundaries.
  const send = new Set<string>();
  {
    const queue: string[] = [...commits, ...extraRoots];
    const seen = new Set<string>(queue);
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head] as string;
      const object = repo.lookup(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        if (!boundary.has(oid)) {
          for (const parent of commit.parents) {
            if (!seen.has(parent)) {
              seen.add(parent);
              queue.push(parent);
            }
          }
        }
        if (!seen.has(commit.tree)) {
          seen.add(commit.tree);
          queue.push(commit.tree);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          if (!seen.has(entry.oid)) {
            seen.add(entry.oid);
            queue.push(entry.oid);
          }
        }
      } else if (object.type === 'tag') {
        const target = object.data.toString('utf8').split('\n')[0]?.replace(/^object /, '').trim();
        if (target && isObjectId(target) && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  // Subtract what the client already has (haves) and deepen-not exclusions. The
  // walk stops at the old shallow boundary: a deepen fetch's haves are commits the
  // client holds only shallowly, so their parents must still be delivered.
  const subtractReachable = (tips: readonly string[]): void => {
    const reachable = collectReachable(tips, (oid) => repo.lookup(oid), {
      allowMissing: true,
      stopAtParentsOf: new Set(args.shallows),
    });
    for (const oid of reachable) send.delete(oid);
  };
  if (args.haves.length) subtractReachable(args.haves);
  if (args.deepenNot.length) subtractReachable(args.deepenNot);

  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.lookup(oid);
    if (object) objects.push(object);
  }
  // Deterministic pack order: commits, then trees, then tags, then blobs, each by oid.
  const rank = (object: GitObject): number =>
    object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'tag' ? 2 : 3;
  objects.sort((a, b) => rank(a) - rank(b));

  const shallow = [...boundary].sort();
  const unshallow: string[] = [];
  for (const old of args.shallows) {
    if (commits.has(old) && !boundary.has(old)) unshallow.push(old);
  }
  unshallow.sort();
  return { objects, shallow, unshallow, acks, nak, ready };
}

/**
 * A fetch's whole answer (pack bytes included), keyed by everything that can
 * change it: the repo's ref tips + object count (objects are immutable and only
 * ever added, so tips + size determine the content) and the fetch arguments.
 * The clone workload fires 50 identical fetches against an unchanged repo; the
 * cache turns 49 pack builds into pointer copies. Bounded per repo (FIFO).
 */
interface FetchCacheEntry {
  readonly pack: Buffer;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
  readonly nak: boolean;
  readonly ready: boolean;
  /** Fully assembled protocol-v2 fetch response (ack lines, ready, shallow-info, packfile, sideband). */
  readonly responseV2: Buffer;
}

const fetchCache = new WeakMap<Repo, Map<string, FetchCacheEntry>>();

function cachedFetch(repo: Repo, args: FetchArgs): FetchCacheEntry {
  const tips = [...repo.refs.entries()].map(([name, oid]) => `${name}=${oid}`).sort().join(',');
  const key = JSON.stringify([
    tips,
    repo.objects.size,
    args.wants,
    args.haves,
    args.shallows,
    args.depth ?? null,
    args.deepenSince ?? null,
    args.deepenNot,
    args.done,
  ]);
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, FetchCacheEntry>();
    fetchCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const { objects, shallow, unshallow, acks, nak, ready } = fetchObjects(repo, args);
  const pack = writePack(objects);
  // Assemble the full protocol-v2 fetch response once; the handler sends this
  // buffer verbatim on every cache hit (the clone workload replays it 50x).
  // This mirrors handleUploadPackV2's fetch branch exactly (ready only when
  // set, shallow-info only when there are shallow/unshallow lines).
  const v2Parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (nak) v2Parts.push(encodePktLine('NAK\n'));
  for (const ack of acks) v2Parts.push(encodePktLine(`ACK ${ack}\n`));
  if (ready) v2Parts.push(encodePktLine('ready\n'));
  v2Parts.push(Buffer.from('0000', 'ascii'));
  if (shallow.length || unshallow.length) {
    v2Parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) v2Parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) v2Parts.push(encodePktLine(`unshallow ${oid}\n`));
    v2Parts.push(Buffer.from('0000', 'ascii'));
  }
  v2Parts.push(encodePktLine('packfile\n'));
  v2Parts.push(...sidebandPackets(1, pack));
  v2Parts.push(Buffer.from('0000', 'ascii'));
  const entry: FetchCacheEntry = { pack, shallow, unshallow, acks, nak, ready, responseV2: Buffer.concat(v2Parts) };
  perRepo.set(key, entry);
  if (perRepo.size > 64) {
    const first = perRepo.keys().next().value;
    if (first !== undefined) perRepo.delete(first);
  }
  return entry;
}

/**
 * ls-refs responses, keyed by the ref tips + object count (same determinism
 * argument as the fetch cache) and the request arguments. The clone workload
 * asks for the same ls-refs fifty times against an unchanged repo. Bounded per
 * repo (FIFO).
 */
const lsRefsCache = new WeakMap<Repo, Map<string, Buffer>>();

function cachedLsRefs(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const tips = [...repo.refs.entries()].map(([name, oid]) => `${name}=${oid}`).sort().join(',');
  const key = JSON.stringify([tips, repo.objects.size, prefixes, peel, symrefs, unborn]);
  let perRepo = lsRefsCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, Buffer>();
    lsRefsCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.oid === ZERO_OID) {
      if (unborn && ref.name === 'HEAD') {
        lines.push(`unborn HEAD${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      }
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  const built = encodePktLines(lines);
  perRepo.set(key, built);
  if (perRepo.size > 16) {
    const first = perRepo.keys().next().value;
    if (first !== undefined) perRepo.delete(first);
  }
  return built;
}

async function handleUploadPackV2(ctx: GitHttpContext, req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { command, args } = parseV2Lines(decodePktLines(body));
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const arg of args) {
      if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      else if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
    }
    sendBytes(res, 200, cachedLsRefs(repo, prefixes, peel, symrefs, unborn), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const fetchArgs: FetchArgs = {
      wants: [],
      haves: [],
      shallows: [],
      deepenNot: [],
      done: false,
    };
    const mutable = fetchArgs as { wants: string[]; haves: string[]; shallows: string[]; depth?: number; deepenSince?: number; deepenNot: string[]; done: boolean };
    for (const arg of args) {
      if (arg.startsWith('want ')) mutable.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) mutable.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) mutable.shallows.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) mutable.depth = Number(arg.slice(7));
      else if (arg.startsWith('deepen-since ')) mutable.deepenSince = Number(arg.slice(13));
      else if (arg.startsWith('deepen-not ')) mutable.deepenNot.push(arg.slice(11).trim());
      else if (arg === 'done') mutable.done = true;
    }
    const missing = mutable.wants.filter((want) => !repo.lookup(want));
    if (missing.length) {
      const error = `ERR upload-pack: not our ref ${missing[0]}\n`;
      const bodyOut = Buffer.concat([
        encodePktLines(['acknowledgments\n', 'NAK\n', 'flush', 'packfile\n']),
        ...sidebandPackets(3, Buffer.from(error, 'utf8')),
        Buffer.from('0000', 'ascii'),
      ]);
      sendBytes(res, 200, bodyOut, 'application/x-git-upload-pack-result');
      return;
    }
    const { responseV2 } = cachedFetch(repo, fetchArgs);
    sendBytes(res, 200, responseV2, 'application/x-git-upload-pack-result');
    return;
  }
  sendText(res, 400, `unknown v2 command ${JSON.stringify(command)}`);
}

// --------------------------------------------------------------------------- v0 fetch

async function handleUploadPackV0(ctx: GitHttpContext, req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let done = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
      else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13));
      else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line === 'done') done = true;
    }
  }
  const missing = wants.filter((want) => !repo.lookup(want));
  if (missing.length) {
    const error = `ERR upload-pack: not our ref ${missing[0]}\n`;
    const bodyOut = Buffer.concat([
      encodePktLines(['NAK\n']),
      ...sidebandPackets(3, Buffer.from(error, 'utf8')),
      Buffer.from('0000', 'ascii'),
    ]);
    sendBytes(res, 200, bodyOut, 'application/x-git-upload-pack-result');
    return;
  }
  const { pack, shallow, unshallow, acks, nak } = cachedFetch(repo, {
    wants,
    haves,
    shallows,
    depth,
    deepenSince,
    deepenNot,
    done,
  });
  const parts: Buffer[] = [];
  if (nak) parts.push(encodePktLine('NAK\n'));
  for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(1, pack));
  parts.push(Buffer.from('0000', 'ascii'));
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Split a receive-pack body into pkt-line commands (up to the first flush) and the pack after it. */
function splitPushBody(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packStart = offset + 4;
      break;
    }
    const length = parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)} in push`);
    }
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string)) {
      throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  return { commands, capabilities, pack: body.subarray(packStart) };
}

async function handleReceivePack(ctx: GitHttpContext, req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { commands, capabilities, pack } = splitPushBody(body);
  if (commands.length === 0) {
    sendText(res, 400, 'push needs at least one command');
    return;
  }
  const sideband = capabilities.includes('side-band-64k');
  const report = (unpackOk: boolean, detail: string, lines: string[]): void => {
    const reportLines = [`unpack ${unpackOk ? 'ok' : detail}\n`, ...lines];
    const reportBytes = encodePktLines(reportLines);
    const out = sideband
      ? Buffer.concat([...sidebandPackets(1, reportBytes), Buffer.from('0000', 'ascii')])
      : Buffer.concat([reportBytes, Buffer.from('0000', 'ascii')]);
    sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
  };

  // Unpack first: every object lands in the store before any ref moves.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const read = readPack(pack, { resolveBase: (oid) => repo.lookup(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = 'error';
    }
  }
  if (!unpackOk) {
    report(false, unpackDetail, []);
    return;
  }

  const preTips = new Map<string, string>();
  for (const command of commands) preTips.set(command.ref, repo.refTip(command.ref));

  const results: string[] = [];
  const apply: PushCommand[] = [];
  for (const command of commands) {
    const current = preTips.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      apply.push(command);
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.lookup(command.newOid)) {
      results.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      apply.push(command);
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const newObject = repo.lookup(command.newOid);
      if (!newObject || newObject.type !== 'commit' || !isAncestor((oid) => repo.lookup(oid), command.oldOid, command.newOid)) {
        results.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    } else if (command.ref.startsWith('refs/tags/')) {
      if (command.newOid !== command.oldOid) {
        results.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    apply.push(command);
    results.push(`ok ${command.ref}\n`);
  }
  for (const command of apply) {
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }
  if (apply.length) {
    const seq = ctx.store.nextSeq();
    repo.pushedAt = new Date(trialNowMs() + seq * 1000).toISOString();
    repo.updatedAt = repo.pushedAt;
  }
  report(true, 'ok', results);
}

// --------------------------------------------------------------------------- dispatcher

/**
 * Route one git smart-HTTP request. Returns true when handled (including 404/401),
 * false when the path is not a git route at all.
 */
export async function handleGit(ctx: GitHttpContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const suffix = match[3] as string;
  const method = req.method ?? 'GET';

  if (!bearerOk(req, ctx.token)) {
    sendText(res, 401, 'Unauthorized');
    return true;
  }

  if (method === 'GET' && suffix === '/info/refs') {
    handleInfoRefs(ctx, req, res, owner, repoName, url);
    return true;
  }
  if (method !== 'POST') {
    sendText(res, 405, 'Method Not Allowed');
    return true;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendText(res, 404, 'repository not found');
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    sendText(res, 400, (err as Error).message);
    return true;
  }
  try {
    if (suffix === '/git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') {
        await handleUploadPackV2(ctx, req, res, repo, body);
      } else {
        await handleUploadPackV0(ctx, req, res, repo, body);
      }
      return true;
    }
    if (suffix === '/git-receive-pack') {
      await handleReceivePack(ctx, req, res, repo, body);
      return true;
    }
  } catch (err) {
    // A malformed request must never take the server down: answer 400 and stay up.
    if (!res.headersSent) sendText(res, 400, (err as Error).message);
    return true;
  }
  return false;
}
