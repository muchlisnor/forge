// The forge's in-memory store: one source of truth for git, REST, GraphQL and MCP.
// Everything is deterministic: ids are opaque encodings of stable counters, timestamps
// are the trial now plus a monotonic sequence (strictly increasing in creation order),
// and iteration order is insertion order. No wall clock, no Math.random.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git-core.ts';

/** The trial's "now": MAKEFUN_TRIAL_NOW when set, else the wall clock (local dev only). */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** An ISO timestamp from the trial now plus `seq` seconds: distinct, ordered, deterministic. */
export function stampAt(seq: number): string {
  return new Date(trialNowMs() + seq * 1000).toISOString();
}

/** Deterministic opaque global id: base64url of a type tag + stable numeric parts. */
export function globalId(tag: string, parts: readonly (number | string)[]): string {
  return Buffer.from(`${tag}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly type: 'User' | 'Organization';
}

/** The scenario's fixed users (wire.ts seed 0x6a09e667f3bcc909): the token owner is adaiversen. */
export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
export const ORG: User = { id: 2000, login: 'faint-meadow-org', name: 'faint meadow org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };

export interface IssueComment {
  readonly id: number;
  readonly globalId: string;
  body: string;
  readonly user: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Issue {
  readonly number: number;
  readonly globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly user: string;
  labels: string[];
  assignees: string[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: IssueComment[];
  readonly seq: number;
}

export interface PullFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
}

export interface Pull {
  readonly number: number;
  readonly globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeCommitSha: string | null;
  readonly user: string;
  readonly createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  files: PullFile[];
  readonly seq: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  hasIssues = true;
  hasWiki = true;
  hasProjects = true;
  hasDownloads = true;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string | null = null;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextIssueNumber = 1;
  nextPullNumber = 1;
  nextCommentId = 1;
  readonly seq: number;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
    this.createdAt = stampAt(seq);
    this.updatedAt = this.createdAt;
    this.seq = seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get globalId(): string {
    return globalId('repo', [this.id]);
  }

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(ref: string): string {
    return this.refs.get(ref) ?? ZERO_OID;
  }

  /** The default branch's tip, or ZERO_OID on an empty repo. */
  get headOid(): string {
    return this.refTip(`refs/heads/${this.defaultBranch}`);
  }
}

export class Store {
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  #repoSeq = 0;
  #nextRepoId = 10000;
  #clock = 0;

  constructor() {
    for (const user of [VIEWER, TEAMMATE, STRANGER, ORG]) this.users.set(user.login, user);
  }

  /** A strictly increasing sequence number: orders every created entity deterministically. */
  nextSeq(): number {
    this.#clock += 1;
    return this.#clock;
  }

  user(login: string): User | undefined {
    return this.users.get(login);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean } = {}): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const seq = this.nextSeq();
    const repo = new Repo(this.#nextRepoId, owner, name, options.description ?? '', options.private ?? true, seq);
    this.#nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body?: string; user?: string; labels?: string[] }): Issue {
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const seq = this.nextSeq();
    const at = stampAt(seq);
    const issue: Issue = {
      number,
      globalId: globalId('issue', [repo.id, number]),
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      user: input.user ?? VIEWER.login,
      labels: [...(input.labels ?? [])],
      assignees: [],
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      comments: [],
      seq,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string, user: string = VIEWER.login): IssueComment {
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const seq = this.nextSeq();
    const at = stampAt(seq);
    const comment: IssueComment = {
      id,
      globalId: globalId('comment', [repo.id, issue.number, id]),
      body,
      user,
      createdAt: at,
      updatedAt: at,
    };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(repo: Repo, input: { title: string; body?: string; headRef: string; baseRef: string; user?: string }): Pull | null {
    const headSha = repo.refTip(`refs/heads/${input.headRef}`);
    const baseSha = repo.refTip(`refs/heads/${input.baseRef}`);
    if (headSha === ZERO_OID || baseSha === ZERO_OID) return null;
    const number = repo.nextPullNumber;
    repo.nextPullNumber += 1;
    const seq = this.nextSeq();
    const at = stampAt(seq);
    const pull: Pull = {
      number,
      globalId: globalId('pull', [repo.id, number]),
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      headRef: input.headRef,
      baseRef: input.baseRef,
      headSha,
      baseSha,
      mergeable: 'UNKNOWN',
      mergeCommitSha: null,
      user: input.user ?? VIEWER.login,
      createdAt: at,
      updatedAt: at,
      mergedAt: null,
      files: [],
      seq,
    };
    pull.files = this.diffFiles(repo, baseSha, headSha);
    pull.mergeable = this.computeMergeable(repo, pull);
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Paths changed between two commits' trees (added/modified/removed), sorted by path. */
  diffFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
    const baseTree = this.commitTree(repo, baseSha);
    const headTree = this.commitTree(repo, headSha);
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    if (baseTree) this.flattenTree(repo, baseTree, '', baseFiles);
    if (headTree) this.flattenTree(repo, headTree, '', headFiles);
    const out: PullFile[] = [];
    for (const [path, oid] of headFiles) {
      if (!baseFiles.has(path)) out.push({ path, status: 'added' });
      else if (baseFiles.get(path) !== oid) out.push({ path, status: 'modified' });
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path)) out.push({ path, status: 'removed' });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    if (!isObjectId(commitOid) || commitOid === ZERO_OID) return null;
    const object = repo.lookup(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
    const object = repo.lookup(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else if (entry.mode !== '160000') out.set(path, entry.oid);
    }
  }

  /** The merge-base of two commits: the nearest common ancestor (BFS from both sides). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    fromA.set(a, 0);
    for (let head = 0; head < queueA.length; head += 1) {
      const [oid, depth] = queueA[head] as [string, number];
      const object = repo.lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!fromA.has(parent)) {
          fromA.set(parent, depth + 1);
          queueA.push([parent, depth + 1]);
        }
      }
    }
    const queueB: Array<[string, number]> = [[b, 0]];
    const seenB = new Set<string>([b]);
    let best: string | null = null;
    let bestScore = Infinity;
    for (let head = 0; head < queueB.length; head += 1) {
      const [oid, depthB] = queueB[head] as [string, number];
      const depthA = fromA.get(oid);
      if (depthA !== undefined) {
        const score = depthA + depthB;
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const object = repo.lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seenB.has(parent)) {
          seenB.add(parent);
          queueB.push([parent, depthB + 1]);
        }
      }
    }
    return best;
  }

  computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const base = this.mergeBase(repo, pull.baseSha, pull.headSha);
    if (base === null) return 'UNKNOWN';
    const baseSide = new Set(this.diffFiles(repo, base, pull.baseSha).map((f) => f.path));
    const headSide = this.diffFiles(repo, base, pull.headSha);
    for (const file of headSide) if (baseSide.has(file.path)) return 'CONFLICTING';
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull: one commit on the base branch whose tree is the base tree
   * with the head side's changes applied, parent = base tip. Returns the new tip.
   */
  mergePull(repo: Repo, pull: Pull, method: 'MERGE' | 'SQUASH' | 'REBASE'): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    const baseTree = this.commitTree(repo, pull.baseSha);
    if (baseTree === null) return null;
    const headTree = this.commitTree(repo, pull.headSha);
    const changes: Array<{ path: string; oid: string | null }> = [];
    if (headTree !== null) {
      const headFiles = new Map<string, string>();
      this.flattenTree(repo, headTree, '', headFiles);
      const baseFiles = new Map<string, string>();
      this.flattenTree(repo, baseTree, '', baseFiles);
      for (const [path, oid] of headFiles) changes.push({ path, oid });
      for (const path of baseFiles.keys()) if (!headFiles.has(path)) changes.push({ path, oid: null });
    }
    const newTree = this.applyTreeChanges(repo, baseTree, changes);
    const epoch = Math.floor(trialNowMs() / 1000) + this.nextSeq();
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const message =
      method === 'SQUASH' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commitData = buildCommit(
      { tree: newTree, parents: [pull.baseSha], author, committer: author, message },
      epoch,
    );
    const commitOid = repo.putObject('commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = commitOid;
    pull.headSha = commitOid;
    pull.baseSha = commitOid;
    const seq = this.nextSeq();
    pull.mergedAt = stampAt(seq);
    pull.updatedAt = pull.mergedAt;
    repo.pushedAt = pull.mergedAt;
    return commitOid;
  }

  /**
   * Apply file additions/updates/deletions to a tree. Flattens the tree to a
   * path map, applies the changes, then rebuilds bottom-up. Returns the new tree oid.
   */
  applyTreeChanges(repo: Repo, treeOid: string, changes: readonly { path: string; oid: string | null }[]): string {
    const files = new Map<string, string>();
    this.flattenTree(repo, treeOid, '', files);
    for (const change of changes) {
      if (change.oid === null) files.delete(change.path);
      else files.set(change.path, change.oid);
    }
    const buildDir = (paths: Map<string, string>): string => {
      const direct = new Map<string, string>();
      const sub = new Map<string, Map<string, string>>();
      for (const [path, oid] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          direct.set(path, oid);
        } else {
          const dir = path.slice(0, slash);
          let inner = sub.get(dir);
          if (!inner) {
            inner = new Map<string, string>();
            sub.set(dir, inner);
          }
          inner.set(path.slice(slash + 1), oid);
        }
      }
      const entries: TreeEntry[] = [];
      for (const [name, oid] of direct) entries.push({ mode: '100644', name, oid });
      for (const [name, inner] of sub) entries.push({ mode: '40000', name, oid: buildDir(inner) });
      return repo.putObject('tree', buildTree(entries));
    };
    return buildDir(files);
  }

  /** Resolve a ref name, full ref, tag, or commit sha to a commit oid (null when unknown). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = repo.lookup(ref);
      if (!object) return null;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') {
        const target = object.data.toString('utf8').split('\n')[0]?.replace(/^object /, '').trim();
        if (target && isObjectId(target)) return this.resolveRef(repo, target);
      }
      return null;
    }
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const candidate of candidates) {
      const tip = repo.refs.get(candidate);
      if (tip !== undefined) return this.resolveRef(repo, tip);
    }
    return null;
  }

  /** The blob oid at `path` in the tree of `commitOid` (null when absent). */
  blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (treeOid === null) return null;
    const files = new Map<string, string>();
    this.flattenTree(repo, treeOid, '', files);
    return files.get(path) ?? null;
  }

  /**
   * Commit one file change on a branch (the REST contents API). Returns the new
   * commit and blob ids, or an error key: 'stale' (sha mismatch, 409),
   * 'sha-required' (updating without a sha, 422), 'no-branch' (404).
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; isNew: boolean } | { error: 'stale' | 'sha-required' | 'no-branch' };
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    sha?: string,
  ): { commitSha: string; contentSha: string; isNew: boolean } | { error: 'stale' | 'sha-required' | 'no-branch' };
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    sha?: string,
  ): { commitSha: string; contentSha: string; isNew: boolean } | { error: 'stale' | 'sha-required' | 'no-branch' } {
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refTip(branchRef);
    const hasCommits = repo.headOid !== ZERO_OID;
    if (tip === ZERO_OID && hasCommits) return { error: 'no-branch' };
    const baseTree = tip === ZERO_OID ? repo.putObject('tree', buildTree([])) : (this.commitTree(repo, tip) as string);
    const current = tip === ZERO_OID ? null : this.blobAtPath(repo, tip, path);
    if (sha !== undefined && sha !== current) return { error: 'stale' };
    if (sha === undefined && current !== null) return { error: 'sha-required' };
    const blobOid = repo.putObject('blob', content);
    const newTree = this.applyTreeChanges(repo, baseTree, [{ path, oid: blobOid }]);
    const epoch = Math.floor(trialNowMs() / 1000) + this.nextSeq();
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit(
      { tree: newTree, parents: tip === ZERO_OID ? [] : [tip], author, committer: author, message },
      epoch,
    );
    const commitOid = repo.putObject('commit', commitData);
    repo.refs.set(branchRef, commitOid);
    const seq = this.nextSeq();
    repo.pushedAt = stampAt(seq);
    repo.updatedAt = repo.pushedAt;
    return { commitSha: commitOid, contentSha: blobOid, isNew: current === null };
  }

  /** Delete one file on a branch through a commit. Same error keys as commitFile. */
  deleteFile(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    sha?: string,
  ): { commitSha: string } | { error: 'stale' | 'sha-required' | 'no-branch' | 'not-found' } {
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refTip(branchRef);
    if (tip === ZERO_OID) return { error: 'no-branch' };
    const current = this.blobAtPath(repo, tip, path);
    if (current === null) return { error: 'not-found' };
    if (sha !== undefined && sha !== current) return { error: 'stale' };
    const baseTree = this.commitTree(repo, tip) as string;
    const newTree = this.applyTreeChanges(repo, baseTree, [{ path, oid: null }]);
    const epoch = Math.floor(trialNowMs() / 1000) + this.nextSeq();
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit({ tree: newTree, parents: [tip], author, committer: author, message }, epoch);
    const commitOid = repo.putObject('commit', commitData);
    repo.refs.set(branchRef, commitOid);
    const seq = this.nextSeq();
    repo.pushedAt = stampAt(seq);
    repo.updatedAt = repo.pushedAt;
    return { commitSha: commitOid };
  }

  /** Objects reachable from `tips` that the repo does not already hold — for thin packs. */
  missingObjects(repo: Repo, tips: readonly string[]): Set<string> {
    return collectReachable(tips, (oid) => repo.lookup(oid), { allowMissing: true });
  }
}
