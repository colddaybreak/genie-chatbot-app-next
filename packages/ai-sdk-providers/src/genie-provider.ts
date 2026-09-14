import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import {
  getAuthMethod,
  getCachedCliHost,
  getDatabricksToken,
  getDatabricksUserIdentity,
} from '@chat-template/auth';
import { getHostUrl } from '@chat-template/utils';

// Header keys for passing context through streamText headers.
// Kept in sync with providers-server.ts.
const CONTEXT_HEADER_CONVERSATION_ID = 'x-databricks-conversation-id';
// Forwarded by the server when the user has authorized the app (OBO).
// Genie must be called as the user so their Unity Catalog grants apply.
const CONTEXT_HEADER_ACCESS_TOKEN = 'x-forwarded-access-token';

const GENIE_API_PREFIX = '/api/2.0/genie/spaces';

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 120_000;

// Human-readable descriptions for Genie message lifecycle statuses.
const STATUS_MESSAGES: Record<string, string> = {
  SUBMITTED: '已提交，正在等待处理…',
  FETCHING_METADATA: '正在获取数据源元数据…',
  FILTERING_CONTEXT: '正在分析上下文…',
  ASKING_AI: 'AI 正在生成回答…',
  PENDING_WAREHOUSE: '正在等待 SQL 仓库…',
  EXECUTING_QUERY: '正在执行 SQL 查询…',
};

// ---------------------------------------------------------------------------
// Genie REST API response shapes (subset of @databricks/sdk-experimental)
// ---------------------------------------------------------------------------

interface GenieStartConversationResponse {
  conversation_id: string;
  message_id: string;
}

interface GenieCreateMessageResponse {
  message_id: string;
}

interface GenieAttachment {
  attachment_id?: string;
  query?: {
    title?: string;
    description?: string;
    query?: string;
    statement_id?: string;
  };
  text?: {
    content?: string;
    purpose?: string;
  };
  suggested_questions?: {
    questions?: string[];
  };
}

interface GenieMessage {
  message_id: string;
  conversation_id: string;
  space_id: string;
  status: string;
  content?: string;
  attachments?: GenieAttachment[];
  error?: { error?: string } | string;
}

interface GenieStatementResponse {
  manifest?: {
    schema?: {
      columns?: Array<{ name?: string; type_name?: string }>;
    };
  };
  result?: {
    data_array?: Array<Array<string | number | null>>;
  };
}

// ---------------------------------------------------------------------------
// Conversation mapping (in-memory): chat id → Genie conversation id.
// A Databricks app runs as a single instance, so this survives multi-turn
// chats for the lifetime of the process. TODO: persist to the app database to
// survive restarts.
// ---------------------------------------------------------------------------

const chatToGenieConversation = new Map<string, string>();

function getGenieSpaceId(): string {
  const spaceId = process.env.DATABRICKS_GENIE_SPACE_ID;
  if (!spaceId) {
    throw new Error(
      'Please set the DATABRICKS_GENIE_SPACE_ID environment variable to the ID of a Genie space',
    );
  }
  return spaceId;
}

/** Resolve the workspace hostname (same strategy as providers-server.ts). */
async function getWorkspaceHostname(): Promise<string> {
  const authMethod = getAuthMethod();
  if (authMethod === 'cli') {
    await getDatabricksUserIdentity();
    const cliHost = getCachedCliHost();
    if (cliHost) return cliHost;
    throw new Error('CLI authentication succeeded but hostname was not cached');
  }
  return getHostUrl();
}

async function genieFetch(
  path: string,
  init?: RequestInit,
  authToken?: string,
): Promise<Response> {
  const hostname = await getWorkspaceHostname();
  // Prefer the user's on-behalf-of token so Genie enforces the signed-in
  // user's Unity Catalog permissions; fall back to the app identity only
  // when no user token was forwarded.
  const token = authToken ?? (await getDatabricksToken());
  return fetch(`${hostname}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

async function genieFetchJson<T>(
  path: string,
  init?: RequestInit,
  authToken?: string,
): Promise<T> {
  const response = await genieFetch(path, init, authToken);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Genie API error (${response.status}) for ${response.url || path}: ${body.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
}

/** Start a new conversation (or continue one) and return the message id. */
async function startGenieMessage(
  spaceId: string,
  content: string,
  conversationId: string | undefined,
  authToken?: string,
): Promise<{ conversationId: string; messageId: string }> {
  if (conversationId) {
    const result = await genieFetchJson<GenieCreateMessageResponse>(
      `${GENIE_API_PREFIX}/${spaceId}/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ content }) },
      authToken,
    );
    return { conversationId, messageId: result.message_id };
  }
  const result = await genieFetchJson<GenieStartConversationResponse>(
    `${GENIE_API_PREFIX}/${spaceId}/start-conversation`,
    { method: 'POST', body: JSON.stringify({ content }) },
    authToken,
  );
  return {
    conversationId: result.conversation_id,
    messageId: result.message_id,
  };
}

/** Fetch SQL query results for a query attachment, if available. */
async function fetchQueryResult(
  spaceId: string,
  conversationId: string,
  messageId: string,
  attachmentId: string,
  authToken?: string,
): Promise<GenieStatementResponse | null> {
  try {
    const result = await genieFetchJson<{
      statement_response?: GenieStatementResponse;
    }>(
      `${GENIE_API_PREFIX}/${spaceId}/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}/query-result`,
      undefined,
      authToken,
    );
    return result.statement_response ?? null;
  } catch (error) {
    console.warn('[Genie] Failed to fetch query result:', error);
    return null;
  }
}

/** Render a query attachment (SQL + optional result table) as markdown. */
async function renderQueryAttachment(
  spaceId: string,
  conversationId: string,
  messageId: string,
  attachment: GenieAttachment,
  authToken?: string,
): Promise<string> {
  const query = attachment.query;
  if (!query) return '';

  const title = query.title ?? 'SQL 查询';
  const lines: string[] = [];
  if (query.description) lines.push(`${query.description}`);

  if (query.query) {
    lines.push('');
    lines.push(`**${title}**`);
    lines.push('');
    lines.push('```sql');
    lines.push(query.query);
    lines.push('```');
  }

  if (query.statement_id && attachment.attachment_id) {
    const statement = await fetchQueryResult(
      spaceId,
      conversationId,
      messageId,
      attachment.attachment_id,
      authToken,
    );
    const columns = statement?.manifest?.schema?.columns ?? [];
    const rows = statement?.result?.data_array ?? [];
    if (columns.length > 0) {
      lines.push('');
      lines.push(
        `**查询结果**（${rows.length} 行${rows.length >= 100 ? '（前 100 行）' : ''}）：`,
      );
      lines.push('');
      lines.push(`| ${columns.map((c) => c.name ?? '').join(' | ')} |`);
      lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
      for (const row of rows.slice(0, 100)) {
        lines.push(`| ${row.map((cell) => cell ?? '').join(' | ')} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Build the final assistant text from the completed Genie message. */
async function renderMessageText(
  spaceId: string,
  conversationId: string,
  message: GenieMessage,
  authToken?: string,
): Promise<string> {
  const parts: string[] = [];

  for (const attachment of message.attachments ?? []) {
    if (attachment.text?.content) {
      parts.push(attachment.text.content);
    }
    const sqlBlock = await renderQueryAttachment(
      spaceId,
      conversationId,
      message.message_id,
      attachment,
      authToken,
    );
    if (sqlBlock) parts.push(sqlBlock);

    const questions = attachment.suggested_questions?.questions ?? [];
    if (questions.length > 0) {
      parts.push('');
      parts.push('**可以继续问我：**');
      for (const question of questions.slice(0, 5)) {
        parts.push(`- ${question}`);
      }
    }
  }

  // Fall back to the raw error message when Genie failed mid-flight.
  if (parts.length === 0 && message.error) {
    const detail =
      typeof message.error === 'string' ? message.error : message.error.error;
    parts.push(`查询失败：${detail ?? '未知错误'}`);
  }

  return parts
    .filter((part) => part.trim())
    .join('\n\n')
    .trim();
}

/** Extract the last user text from an AI SDK v3 prompt. */
function extractLastUserMessage(
  prompt: LanguageModelV3CallOptions['prompt'],
): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    const text = message.content
      .filter(
        (part): part is { type: 'text'; text: string } => part.type === 'text',
      )
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  throw new Error('Genie provider: no user text found in prompt');
}

function truncatePreserveWords(input: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (input.length <= maxLength) return input;
  const slice = input.slice(0, maxLength);
  const lastSpaceIndex = slice.lastIndexOf(' ');
  if (lastSpaceIndex === -1 || lastSpaceIndex === 0) return slice;
  return slice.slice(0, lastSpaceIndex);
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
};

// ---------------------------------------------------------------------------
// LanguageModelV3 implementation backed by a Databricks Genie space.
// ---------------------------------------------------------------------------

export class GenieLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'databricks-genie';
  readonly supportedUrls = {};

  constructor(readonly modelId: string) {}

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    let text = '';
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta') text += value.delta;
        if (value.type === 'error') {
          throw value.error instanceof Error
            ? value.error
            : new Error(String(value.error));
        }
      }
    } finally {
      reader.releaseLock();
    }
    return {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: EMPTY_USAGE,
      warnings: [],
    };
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const textId = `genie-text-${Math.random().toString(36).slice(2, 10)}`;
    const reasoningId = `genie-reasoning-${Math.random().toString(36).slice(2, 10)}`;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: async (controller) => {
        try {
          controller.enqueue({ type: 'stream-start', warnings: [] });

          const spaceId = getGenieSpaceId();
          const content = extractLastUserMessage(options.prompt);
          const headers = (options.headers ?? {}) as Record<
            string,
            string | undefined
          >;
          const chatId = headers[CONTEXT_HEADER_CONVERSATION_ID];
          // Call Genie as the signed-in user (OBO) so their UC grants apply.
          const oboToken = headers[CONTEXT_HEADER_ACCESS_TOKEN];
          const existingConversationId = chatId
            ? chatToGenieConversation.get(chatId)
            : undefined;

          const { conversationId, messageId } = await startGenieMessage(
            spaceId,
            content,
            existingConversationId,
            oboToken,
          );
          if (chatId) {
            chatToGenieConversation.set(chatId, conversationId);
          }

          let reasoningStarted = false;
          const emitStatus = (status: string) => {
            const description = STATUS_MESSAGES[status];
            if (!description) return;
            if (!reasoningStarted) {
              reasoningStarted = true;
              controller.enqueue({ type: 'reasoning-start', id: reasoningId });
            }
            controller.enqueue({
              type: 'reasoning-delta',
              id: reasoningId,
              delta: `\n${description}`,
            });
          };

          const message = await this.pollWithStatus(
            spaceId,
            conversationId,
            messageId,
            options.abortSignal,
            emitStatus,
            oboToken,
          );

          if (reasoningStarted) {
            controller.enqueue({ type: 'reasoning-end', id: reasoningId });
          }

          if (message.status === 'FAILED') {
            const detail =
              typeof message.error === 'string'
                ? message.error
                : message.error?.error;
            const reason = detail ?? 'Genie 处理失败';
            controller.enqueue({
              type: 'error',
              error: new Error(reason),
            });
            return;
          }

          const text = await renderMessageText(
            spaceId,
            conversationId,
            message,
            oboToken,
          );
          if (text) {
            controller.enqueue({ type: 'text-start', id: textId });
            controller.enqueue({ type: 'text-delta', id: textId, delta: text });
            controller.enqueue({ type: 'text-end', id: textId });
          } else {
            controller.enqueue({
              type: 'error',
              error: new Error('Genie 返回了空回复'),
            });
            return;
          }

          controller.enqueue({
            type: 'finish',
            usage: EMPTY_USAGE,
            finishReason: { unified: 'stop', raw: 'stop' },
          });
        } catch (error) {
          console.error('[Genie] doStream failed:', error);
          controller.enqueue({
            type: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        } finally {
          controller.close();
        }
      },
    });

    return { stream, request: { body: options.prompt } };
  }

  /** Poll Genie, surfacing interim statuses through a callback. */
  private async pollWithStatus(
    spaceId: string,
    conversationId: string,
    messageId: string,
    signal: AbortSignal | undefined,
    onStatus: (status: string) => void,
    authToken?: string,
  ): Promise<GenieMessage> {
    const pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    let lastStatus = '';

    while (true) {
      if (signal?.aborted) throw new Error('Genie message request aborted');
      if (Date.now() > deadline) {
        throw new Error(
          `Genie message ${messageId} did not finish within ${DEFAULT_TIMEOUT_MS}ms`,
        );
      }

      const message = await genieFetchJson<GenieMessage>(
        `${GENIE_API_PREFIX}/${spaceId}/conversations/${conversationId}/messages/${messageId}`,
        undefined,
        authToken,
      );

      if (message.status !== lastStatus) {
        lastStatus = message.status;
        onStatus(message.status);
      }

      if (message.status === 'COMPLETED' || message.status === 'FAILED') {
        return message;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

/**
 * A local model used for chat-title generation in Genie mode.
 * Returns a truncated version of the first user message, avoiding an extra
 * Genie round-trip for every new conversation.
 */
class GenieTitleModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'databricks-genie';
  readonly supportedUrls = {};

  constructor(readonly modelId: string) {}

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    let title = '';
    try {
      const userText = extractLastUserMessage(options.prompt);
      title = truncatePreserveWords(userText, 80);
    } catch {
      title = 'New chat';
    }
    return {
      content: [{ type: 'text', text: title }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: EMPTY_USAGE,
      warnings: [],
    };
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const textId = `genie-title-${Math.random().toString(36).slice(2, 10)}`;
    const { content } = await this.doGenerate(options);
    const text = content[0]?.type === 'text' ? content[0].text : 'New chat';

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        try {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: textId });
          controller.enqueue({ type: 'text-delta', id: textId, delta: text });
          controller.enqueue({ type: 'text-end', id: textId });
          controller.enqueue({
            type: 'finish',
            usage: EMPTY_USAGE,
            finishReason: { unified: 'stop', raw: 'stop' },
          });
        } finally {
          controller.close();
        }
      },
    });
    return { stream };
  }
}

// ---------------------------------------------------------------------------
// Factories used by providers-server.ts
// ---------------------------------------------------------------------------

/** Returns true when the app should talk to Genie instead of a serving endpoint. */
export function isGenieConfigured(): boolean {
  return Boolean(process.env.DATABRICKS_GENIE_SPACE_ID);
}

/** Create the main Genie-backed language model. */
export function createGenieLanguageModel(modelId: string): LanguageModelV3 {
  return new GenieLanguageModel(modelId);
}

/** Create the local title-generation model for Genie mode. */
export function createGenieTitleModel(): LanguageModelV3 {
  return new GenieTitleModel('title-model');
}
