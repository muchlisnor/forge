// GitHub REST v3: the /api/v3 surface the suite drives. Every reply is JSON and
// carries a non-empty X-GitHub-Request-Id; unknown routes are JSON 404s; a malformed
// JSON body is a 400. Ownership: a repo belongs to the token's login (adaiversen);
// the same name under another login is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObjectId, parseCommit, parseTree, type GitObject } from './git-core.ts';
import {
  VIEWER,
  globalId,
  stampAt,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  readonly store: Store;
  readonly token: string;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(buf);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
}

function message(status: number, text: string): { status: number; body: { message: string } } {
  return { status, body: { message: text } };
}

export function bearerOk(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (token === '') return true;
  return presented === token;
}

function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
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

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function originOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'entry'}`;
}

interface PageParams {
  readonly page: number;
  readonly perPage: number;
}

function pageParams(url: URL): PageParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

/** Slice `items` to one page and build the GitHub Link header (rel next/prev/first/last). */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `${originOf(req)}${url.pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (current < totalPages) {
    links.push(`<${build(current + 1)}>; rel="next"`);
    links.push(`<${build(totalPages)}>; rel="last"`);
  }
  if (current > 1) {
    links.push(`<${build(1)}>; rel="first"`);
    links.push(`<${build(current - 1)}>; rel="prev"`);
  }
  return { page: pageItems, link: links.length ? links.join(', ') : null };
}

// --------------------------------------------------------------------------- serializers

/** The viewer user's JSON: constant (the token owner never changes), built once. */
const VIEWER_JSON: Record<string, unknown> = buildUserJson(VIEWER.login);

function userJson(login: string): Record<string, unknown> {
  if (login === VIEWER.login) return VIEWER_JSON;
  return buildUserJson(login);
}

function buildUserJson(login: string): Record<string, unknown> {
  const user = login === VIEWER.login ? VIEWER : { id: 0, login, name: login, email: `${login}@example.invalid`, type: 'User' as const };
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('user', [user.id]),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
    html_url: `https://github.com/${user.login}`,
    url: `/api/v3/users/${user.login}`,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: repo.hasProjects,
    has_downloads: repo.hasDownloads,
    has_wiki: repo.hasWiki,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issue.globalId,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: null };
    }),
    assignees: issue.assignees.map((login) => userJson(login)),
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

/**
 * Serialized single-issue response, cached per issue. The read workload GETs
 * the same issue 2,000 times unchanged; the cache turns 1,999 serializations
 * into pointer copies. The entry is validated against every field issueJson
 * reads (title, body, state, labels incl. colors, assignees, comment count,
 * updatedAt, closedAt), so any mutation — PATCH, comment add, label color
 * change — rebuilds it on the next read. The x-github-request-id header is
 * still minted fresh per response (it only has to be non-empty).
 */
interface IssueBytesEntry {
  readonly buf: Buffer;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly comments: number;
  readonly labelsKey: string;
  readonly assigneesKey: string;
}

const issueBytesCache = new WeakMap<Repo, Map<number, IssueBytesEntry>>();

function sendCachedIssueJson(res: ServerResponse, repo: Repo, issue: Issue): void {
  const labelsKey = issue.labels.map((name) => `${name}=${repo.labels.get(name)?.color ?? 'ededed'}`).join(',');
  const assigneesKey = issue.assignees.join(',');
  let perRepo = issueBytesCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<number, IssueBytesEntry>();
    issueBytesCache.set(repo, perRepo);
  }
  const hit = perRepo.get(issue.number);
  let buf: Buffer;
  if (
    hit !== undefined &&
    hit.title === issue.title &&
    hit.body === issue.body &&
    hit.state === issue.state &&
    hit.updatedAt === issue.updatedAt &&
    hit.closedAt === issue.closedAt &&
    hit.comments === issue.comments.length &&
    hit.labelsKey === labelsKey &&
    hit.assigneesKey === assigneesKey
  ) {
    buf = hit.buf;
  } else {
    buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
    perRepo.set(issue.number, {
      buf,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      updatedAt: issue.updatedAt,
      closedAt: issue.closedAt,
      comments: issue.comments.length,
      labelsKey,
      assigneesKey,
    });
    if (perRepo.size > 4096) {
      const first = perRepo.keys().next().value;
      if (first !== undefined) perRepo.delete(first);
    }
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'x-github-request-id': requestId(),
  });
  res.end(buf);
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pull.globalId,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.mergeable === 'MERGEABLE',
    mergeable_state: pull.mergeable === 'MERGEABLE' ? 'clean' : pull.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
  };
}

/** Line multiset diff: additions/deletions between two file contents. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldCounts = count(oldText);
  const newCounts = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
  for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

function pullFileJson(store: Store, repo: Repo, pull: Pull, file: { path: string; status: string }): Record<string, unknown> {
  const blobText = (commitSha: string): string => {
    const treeOid = store.commitTree(repo, commitSha);
    if (treeOid === null) return '';
    const files = new Map<string, string>();
    store.flattenTree(repo, treeOid, '', files);
    const blobOid = files.get(file.path);
    if (!blobOid) return '';
    const object = repo.lookup(blobOid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  };
  const { additions, deletions } = lineDiff(blobText(pull.baseSha), blobText(pull.headSha));
  return {
    filename: file.path,
    status: file.status,
    additions,
    deletions,
    changes: additions + deletions,
  };
}

// --------------------------------------------------------------------------- helpers

/** Parse a "Name <email> epoch +0000" ident line into its parts. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line, email: '', date: '' };
  const epoch = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(epoch * 1000).toISOString(),
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.lookup(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha: oid,
    node_id: globalId('commit', [repo.id, oid]),
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `https://github.com/${repo.fullName}/commit/${oid}`,
  };
}

/** Commits reachable from `tip`, newest first (BFS from the tip). */
function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  seen.add(tip);
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    const object = repo.lookup(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------- handlers

type Handler = (ctx: RestContext, req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>, body: Record<string, unknown>) => void;

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** The repo at /repos/{owner}/{name}, or null (404 when absent or foreign-owned). */
function loadRepo(ctx: RestContext, params: Record<string, string>): Repo | null {
  const owner = params.owner as string;
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, params.repo as string) ?? null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Split a /contents/{path...} remainder into path segments, or null when malformed. */
function contentPath(params: Record<string, string>): string | null {
  const raw = params.rest ?? '';
  const decoded = decodeURIComponent(raw);
  if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..')) return null;
  return decoded.replace(/^\/+/, '').replace(/\/+$/, '');
}

const handlers: Array<{ method: string; pattern: RegExp; raw: string; keys: string[]; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([a-z]+)|\*\*?/g, (m, key) => {
      if (m === '**') {
        keys.push('rest');
        return '(.*)';
      }
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  handlers.push({ method, pattern: regex, raw: pattern, keys, handler });
}

route('GET', '/api/v3/', (_ctx, _req, res) => {
  sendJson(res, 200, {
    current_user_url: '/api/v3/user',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
  }, { 'x-oauth-scopes': 'repo, read:org' });
});

route('GET', '/api/v3/meta', (_ctx, _req, res) => {
  sendJson(res, 200, { installed_version: '1.0.0' });
});

route('GET', '/api/v3/user', (ctx, _req, res) => {
  sendJson(res, 200, userJson(VIEWER.login));
});

route('GET', '/api/v3/user/repos', (ctx, req, res, url) => {
  const repos = ctx.store.listRepos(VIEWER.login);
  const { page, link } = paginate(req, url, repos);
  sendJson(res, 200, page.map(repoJson), link ? { link } : {});
});

route('POST', '/api/v3/user/repos', (ctx, _req, res, _url, _params, body) => {
  const name = str(body.name);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    sendJson(res, 422, { message: 'Invalid repository name' });
    return;
  }
  const created = ctx.store.createRepo(VIEWER.login, name, {
    description: str(body.description),
    private: bool(body.private, true),
  });
  if (!created) {
    sendJson(res, 422, { message: 'Repository already exists' });
    return;
  }
  sendJson(res, 201, repoJson(created));
});

route('GET', '/api/v3/repos/:owner/:repo', (ctx, _req, res, _url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  sendJson(res, 200, repoJson(repo));
});

route('PATCH', '/api/v3/repos/:owner/:repo', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.has_issues === 'boolean') repo.hasIssues = body.has_issues;
  if (typeof body.has_wiki === 'boolean') repo.hasWiki = body.has_wiki;
  repo.updatedAt = stampAt(ctx.store.nextSeq());
  sendJson(res, 200, repoJson(repo));
});

route('DELETE', '/api/v3/repos/:owner/:repo', (ctx, _req, res, _url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  ctx.store.deleteRepo(params.owner as string, params.repo as string);
  sendNoContent(res);
});

route('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, req, res, url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
    .map((name) => ({ name, commit: { sha: repo.refTip(`refs/heads/${name}`) }, protected: false }));
  const { page, link } = paginate(req, url, branches);
  sendJson(res, 200, page, link ? { link } : {});
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith('refs/') || !isObjectId(sha)) {
    sendJson(res, 422, { message: 'Invalid ref or sha' });
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(res, 422, { message: 'Reference already exists' });
    return;
  }
  const object = repo.lookup(sha);
  if (!object || (ref.startsWith('refs/heads/') && object.type !== 'commit')) {
    sendJson(res, 422, { message: 'Object does not exist' });
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, node_id: globalId('ref', [repo.id, ref]), object: { sha, type: object.type } });
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, req, res, url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const shaParam = url.searchParams.get('sha');
  const tip = shaParam ? ctx.store.resolveRef(repo, shaParam) : repo.headOid;
  if (!tip || tip === '0000000000000000000000000000000000000000') {
    sendJson(res, 200, []);
    return;
  }
  const commits = listCommits(repo, tip)
    .map((oid) => commitJson(repo, oid))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const { page, link } = paginate(req, url, commits);
  sendJson(res, 200, page, link ? { link } : {});
});

route('GET', '/api/v3/repos/:owner/:repo/contents/**', (ctx, req, res, url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const path = contentPath(params);
  if (path === null) return notFound(res);
  const refParam = url.searchParams.get('ref');
  const tip = refParam ? ctx.store.resolveRef(repo, refParam) : repo.headOid;
  if (!tip || tip === '0000000000000000000000000000000000000000') return notFound(res);
  const treeOid = ctx.store.commitTree(repo, tip);
  if (treeOid === null) return notFound(res);
  const files = new Map<string, string>();
  ctx.store.flattenTree(repo, treeOid, '', files);
  if (path === '') {
    // Root listing.
    const entries = rootEntries(repo, treeOid);
    sendJson(res, 200, entries);
    return;
  }
  const blobOid = files.get(path);
  if (blobOid) {
    const object = repo.lookup(blobOid);
    if (!object || object.type !== 'blob') return notFound(res);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: path.split('/').pop(),
      path,
      content: object.data.toString('base64'),
      sha: blobOid,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    });
    return;
  }
  // Directory listing: entries directly under `path/`.
  const prefix = `${path}/`;
  const entries: Record<string, unknown>[] = [];
  const seen = new Map<string, Record<string, unknown>>();
  for (const filePath of files.keys()) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const oid = files.get(filePath) as string;
      const object = repo.lookup(oid);
      seen.set(rest, {
        type: 'file',
        size: object && object.type === 'blob' ? object.data.length : 0,
        name: rest,
        path: filePath,
        sha: oid,
        url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
      });
    } else {
      const dir = rest.slice(0, slash);
      if (!seen.has(dir)) {
        seen.set(dir, { type: 'dir', size: 0, name: dir, path: `${path}/${dir}`, sha: dirTreeOid(repo, treeOid, path, dir), url: `/api/v3/repos/${repo.fullName}/contents/${path}/${dir}` });
      }
    }
  }
  if (seen.size === 0) return notFound(res);
  for (const entry of [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))) entries.push(entry);
  sendJson(res, 200, entries);
});

function rootEntries(repo: Repo, treeOid: string): Record<string, unknown>[] {
  const object = repo.lookup(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data)
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const child = !isDir ? repo.lookup(entry.oid) : null;
      return {
        type: isDir ? 'dir' : 'file',
        size: child && child.type === 'blob' ? child.data.length : 0,
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        url: `/api/v3/repos/${repo.fullName}/contents/${entry.name}`,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function dirTreeOid(repo: Repo, treeOid: string, dirPath: string, dir: string): string {
  // Walk the tree to the directory's own tree oid; fall back to the parent tree.
  const segments = [...dirPath.split('/').filter(Boolean), dir];
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.lookup(current);
    if (!object || object.type !== 'tree') return treeOid;
    const entry = parseTree(object.data).find((item) => item.name === segment && item.mode === '40000');
    if (!entry) return treeOid;
    current = entry.oid;
  }
  return current;
}

route('PUT', '/api/v3/repos/:owner/:repo/contents/**', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const path = contentPath(params);
  const message = str(body.message);
  const contentB64 = str(body.content);
  const branch = str(body.branch) || repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (path === null || path === '' || !message || !contentB64) {
    sendJson(res, 422, { message: 'Missing path, message or content' });
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    sendJson(res, 400, { message: 'Content is not valid base64' });
    return;
  }
  const result = ctx.store.commitFile(repo, branch, path, content, message, sha);
  if ('error' in result) {
    if (result.error === 'stale') sendJson(res, 409, { message: 'sha does not match the current blob' });
    else if (result.error === 'sha-required') sendJson(res, 422, { message: 'sha is required to update a file' });
    else sendJson(res, 404, { message: 'Branch not found' });
    return;
  }
  sendJson(res, result.isNew ? 201 : 200, {
    content: {
      name: path.split('/').pop(),
      path,
      sha: result.contentSha,
      size: content.length,
      encoding: 'base64',
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    },
    commit: { sha: result.commitSha },
  });
});

route('DELETE', '/api/v3/repos/:owner/:repo/contents/**', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const path = contentPath(params);
  const message = str(body.message);
  const branch = str(body.branch) || repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (path === null || path === '' || !message) {
    sendJson(res, 422, { message: 'Missing path or message' });
    return;
  }
  const result = ctx.store.deleteFile(repo, branch, path, message, sha);
  if ('error' in result) {
    if (result.error === 'stale') sendJson(res, 409, { message: 'sha does not match the current blob' });
    else if (result.error === 'not-found') sendJson(res, 404, { message: 'Not Found' });
    else sendJson(res, 404, { message: 'Branch not found' });
    return;
  }
  sendJson(res, 200, { commit: { sha: result.commitSha } });
});

route('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const name = str(body.name);
  const color = str(body.color) || 'ededed';
  if (!name) {
    sendJson(res, 422, { message: 'Label name is required' });
    return;
  }
  if (repo.labels.has(name)) {
    sendJson(res, 422, { message: 'Label already exists' });
    return;
  }
  repo.labels.set(name, { name, color });
  sendJson(res, 201, { name, color, description: null });
});

route('GET', '/api/v3/repos/:owner/:repo/labels', (ctx, _req, res, _url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: null })));
});

route('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const title = str(body.title);
  if (!title) {
    sendJson(res, 422, { message: 'Title is required' });
    return;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      sendJson(res, 422, { message: `Label '${label}' does not exist` });
      return;
    }
  }
  const issue = ctx.store.createIssue(repo, { title, body: str(body.body), labels });
  sendJson(res, 201, issueJson(repo, issue));
});

route('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, req, res, url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, link } = paginate(req, url, issues);
  sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link ? { link } : {});
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, _req, res, _url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const issue = ctx.store.getIssue(repo, Number(params.number));
  if (!issue) return notFound(res);
  sendCachedIssueJson(res, repo, issue);
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const issue = ctx.store.getIssue(repo, Number(params.number));
  if (!issue) return notFound(res);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? issue.closedAt ?? stampAt(ctx.store.nextSeq()) : null;
  }
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((item): item is string => typeof item === 'string');
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        sendJson(res, 422, { message: `Label '${label}' does not exist` });
        return;
      }
    }
    issue.labels = labels;
  }
  issue.updatedAt = stampAt(ctx.store.nextSeq());
  sendJson(res, 200, issueJson(repo, issue));
});

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const issue = ctx.store.getIssue(repo, Number(params.number));
  if (!issue) return notFound(res);
  const text = str(body.body);
  if (!text) {
    sendJson(res, 422, { message: 'Comment body is required' });
    return;
  }
  const comment = ctx.store.addComment(repo, issue, text);
  sendJson(res, 201, commentJson(repo, issue, comment));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, req, res, url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const issue = ctx.store.getIssue(repo, Number(params.number));
  if (!issue) return notFound(res);
  const { page, link } = paginate(req, url, issue.comments);
  sendJson(res, 200, page.map((comment) => commentJson(repo, issue, comment)), link ? { link } : {});
});

route('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const head = str(body.head);
  const base = str(body.base);
  const title = str(body.title);
  if (!head || !base || !title) {
    sendJson(res, 422, { message: 'head, base and title are required' });
    return;
  }
  if (head === base) {
    sendJson(res, 422, { message: 'Head and base must differ' });
    return;
  }
  if (repo.refTip(`refs/heads/${head}`) === '0000000000000000000000000000000000000000' || repo.refTip(`refs/heads/${base}`) === '0000000000000000000000000000000000000000') {
    sendJson(res, 422, { message: 'Head or base branch does not exist' });
    return;
  }
  const pull = ctx.store.createPull(repo, { title, body: str(body.body), headRef: head, baseRef: base });
  if (!pull) {
    sendJson(res, 422, { message: 'Could not create the pull request' });
    return;
  }
  sendJson(res, 201, pullJson(repo, pull));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, req, res, url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const state = url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, link } = paginate(req, url, pulls);
  sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), link ? { link } : {});
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, _req, res, _url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const pull = ctx.store.getPull(repo, Number(params.number));
  if (!pull) return notFound(res);
  sendJson(res, 200, pullJson(repo, pull));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, _req, res, _url, params) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const pull = ctx.store.getPull(repo, Number(params.number));
  if (!pull) return notFound(res);
  sendJson(res, 200, pull.files.map((file) => pullFileJson(ctx.store, repo, pull, file)));
});

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, _req, res, _url, params, body) => {
  const repo = loadRepo(ctx, params);
  if (!repo) return notFound(res);
  const pull = ctx.store.getPull(repo, Number(params.number));
  if (!pull) return notFound(res);
  if (pull.state !== 'open' || pull.merged) {
    sendJson(res, 405, { message: 'Pull request is already merged or closed' });
    return;
  }
  // Refresh the base to its current tip and re-check conflicts: a sibling PR may
  // have merged since this one was opened.
  pull.baseSha = repo.refTip(`refs/heads/${pull.baseRef}`);
  pull.mergeable = ctx.store.computeMergeable(repo, pull);
  if (pull.mergeable === 'CONFLICTING') {
    sendJson(res, 405, { message: 'Merge conflict' });
    return;
  }
  const methodRaw = str(body.merge_method).toUpperCase();
  const method = methodRaw === 'MERGE' || methodRaw === 'REBASE' ? methodRaw : 'SQUASH';
  const sha = ctx.store.mergePull(repo, pull, method);
  if (!sha) {
    sendJson(res, 405, { message: 'Merge conflict' });
    return;
  }
  sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
});

/**
 * Routes grouped by (method, third path segment): every pattern's third segment
 * is a literal ('', 'meta', 'user' or 'repos'), and a route's regex is anchored
 * at that literal, so a request can only match a route in its own group. Built
 * lazily on first use; if any pattern ever stops being indexable the flat list
 * is used instead, so dispatch stays correct.
 */
let routeGroups: Map<string, typeof handlers> | null = null;
let routeGroupsUsable = true;

function routeCandidates(method: string, segment: string): typeof handlers {
  if (routeGroups === null) {
    routeGroups = new Map<string, typeof handlers>();
    for (const entry of handlers) {
      const seg = entry.raw.split('/')[3] ?? '';
      if (seg.startsWith(':') || seg === '**') {
        routeGroupsUsable = false;
        break;
      }
      const key = `${entry.method}\n${seg}`;
      const group = routeGroups.get(key);
      if (group) group.push(entry);
      else routeGroups.set(key, [entry]);
    }
  }
  if (!routeGroupsUsable) return handlers;
  return routeGroups.get(`${method}\n${segment}`) ?? [];
}

// --------------------------------------------------------------------------- dispatcher

/**
 * Route one REST request. Returns true when handled (including 401/404),
 * false when the path is not under /api/v3 at all.
 */
export async function handleRest(ctx: RestContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // The API root and meta need no token (as on api.github.com); everything else does.
  const needsAuth = !(path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta');
  if (needsAuth && !bearerOk(req, ctx.token)) {
    unauthorized(res);
    return true;
  }

  for (const entry of routeCandidates(method, path.split('/')[3] ?? '')) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    entry.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1] as string);
    });
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      body = parsed.value;
    }
    try {
      entry.handler(ctx, req, res, url, params, body);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { message: (err as Error).message });
    }
    return true;
  }
  notFound(res);
  return true;
}
