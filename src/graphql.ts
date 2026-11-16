// GraphQL v4: POST /api/graphql. A hand-written executor for the fixed document set
// the suite sends (18 documents, no fragments beyond inline `... on T`, no directives).
// Transport: {query, variables} or a JSON array of those (batching); every reply is
// {data, errors} (or an array of those), HTTP 200 unless the request itself is bad.
// Auth: a missing or wrong bearer token is exactly 401. Unknown fields are reported
// in `errors` with HTTP 200 (the suite's invalid-field check requires the field name
// in the message); every other failure of `dataOf` is an error too, so a successful
// document carries an empty/missing `errors` and a non-null `data` object.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, globalId, stampAt, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface GraphQLContext {
  readonly store: Store;
  readonly token: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

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
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeName: string | null; selections: SelectionNode[] };

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; type: string; required: boolean; defaultValue: ValueNode | null }>;
  readonly selections: SelectionNode[];
}

const TOKEN_RE = /\s*(?:#.*\n)?\s*(\.\.\.|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[{}()[\]:!,$=@])/y;

class GraphQLParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let pos = 0;
  while (pos < source.length) {
    TOKEN_RE.lastIndex = pos;
    const match = TOKEN_RE.exec(source);
    if (!match || match.index !== pos) {
      const snippet = source.slice(pos, pos + 20);
      throw new GraphQLParseError(`unexpected character at ${JSON.stringify(snippet)}`);
    }
    pos = TOKEN_RE.lastIndex;
    const token = match[1] as string;
    if (token.startsWith('#')) continue;
    tokens.push(token);
  }
  return tokens;
}

class Parser {
  #tokens: string[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  peek(): string | undefined {
    return this.#tokens[this.#pos];
  }

  next(): string {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new GraphQLParseError('unexpected end of document');
    this.#pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GraphQLParseError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(got)}`);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.#pos < this.#tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.next();
    if (first === 'query' || first === 'mutation') {
      kind = first;
    } else if (first !== '{') {
      throw new GraphQLParseError(`expected an operation, got ${JSON.stringify(first)}`);
    }
    let name: string | null = null;
    if (kind !== 'query' || (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{')) {
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    }
    if (first === '{') {
      // Shorthand query: the '{' was already consumed.
      return { kind, name, variables: [], selections: this.parseSelectionSetAfterOpen() };
    }
    const variables: OperationNode['variables'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        if (this.peek() === ',') {
          this.next();
          continue;
        }
        const varToken = this.next();
        if (!varToken.startsWith('$')) throw new GraphQLParseError(`expected a variable, got ${JSON.stringify(varToken)}`);
        this.expect(':');
        const { type, required } = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varToken.slice(1), type, required, defaultValue });
      }
      this.expect(')');
    }
    this.expect('{');
    return { kind, name, variables, selections: this.parseSelectionSetAfterOpen() };
  }

  parseType(): { type: string; required: boolean } {
    let type = '';
    if (this.peek() === '[') {
      this.next();
      const inner = this.parseType();
      this.expect(']');
      type = `[${inner.type}]`;
    } else {
      type = this.next();
    }
    let required = false;
    if (this.peek() === '!') {
      this.next();
      required = true;
    }
    return { type, required };
  }

  parseSelectionSetAfterOpen(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new GraphQLParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      let typeName: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeName = this.next();
      }
      this.expect('{');
      return { kind: 'inlineFragment', typeName, selections: this.parseSelectionSetAfterOpen() };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        if (this.peek() === ',') {
          this.next();
          continue;
        }
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek() === '{') {
      this.next();
      selections = this.parseSelectionSetAfterOpen();
    }
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.startsWith('$')) return { kind: 'variable', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') {
        if (this.peek() === ',') {
          this.next();
          continue;
        }
        values.push(this.parseValue());
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        if (this.peek() === ',') {
          this.next();
          continue;
        }
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema

/** The fields each object type exposes, for the unknown-field error path. */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  User: ['login'],
  BranchRef: ['name'],
  PageInfo: ['hasNextPage', 'endCursor'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
};

const INTROSPECTION_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER'];

// --------------------------------------------------------------------------- execution

interface ErrorEntry {
  message: string;
  path?: (string | number)[];
}

type Value =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestConnection'; pulls: Array<{ repo: Repo; pull: Pull }> }
  | { __typename: 'PullRequestFileConnection'; files: Array<{ path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'User'; login: string }
  | { __typename: 'BranchRef'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'IssueCommentEdge'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'IssueComment'; id: string; body: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'Node'; id: string; target: Value | null };

class Executor {
  readonly #store: Store;
  readonly #errors: ErrorEntry[] = [];

  constructor(store: Store) {
    this.#store = store;
  }

  get errors(): ErrorEntry[] {
    return this.#errors;
  }

  execute(operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> | null {
    const root: Value = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
    const out: Record<string, unknown> = {};
    this.resolveSelections(root, operation.selections, variables, out, []);
    return out;
  }

  #argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
    const arg = field.args.find((item) => item.name === name);
    if (!arg) return undefined;
    return resolveValue(arg.value, variables);
  }

  #resolveField(parent: Value, field: FieldNode, variables: Record<string, unknown>): { value: unknown; typeName: string | null } | null {
    const parentType = parent.__typename === 'Node' ? (parent.target?.__typename ?? 'Node') : parent.__typename;
    const allowed = TYPE_FIELDS[parentType];
    if (parent.__typename === 'Node') {
      // A node value only answers through its inline fragment's concrete type.
      return { value: null, typeName: null };
    }
    if (field.name === '__typename') return { value: parentType, typeName: null };
    if (allowed && !allowed.includes(field.name)) {
      this.#errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      return { value: null, typeName: null };
    }
    return this.#resolveKnownField(parent, field, variables, parentType);
  }

  #resolveKnownField(parent: Value, field: FieldNode, variables: Record<string, unknown>, parentType: string): { value: unknown; typeName: string | null } | null {
    switch (parent.__typename) {
      case 'Query': {
        if (field.name === 'viewer') return { value: { __typename: 'User', login: VIEWER.login } as Value, typeName: 'User' };
        if (field.name === 'repository') {
          const owner = this.#argValue(field, 'owner', variables) as string;
          const name = this.#argValue(field, 'name', variables) as string;
          if (owner !== VIEWER.login) return { value: null, typeName: 'Repository' };
          const repo = this.#store.getRepo(owner, name);
          return { value: repo ? ({ __typename: 'Repository', repo } as Value) : null, typeName: 'Repository' };
        }
        if (field.name === 'node') {
          const id = this.#argValue(field, 'id', variables) as string;
          const target = this.#nodeTarget(id);
          return { value: { __typename: 'Node', id, target } as Value, typeName: 'Node' };
        }
        if (field.name === '__type') {
          const name = this.#argValue(field, 'name', variables) as string;
          if (!INTROSPECTION_FIELDS[name] && name !== 'SearchType') return { value: null, typeName: '__Type' };
          return { value: { __typename: '__Type', name } as Value, typeName: '__Type' };
        }
        break;
      }
      case 'Mutation': {
        return this.#resolveMutation(field, variables);
      }
      case 'Repository': {
        const repo = parent.repo;
        switch (field.name) {
          case 'id':
            return { value: repo.globalId, typeName: null };
          case 'databaseId':
            return { value: repo.id, typeName: null };
          case 'name':
            return { value: repo.name, typeName: null };
          case 'nameWithOwner':
            return { value: repo.fullName, typeName: null };
          case 'owner':
            return { value: { __typename: 'User', login: repo.owner } as Value, typeName: 'User' };
          case 'defaultBranchRef':
            return { value: { __typename: 'BranchRef', name: repo.defaultBranch } as Value, typeName: 'BranchRef' };
          case 'viewerPermission':
            return { value: 'ADMIN', typeName: null };
          case 'hasIssuesEnabled':
            return { value: true, typeName: null };
          case 'issue': {
            const number = this.#argValue(field, 'number', variables) as number;
            const issue = this.#store.getIssue(repo, number);
            return { value: issue ? ({ __typename: 'Issue', repo, issue } as Value) : null, typeName: 'Issue' };
          }
          case 'issues':
            return { value: this.#issuesConnection(repo, field, variables), typeName: 'IssueConnection' };
          case 'pullRequests': {
            const first = this.#argValue(field, 'first', variables) as number | undefined;
            const pulls = [...repo.pulls].sort((a, b) => b.seq - a.seq);
            const sliced = first === undefined ? pulls : pulls.slice(0, first);
            return {
              value: { __typename: 'PullRequestConnection', pulls: sliced.map((pull) => ({ repo, pull })) } as Value,
              typeName: 'PullRequestConnection',
            };
          }
          case 'pullRequest': {
            const number = this.#argValue(field, 'number', variables) as number;
            const pull = this.#store.getPull(repo, number);
            return { value: pull ? ({ __typename: 'PullRequest', repo, pull } as Value) : null, typeName: 'PullRequest' };
          }
        }
        break;
      }
      case 'Issue': {
        const issue = parent.issue;
        switch (field.name) {
          case 'id':
            return { value: issue.globalId, typeName: null };
          case 'number':
            return { value: issue.number, typeName: null };
          case 'title':
            return { value: issue.title, typeName: null };
          case 'state':
            return { value: issue.state.toUpperCase(), typeName: null };
          case 'body':
            return { value: issue.body, typeName: null };
        }
        break;
      }
      case 'IssueConnection': {
        if (field.name === 'nodes') {
          return {
            value: parent.issues.map((issue) => ({ __typename: 'Issue', repo: parent.repo, issue }) as Value),
            typeName: 'Issue',
          };
        }
        if (field.name === 'pageInfo') {
          return {
            value: { __typename: 'PageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor } as Value,
            typeName: 'PageInfo',
          };
        }
        break;
      }
      case 'PullRequest': {
        const pull = parent.pull;
        switch (field.name) {
          case 'id':
            return { value: pull.globalId, typeName: null };
          case 'number':
            return { value: pull.number, typeName: null };
          case 'state':
            return { value: pull.merged ? 'MERGED' : pull.state.toUpperCase(), typeName: null };
          case 'merged':
            return { value: pull.merged, typeName: null };
          case 'headRefName':
            return { value: pull.headRef, typeName: null };
          case 'baseRefName':
            return { value: pull.baseRef, typeName: null };
          case 'mergeable':
            return { value: pull.mergeable, typeName: null };
          case 'files': {
            const first = this.#argValue(field, 'first', variables) as number | undefined;
            const files = first === undefined ? pull.files : pull.files.slice(0, first);
            return {
              value: { __typename: 'PullRequestFileConnection', files: files.map((file) => ({ path: file.path })) } as Value,
              typeName: 'PullRequestFileConnection',
            };
          }
        }
        break;
      }
      case 'PullRequestConnection': {
        if (field.name === 'nodes') {
          return { value: parent.pulls.map((entry) => ({ __typename: 'PullRequest', repo: entry.repo, pull: entry.pull }) as Value), typeName: 'PullRequest' };
        }
        break;
      }
      case 'PullRequestFileConnection': {
        if (field.name === 'nodes') {
          return { value: parent.files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path }) as Value), typeName: 'PullRequestChangedFile' };
        }
        break;
      }
      case 'PullRequestChangedFile': {
        if (field.name === 'path') return { value: parent.path, typeName: null };
        break;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field.name === 'issue') {
          return { value: { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as Value, typeName: 'Issue' };
        }
        break;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field.name === 'pullRequest') {
          return { value: { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull } as Value, typeName: 'PullRequest' };
        }
        break;
      }
      case 'AddCommentPayload': {
        if (field.name === 'commentEdge') {
          return {
            value: { __typename: 'IssueCommentEdge', repo: parent.repo, issue: parent.issue, commentId: parent.commentId, body: parent.body } as Value,
            typeName: 'IssueCommentEdge',
          };
        }
        break;
      }
      case 'User': {
        if (field.name === 'login') return { value: parent.login, typeName: null };
        break;
      }
      case 'BranchRef': {
        if (field.name === 'name') return { value: parent.name, typeName: null };
        break;
      }
      case 'PageInfo': {
        if (field.name === 'hasNextPage') return { value: parent.hasNextPage, typeName: null };
        if (field.name === 'endCursor') return { value: parent.endCursor, typeName: null };
        break;
      }
      case '__Type': {
        if (field.name === 'name') return { value: parent.name, typeName: null };
        if (field.name === 'fields') {
          const names = INTROSPECTION_FIELDS[parent.name];
          if (!names) return { value: null, typeName: '__Field' };
          return { value: names.map((name) => ({ __typename: '__Field', name }) as Value), typeName: '__Field' };
        }
        if (field.name === 'enumValues') {
          if (parent.name !== 'SearchType') return { value: null, typeName: '__EnumValue' };
          return { value: SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name }) as Value), typeName: '__EnumValue' };
        }
        break;
      }
      case '__Field':
      case '__EnumValue': {
        if (field.name === 'name') return { value: parent.name, typeName: null };
        break;
      }
      case 'IssueCommentEdge': {
        if (field.name === 'node') {
          return {
            value: { __typename: 'IssueComment', id: globalId('comment', [parent.repo.id, parent.issue.number, parent.commentId]), body: parent.body } as Value,
            typeName: 'IssueComment',
          };
        }
        break;
      }
      case 'IssueComment': {
        if (field.name === 'id') return { value: parent.id, typeName: null };
        if (field.name === 'body') return { value: parent.body, typeName: null };
        break;
      }
    }
    return { value: null, typeName: null };
  }

  #issuesConnection(repo: Repo, field: FieldNode, variables: Record<string, unknown>): Value {
    const first = this.#argValue(field, 'first', variables) as number | undefined;
    const states = this.#argValue(field, 'states', variables) as string[] | undefined;
    const orderBy = this.#argValue(field, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
    const after = this.#argValue(field, 'after', variables) as string | null | undefined;
    let issues = [...repo.issues];
    if (states && states.length) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const direction = orderBy?.direction ?? 'DESC';
    // CREATED_AT order is the issue-number order (numbers rise with creation); the
    // suite infers order from numbers, so sort by seq, never by a timestamp string.
    issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    if (after) {
      const afterNumber = decodeCursor(after);
      if (afterNumber !== null) {
        const index = issues.findIndex((issue) => issue.number === afterNumber);
        if (index >= 0) issues = issues.slice(index + 1);
      }
    }
    const total = issues.length;
    const page = first === undefined ? issues : issues.slice(0, first);
    const hasNextPage = page.length < total;
    const endCursor = page.length ? encodeCursor(page[page.length - 1]?.number as number) : null;
    return { __typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
  }

  #nodeTarget(id: string): Value | null {
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    if (decoded.tag === 'repo') {
      for (const repo of this.#store.repos.values()) {
        if (repo.id === decoded.parts[0]) return { __typename: 'Repository', repo };
      }
    }
    if (decoded.tag === 'issue') {
      for (const repo of this.#store.repos.values()) {
        if (repo.id !== decoded.parts[0]) continue;
        const issue = this.#store.getIssue(repo, decoded.parts[1] as number);
        if (issue) return { __typename: 'Issue', repo, issue };
      }
    }
    if (decoded.tag === 'pull') {
      for (const repo of this.#store.repos.values()) {
        if (repo.id !== decoded.parts[0]) continue;
        const pull = this.#store.getPull(repo, decoded.parts[1] as number);
        if (pull) return { __typename: 'PullRequest', repo, pull };
      }
    }
    return null;
  }

  #resolveMutation(field: FieldNode, variables: Record<string, unknown>): { value: unknown; typeName: string | null } | null {
    const input = this.#argValue(field, 'input', variables) as Record<string, unknown> | undefined;
    if (!input) {
      this.#errors.push({ message: `Mutation "${field.name}" needs an input object.` });
      return { value: null, typeName: null };
    }
    if (field.name === 'createIssue') {
      const repo = this.#repoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) {
        this.#errors.push({ message: 'createIssue: repository not found.' });
        return { value: null, typeName: null };
      }
      const issue = this.#store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return {
        value: { __typename: 'CreateIssuePayload', repo, issue } as Value,
        typeName: 'CreateIssuePayload',
      };
    }
    if (field.name === 'closeIssue') {
      const found = this.#issueByGlobalId(String(input.issueId ?? ''));
      if (!found) {
        this.#errors.push({ message: 'closeIssue: issue not found.' });
        return { value: null, typeName: null };
      }
      found.issue.state = 'closed';
      found.issue.closedAt = stampAt(this.#store.nextSeq());
      found.issue.updatedAt = found.issue.closedAt;
      return { value: { __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as Value, typeName: 'CloseIssuePayload' };
    }
    if (field.name === 'createPullRequest') {
      const repo = this.#repoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) {
        this.#errors.push({ message: 'createPullRequest: repository not found.' });
        return { value: null, typeName: null };
      }
      const pull = this.#store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? ''),
      });
      if (!pull) {
        this.#errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
        return { value: null, typeName: null };
      }
      return { value: { __typename: 'CreatePullRequestPayload', repo, pull } as Value, typeName: 'CreatePullRequestPayload' };
    }
    if (field.name === 'mergePullRequest') {
      const found = this.#pullByGlobalId(String(input.pullRequestId ?? ''));
      if (!found) {
        this.#errors.push({ message: 'mergePullRequest: pull request not found.' });
        return { value: null, typeName: null };
      }
      const { repo, pull } = found;
      if (pull.state === 'open' && !pull.merged) {
        pull.baseSha = repo.refTip(`refs/heads/${pull.baseRef}`);
        pull.mergeable = this.#store.computeMergeable(repo, pull);
        if (pull.mergeable !== 'CONFLICTING') {
          const methodRaw = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
          const method = methodRaw === 'MERGE' || methodRaw === 'REBASE' ? methodRaw : 'SQUASH';
          this.#store.mergePull(repo, pull, method);
        }
      }
      return { value: { __typename: 'MergePullRequestPayload', repo, pull } as Value, typeName: 'MergePullRequestPayload' };
    }
    if (field.name === 'addComment') {
      const found = this.#issueByGlobalId(String(input.subjectId ?? ''));
      if (!found) {
        this.#errors.push({ message: 'addComment: subject not found.' });
        return { value: null, typeName: null };
      }
      const comment = this.#store.addComment(found.repo, found.issue, String(input.body ?? ''));
      return {
        value: { __typename: 'AddCommentPayload', repo: found.repo, issue: found.issue, commentId: comment.id, body: comment.body } as Value,
        typeName: 'AddCommentPayload',
      };
    }
    this.#errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    return { value: null, typeName: null };
  }

  #repoByGlobalId(id: string): Repo | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.tag !== 'repo') return null;
    for (const repo of this.#store.repos.values()) if (repo.id === decoded.parts[0]) return repo;
    return null;
  }

  #issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.tag !== 'issue') return null;
    for (const repo of this.#store.repos.values()) {
      if (repo.id !== decoded.parts[0]) continue;
      const issue = this.#store.getIssue(repo, decoded.parts[1] as number);
      if (issue) return { repo, issue };
    }
    return null;
  }

  #pullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.tag !== 'pull') return null;
    for (const repo of this.#store.repos.values()) {
      if (repo.id !== decoded.parts[0]) continue;
      const pull = this.#store.getPull(repo, decoded.parts[1] as number);
      if (pull) return { repo, pull };
    }
    return null;
  }

  resolveSelections(parent: Value, selections: SelectionNode[], variables: Record<string, unknown>, out: Record<string, unknown>, path: (string | number)[]): void {
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        const target = parent.__typename === 'Node' ? parent.target : parent;
        if (!target) continue;
        if (selection.typeName && selection.typeName !== target.__typename) continue;
        this.resolveSelections(target, selection.selections, variables, out, path);
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (parent.__typename === 'Node') {
        // A node answers `id` directly; everything else needs an inline fragment.
        if (field.name === 'id') out[key] = parent.id;
        else if (field.name === '__typename') out[key] = parent.target?.__typename ?? null;
        continue;
      }
      const resolved = this.#resolveField(parent, field, variables);
      if (!resolved) continue;
      out[key] = this.#materialize(resolved.value, resolved.typeName, field, variables, [...path, key]);
    }
  }

  #materialize(value: unknown, _typeName: string | null, field: FieldNode, variables: Record<string, unknown>, path: (string | number)[]): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.#materialize(item, null, field, variables, [...path, index]),
      );
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const object = value as Value;
      if (field.selections.length === 0) return {};
      const out: Record<string, unknown> = {};
      this.resolveSelections(object, field.selections, variables, out, path);
      return out;
    }
    return value;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function decodeGlobalId(id: string): { tag: string; parts: (number | string)[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [tag, ...rest] = text.split(':');
    if (!tag) return null;
    return { tag, parts: rest.map((part) => (/^\d+$/.test(part) ? Number(part) : part)) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- handler

interface OperationRequest {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

function runOperation(ctx: GraphQLContext, request: OperationRequest): Record<string, unknown> {
  if (typeof request.query !== 'string' || request.query.trim() === '') {
    return { data: null, errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  const variables =
    request.variables && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? (request.variables as Record<string, unknown>)
      : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(request.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  }
  const operation = operations[0] as OperationNode;
  if (request.operationName !== undefined && request.operationName !== null && operation.name !== request.operationName) {
    return { data: null, errors: [{ message: `Unknown operation named "${String(request.operationName)}".` }] };
  }
  const executor = new Executor(ctx.store);
  const data = executor.execute(operation, variables);
  const errors = executor.errors;
  if (errors.length) return { data, errors };
  return { data };
}

/**
 * Route one GraphQL request. Returns true when handled, false when the path is
 * not /api/graphql.
 */
export async function handleGraphQL(ctx: GraphQLContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { data: null, errors: [{ message: 'GraphQL needs POST.' }] });
    return true;
  }
  if (!bearerOk(req, ctx.token)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    sendJson(res, 400, { data: null, errors: [{ message: 'Request body is not valid JSON.' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOperation(ctx, entry as OperationRequest)));
    return true;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    sendJson(res, 200, runOperation(ctx, parsed as OperationRequest));
    return true;
  }
  sendJson(res, 400, { data: null, errors: [{ message: 'Request body must be a JSON object or array.' }] });
  return true;
}
