/**
 * A2A Host Server for NanoClaw
 *
 * Implements the A2A (Agent-to-Agent) protocol so container agents can
 * discover and call the host NanoClaw process. This is the bridge between
 * agents running inside containers and the host orchestrator.
 *
 * Protocol: JSON-RPC 2.0 over HTTP, per the A2A spec (v0.3).
 *
 * Endpoints:
 *   GET  /.well-known/agent-card.json  → Host Agent Card
 *   POST /task                         → JSON-RPC task submission
 *   GET  /task/{id}                    → Task status query
 *   GET  /agents                       → List all known agent cards
 *   GET  /agents/{name}               → Get specific agent card
 *   GET  /health                       → Health check
 *
 * Port: 4002 (NanoClaw A2A task endpoint)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

// JSON-RPC error codes
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_TASK_NOT_FOUND = -32001;
const JSONRPC_SKILL_NOT_FOUND = -32002;

interface A2ATask {
  id: string;
  skill: string;
  input: Record<string, unknown>;
  status: 'submitted' | 'working' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  artifacts?: unknown[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface AgentCardData {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: Record<string, boolean>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputModes: string[];
    outputModes: string[];
    input?: Record<string, string>;
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  authentication: Record<string, unknown>;
}

export interface A2AHostServerOptions {
  port?: number;
  /**
   * Callback invoked when an `execute-task` skill request arrives.
   * Receives the prompt string and the task ID; should return a result
   * string when the work completes.  If not provided, execute-task
   * requests are rejected immediately with a clear error.
   */
  onExecuteTask?: (prompt: string, taskId: string) => Promise<string>;
}

function nowISO(): string {
  return new Date().toISOString();
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class A2AHostServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  private tasks: Map<string, A2ATask> = new Map();
  private agentCards: Map<string, AgentCardData> = new Map();
  private hostCard: AgentCardData;
  private hostCardJson: string;
  private onExecuteTask?: (prompt: string, taskId: string) => Promise<string>;

  constructor(hostCard: AgentCardData, options: A2AHostServerOptions = {});
  /** @deprecated Pass a hostCard object as first arg. */
  constructor(port?: number);
  constructor(
    hostCardOrPort: AgentCardData | number | undefined,
    options: A2AHostServerOptions = {},
  ) {
    // Support old single-number-arg call signature used before this change:
    //   new A2AHostServer(4002)
    if (typeof hostCardOrPort === 'number' || hostCardOrPort === undefined) {
      this.port = hostCardOrPort ?? 4002;
      this.onExecuteTask = undefined;

      // Load host card from the agent-cards directory
      const cardPath = '/home/nanoclaw/reports/a2a/agent-cards/claude-code-host.json';
      if (fs.existsSync(cardPath)) {
        this.hostCard = JSON.parse(fs.readFileSync(cardPath, 'utf-8'));
      } else {
        this.hostCard = this.defaultHostCard(this.port);
      }
    } else {
      // New call signature: new A2AHostServer(hostCard, options)
      this.hostCard = hostCardOrPort;
      this.port = options.port ?? 4002;
      this.onExecuteTask = options.onExecuteTask;
    }

    this.hostCardJson = JSON.stringify(this.hostCard, null, 2);

    // Load all known agent cards from disk
    this.loadAgentCards();
  }

  private defaultHostCard(port: number): AgentCardData {
    return {
      name: 'claude-code-host',
      description:
        'Host Claude Code on Miniforum. Orchestrator for vine agent swarm.',
      url: `http://127.0.0.1:${port}`,
      version: '0.3',
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      skills: [
        {
          id: 'execute-task',
          name: 'Execute Task',
          description: 'Execute an arbitrary task using Claude Code.',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
        {
          id: 'query-codebase',
          name: 'Query Codebase',
          description: 'Search and analyze code.',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
        {
          id: 'run-command',
          name: 'Run Command',
          description: 'Execute a shell command.',
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
      ],
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      authentication: { schemes: ['bearer'], credentials: 'vine-internal' },
    };
  }

  /**
   * Wire in the execute-task callback after construction.
   * Useful when the callback depends on state that isn't available
   * until after the server object is created (e.g. circular deps).
   */
  setExecuteTaskCallback(
    cb: (prompt: string, taskId: string) => Promise<string>,
  ): void {
    this.onExecuteTask = cb;
  }

  /**
   * Load agent cards from /home/nanoclaw/reports/a2a/agent-cards/
   */
  private loadAgentCards(): void {
    const cardsDir = '/home/nanoclaw/reports/a2a/agent-cards';
    if (!fs.existsSync(cardsDir)) return;

    try {
      for (const file of fs.readdirSync(cardsDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data: AgentCardData = JSON.parse(
            fs.readFileSync(path.join(cardsDir, file), 'utf-8'),
          );
          this.agentCards.set(data.name, data);
        } catch (err) {
          logger.warn(
            { file, err },
            'Failed to load agent card',
          );
        }
      }
      logger.info(
        { count: this.agentCards.size },
        'A2A agent cards loaded',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to read agent cards directory');
    }
  }

  start(): void {
    if (this.server) {
      logger.warn('A2A server already running');
      return;
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'A2A request handler error');
        this.sendJson(res, { error: 'Internal server error' }, 500);
      });
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      logger.info(
        { port: this.port },
        'A2A host server started',
      );
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(
          { port: this.port },
          'A2A port in use, server not started (another instance may be running)',
        );
        this.server = null;
      } else {
        logger.error({ err }, 'A2A server error');
      }
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('A2A host server stopped');
    }
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const urlPath = (req.url || '/').replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // --- GET endpoints ---

    if (method === 'GET') {
      // Agent Card discovery
      if (urlPath === '/.well-known/agent-card.json') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(this.hostCardJson);
        return;
      }

      // Health check
      if (urlPath === '/health') {
        this.sendJson(res, {
          status: 'ok',
          agent: this.hostCard.name,
          tasks_tracked: this.tasks.size,
          agents_known: this.agentCards.size,
          timestamp: nowISO(),
        });
        return;
      }

      // List all known agents
      if (urlPath === '/agents') {
        const agents: AgentCardData[] = [];
        for (const card of this.agentCards.values()) {
          agents.push(card);
        }
        this.sendJson(res, { agents, count: agents.length });
        return;
      }

      // Get specific agent card: /agents/{name}
      const agentMatch = urlPath.match(/^\/agents\/([a-zA-Z0-9_-]+)$/);
      if (agentMatch) {
        const name = agentMatch[1];
        const card = this.agentCards.get(name);
        if (card) {
          this.sendJson(res, card);
        } else {
          this.sendJson(res, { error: `Agent '${name}' not found` }, 404);
        }
        return;
      }

      // Task status: GET /task/{id}
      const taskMatch = urlPath.match(/^\/task\/([a-zA-Z0-9_-]+)$/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        const task = this.tasks.get(taskId);
        if (task) {
          this.sendJson(res, task);
        } else {
          this.sendJson(res, { error: 'Task not found', task_id: taskId }, 404);
        }
        return;
      }

      this.sendJson(res, { error: 'Not found' }, 404);
      return;
    }

    // --- POST endpoints ---

    if (method === 'POST' && urlPath === '/task') {
      const body = await this.readBody(req);
      if (!body) {
        this.sendJsonRpcError(res, JSONRPC_PARSE_ERROR, 'Empty request body');
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.sendJsonRpcError(res, JSONRPC_PARSE_ERROR, 'Invalid JSON');
        return;
      }

      if (parsed.jsonrpc !== '2.0') {
        this.sendJsonRpcError(
          res,
          JSONRPC_INVALID_REQUEST,
          "Missing or invalid 'jsonrpc' field (must be '2.0')",
          parsed.id,
        );
        return;
      }

      const rpcMethod = parsed.method as string;
      const params = (parsed.params || {}) as Record<string, unknown>;
      const reqId = parsed.id;

      switch (rpcMethod) {
        case 'tasks/send':
          this.handleTaskSend(res, reqId, params);
          break;
        case 'tasks/get':
          this.handleTaskGet(res, reqId, params);
          break;
        case 'tasks/cancel':
          this.handleTaskCancel(res, reqId, params);
          break;
        default:
          this.sendJsonRpcError(
            res,
            JSONRPC_METHOD_NOT_FOUND,
            `Unknown method: ${rpcMethod}`,
            reqId,
          );
      }
      return;
    }

    this.sendJson(res, { error: 'Not found' }, 404);
  }

  private handleTaskSend(
    res: ServerResponse,
    reqId: unknown,
    params: Record<string, unknown>,
  ): void {
    const skill = (params.skill as string) || '';
    const taskInput = (params.input as Record<string, unknown>) || {};
    const taskId = (params.id as string) || generateId();
    const metadata = params.metadata as Record<string, unknown> | undefined;

    // Validate skill
    const skillIds = this.hostCard.skills.map((s) => s.id);
    if (skillIds.length > 0 && !skillIds.includes(skill)) {
      this.sendJsonRpcError(
        res,
        JSONRPC_SKILL_NOT_FOUND,
        `Skill '${skill}' not found. Available: ${skillIds.join(', ')}`,
        reqId,
      );
      return;
    }

    const task: A2ATask = {
      id: taskId,
      skill,
      input: taskInput,
      status: 'submitted',
      created_at: nowISO(),
      updated_at: nowISO(),
      metadata,
    };

    // Execute the task based on skill (may mutate task synchronously or kick
    // off async work that updates the task later via this.tasks.set)
    try {
      this.executeTask(task);
    } catch (err) {
      task.status = 'failed';
      task.result = {
        error: err instanceof Error ? err.message : String(err),
      };
      task.updated_at = nowISO();
    }

    this.tasks.set(task.id, task);

    this.sendJson(res, {
      jsonrpc: '2.0',
      id: reqId,
      result: task,
    });
  }

  private handleTaskGet(
    res: ServerResponse,
    reqId: unknown,
    params: Record<string, unknown>,
  ): void {
    const taskId = (params.id as string) || '';
    const task = this.tasks.get(taskId);

    if (task) {
      this.sendJson(res, {
        jsonrpc: '2.0',
        id: reqId,
        result: task,
      });
    } else {
      this.sendJsonRpcError(
        res,
        JSONRPC_TASK_NOT_FOUND,
        `Task '${taskId}' not found`,
        reqId,
        404,
      );
    }
  }

  private handleTaskCancel(
    res: ServerResponse,
    reqId: unknown,
    params: Record<string, unknown>,
  ): void {
    const taskId = (params.id as string) || '';
    const task = this.tasks.get(taskId);

    if (!task) {
      this.sendJsonRpcError(
        res,
        JSONRPC_TASK_NOT_FOUND,
        `Task '${taskId}' not found`,
        reqId,
        404,
      );
      return;
    }

    if (task.status === 'completed' || task.status === 'failed') {
      this.sendJsonRpcError(
        res,
        JSONRPC_INVALID_REQUEST,
        `Task '${taskId}' already in terminal state: ${task.status}`,
        reqId,
      );
      return;
    }

    task.status = 'failed';
    task.result = { error: 'Cancelled by caller' };
    task.updated_at = nowISO();
    this.tasks.set(task.id, task);

    this.sendJson(res, {
      jsonrpc: '2.0',
      id: reqId,
      result: task,
    });
  }

  /**
   * Execute a task based on its skill type.
   * Synchronous skills mutate the task in place.
   * Async skills (execute-task) set status to 'working' immediately and
   * update the task map when the promise resolves.
   */
  private executeTask(task: A2ATask): void {
    switch (task.skill) {
      case 'run-command':
        this.executeRunCommand(task);
        break;
      case 'query-codebase':
        this.executeQueryCodebase(task);
        break;
      case 'execute-task': {
        const prompt =
          (task.input.prompt as string) ||
          (task.input.text as string) ||
          '';
        if (!prompt) {
          task.status = 'failed';
          task.result = { error: 'Missing prompt in input' };
          return;
        }
        if (!this.onExecuteTask) {
          task.status = 'failed';
          task.result = {
            error:
              'execute-task not wired — onExecuteTask callback not set',
          };
          logger.warn(
            { taskId: task.id },
            'execute-task called but no callback registered (CLAW-003)',
          );
          return;
        }
        task.status = 'working';
        task.updated_at = nowISO();
        logger.info(
          { taskId: task.id, promptPreview: prompt.slice(0, 100) },
          'execute-task dispatching to container runner',
        );
        // Fire-and-forget: caller polls GET /task/{id} for status
        this.onExecuteTask(prompt, task.id)
          .then((result) => {
            task.status = 'completed';
            task.result = { output: result };
            task.updated_at = nowISO();
            this.tasks.set(task.id, task);
            logger.info({ taskId: task.id }, 'execute-task completed');
          })
          .catch((err) => {
            task.status = 'failed';
            task.result = {
              error: err instanceof Error ? err.message : String(err),
            };
            task.updated_at = nowISO();
            this.tasks.set(task.id, task);
            logger.error(
              { taskId: task.id, err },
              'execute-task failed',
            );
          });
        break;
      }
      default:
        task.status = 'failed';
        task.result = { error: `Unknown skill: ${task.skill}` };
    }
  }

  /**
   * Execute a shell command synchronously and return the output.
   * Commands run with a 30-second timeout and limited output.
   */
  private executeRunCommand(task: A2ATask): void {
    const command = task.input.command as string;
    if (!command) {
      task.status = 'failed';
      task.result = { error: 'Missing "command" in input' };
      return;
    }

    // Security: reject dangerous commands
    const blocked = [
      /rm\s+-rf?\s+\//,
      /mkfs/,
      /dd\s+if=/,
      />\s*\/dev\/sd/,
      /chmod\s+-R\s+777\s+\//,
    ];
    for (const pattern of blocked) {
      if (pattern.test(command)) {
        task.status = 'failed';
        task.result = { error: 'Command blocked by security policy' };
        logger.warn({ command }, 'A2A blocked dangerous command');
        return;
      }
    }

    task.status = 'working';
    task.updated_at = nowISO();

    try {
      const output = execSync(command, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: 'utf-8',
        cwd: '/root',
      });

      task.status = 'completed';
      task.result = {
        stdout: output.slice(0, 10_000), // Cap output at 10KB
        exit_code: 0,
      };
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      task.status = 'completed'; // completed even on non-zero exit — the result has the error
      task.result = {
        stdout: (execErr.stdout || '').slice(0, 10_000),
        stderr: (execErr.stderr || '').slice(0, 10_000),
        exit_code: execErr.status ?? 1,
        error: execErr.message || 'Command failed',
      };
    }
    task.updated_at = nowISO();
  }

  /**
   * Query the codebase using grep/find.
   */
  private executeQueryCodebase(task: A2ATask): void {
    const query = task.input.query as string;
    const paths = (task.input.paths as string[]) || ['/home/nanoclaw/nanoclaw'];

    if (!query) {
      task.status = 'failed';
      task.result = { error: 'Missing "query" in input' };
      return;
    }

    task.status = 'working';
    task.updated_at = nowISO();

    try {
      // Use grep to search across the specified paths
      const searchPaths = paths.join(' ');
      const escapedQuery = query.replace(/'/g, "'\\''");
      const output = execSync(
        `grep -rn --include='*.ts' --include='*.py' --include='*.json' --include='*.md' '${escapedQuery}' ${searchPaths} 2>/dev/null | head -50`,
        {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
          cwd: '/root',
        },
      );

      task.status = 'completed';
      task.result = {
        matches: output.trim().split('\n').filter(Boolean),
        query,
        paths,
      };
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; message?: string };
      // grep returns exit 1 for no matches — that's not an error
      if (execErr.status === 1) {
        task.status = 'completed';
        task.result = { matches: [], query, paths };
      } else {
        task.status = 'failed';
        task.result = { error: execErr.message || 'Query failed' };
      }
    }
    task.updated_at = nowISO();
  }

  // --- HTTP helpers ---

  private sendJson(
    res: ServerResponse,
    data: unknown,
    status = 200,
  ): void {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  }

  private sendJsonRpcError(
    res: ServerResponse,
    code: number,
    message: string,
    reqId?: unknown,
    status = 400,
  ): void {
    this.sendJson(
      res,
      {
        jsonrpc: '2.0',
        id: reqId ?? null,
        error: { code, message },
      },
      status,
    );
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxSize = 1024 * 1024; // 1MB max

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(null);
        } else {
          resolve(Buffer.concat(chunks).toString('utf-8'));
        }
      });

      req.on('error', () => resolve(null));
    });
  }
}
