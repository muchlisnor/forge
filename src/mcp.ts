// MCP (Model Context Protocol) streamable-HTTP endpoint: POST /mcp. Speaks both eras
// the suite accepts: modern 2026-07-28 (`server/discover`, no handshake, no session)
// and legacy 2025-11-25 and earlier (`initialize` + `notifications/initialized`).
// Answers are plain JSON-RPC bodies (the client also reads SSE, but never needs it).
// Auth: every POST needs the bearer token; a tools/call without one is exactly 401.
// A body that is not JSON is HTTP 400 with JSON-RPC -32700. An unknown tool or a
// tools/call missing required arguments is JSON-RPC -32602; an unknown method -32601.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Repo, type Store } from './store.ts';

export interface McpContext {
  readonly store: Store;
  readonly token: string;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: readonly string[];
  };
}

/**
 * The six tools, frozen: tools/list must answer the same array byte for byte on
 * every call, so this literal is the single source and is never rebuilt.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    }),
  }),
]);

function bearerOk(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (token === '') return true;
  return presented === token;
}

function readBody(req: IncomingMessage, limitBytes = 16 * 1024 * 1024): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, error: RpcError): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error });
}

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 0, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string; user: string; labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null; comments: unknown[]; globalId: string }): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: { number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string; user: string; createdAt: string; updatedAt: string; globalId: string }): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    throw { code: -32602, message: `Unknown tool: ${name}` };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw { code: -32602, message: `Missing required argument: ${required}` };
    }
  }
  const loadRepo = (owner: string, repoName: string): Repo | null => {
    if (owner !== VIEWER.login) return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  if (name === 'create_repo') {
    const repoName = str(args.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('Invalid repository name');
    const created = store.createRepo(VIEWER.login, repoName, {
      description: str(args.description),
      private: typeof args.private === 'boolean' ? args.private : true,
    });
    if (!created) return toolError('Repository already exists');
    return toolResult(repoJson(created));
  }
  if (name === 'get_repo') {
    const repo = loadRepo(str(args.owner), str(args.repo));
    if (!repo) return toolError('Repository not found');
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const repo = loadRepo(str(args.owner), str(args.repo));
    if (!repo) return toolError('Repository not found');
    const issue = store.createIssue(repo, { title: str(args.title), body: str(args.body) });
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const repo = loadRepo(str(args.owner), str(args.repo));
    if (!repo) return toolError('Repository not found');
    const state = str(args.state) || 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
  }
  if (name === 'create_pull_request') {
    const repo = loadRepo(str(args.owner), str(args.repo));
    if (!repo) return toolError('Repository not found');
    const head = str(args.head);
    const base = str(args.base);
    if (repo.refTip(`refs/heads/${head}`) === '0000000000000000000000000000000000000000' || repo.refTip(`refs/heads/${base}`) === '0000000000000000000000000000000000000000') {
      return toolError('Head or base branch does not exist');
    }
    const pull = store.createPull(repo, { title: str(args.title), body: str(args.body), headRef: head, baseRef: base });
    if (!pull) return toolError('Could not create the pull request');
    return toolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const repo = loadRepo(str(args.owner), str(args.repo));
    if (!repo) return toolError('Repository not found');
    const pullNumber = num(args.pull_number);
    if (pullNumber === null) return toolError('pull_number must be an integer');
    const pull = store.getPull(repo, pullNumber);
    if (!pull) return toolError('Pull request not found');
    if (pull.state !== 'open' || pull.merged) return toolError('Pull request is already merged or closed');
    pull.baseSha = repo.refTip(`refs/heads/${pull.baseRef}`);
    pull.mergeable = store.computeMergeable(repo, pull);
    if (pull.mergeable === 'CONFLICTING') return toolError('Merge conflict');
    const sha = store.mergePull(repo, pull, 'SQUASH');
    if (!sha) return toolError('Merge conflict');
    return toolResult({ sha, merged: true, message: `Pull request #${pull.number} merged` });
  }
  throw { code: -32602, message: `Unknown tool: ${name}` };
}

/**
 * Route one MCP request. Returns true when handled, false when the path is not /mcp.
 */
export async function handleMcp(ctx: McpContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/mcp') return false;
  if ((req.method ?? 'GET') === 'DELETE') {
    // A legacy session close: nothing is held, so any DELETE is a no-op 204.
    res.writeHead(204);
    res.end();
    return true;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    rpcError(res, 400, null, { code: -32700, message: 'Parse error' });
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rpcError(res, 400, null, { code: -32600, message: 'Invalid Request' });
    return true;
  }
  const body = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (typeof body.params === 'object' && body.params !== null ? body.params : {}) as Record<string, unknown>;

  // A notification (no id) is acknowledged with 202 and no body.
  if (body.id === undefined) {
    if (method.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return true;
    }
    res.writeHead(202);
    res.end();
    return true;
  }

  if (!bearerOk(req, ctx.token)) {
    rpcError(res, 401, id, { code: -32001, message: 'Requires authentication' });
    return true;
  }

  if (method === 'server/discover') {
    rpcResult(res, id, {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A one-process GitHub-compatible forge: git smart HTTP, REST v3, GraphQL and MCP over one in-memory store.',
    });
    return true;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'ping') {
    rpcResult(res, id, {});
    return true;
  }
  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    try {
      const result = callTool(ctx, toolName, args);
      rpcResult(res, id, result);
    } catch (err) {
      const error = err as { code?: number; message?: string };
      rpcError(res, 200, id, { code: error.code ?? -32602, message: error.message ?? 'Invalid params' });
    }
    return true;
  }
  rpcError(res, 200, id, { code: -32601, message: `Method not found: ${method}` });
  return true;
}
