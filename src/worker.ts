import { z } from 'zod';

export interface WorkerConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export type WorkerResult =
  | { ok: true; text: string; finishReason: 'stop'; usage?: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: { code: string; message: string; status?: number } };

export class ConfigurationError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  for (const name of ['WORKER_BASE_URL', 'WORKER_MODEL', 'HARNESS_MODEL_API_KEY']) {
    if (!env[name]?.trim()) throw new ConfigurationError(`Missing ${name}.`);
  }
  let url: URL;
  try {
    url = new URL(env.WORKER_BASE_URL!);
  } catch {
    throw new ConfigurationError('Invalid WORKER_BASE_URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError('Invalid WORKER_BASE_URL: use an HTTP(S) URL without credentials, query or fragment.');
  }
  const timeoutMs = Number(env.WORKER_TIMEOUT_MS ?? 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new ConfigurationError('WORKER_TIMEOUT_MS must be an integer from 1 to 300000.');
  }
  if (/[\r\n]/.test(env.HARNESS_MODEL_API_KEY!)) {
    throw new ConfigurationError('Invalid HARNESS_MODEL_API_KEY.');
  }
  return {
    baseUrl: url.href.replace(/\/$/, ''), model: env.WORKER_MODEL!,
    apiKey: env.HARNESS_MODEL_API_KEY!, timeoutMs,
  };
}

const responseSchema = z.object({
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullish(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().min(1),
      tool_calls: z.array(z.unknown()).nullable().optional(),
      function_call: z.unknown().optional(),
    }),
    finish_reason: z.string(),
  })).length(1),
});

function failure(code: string, message: string, status?: number): WorkerResult {
  return { ok: false, error: { code, message, ...(status === undefined ? {} : { status }) } };
}

export async function chat(config: WorkerConfig, message: string, maxOutputTokens?: number): Promise<WorkerResult> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model, stream: false,
        ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
        messages: [
          { role: 'system', content: 'You are an instruct coding worker. Reply with text only; do not call tools.' },
          { role: 'user', content: message },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const guidance = response.status === 401 || response.status === 403
        ? 'Check authorization and model access.'
        : response.status === 429 ? 'Backend rate limit reached.'
          : response.status >= 500 ? 'Backend service failed.' : 'Backend rejected the request.';
      return failure('http_error', `HTTP ${response.status}. ${guidance}`, response.status);
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return failure('malformed_response', 'Backend returned an invalid chat response.');
    const choice = parsed.data.choices[0];
    if (choice.finish_reason !== 'stop' || (choice.message.tool_calls?.length ?? 0) > 0 || choice.message.function_call != null) {
      return failure('incomplete_response', 'Backend returned incomplete text or attempted a tool call.');
    }
    const usage = parsed.data.usage;
    return { ok: true, text: choice.message.content, finishReason: 'stop',
      ...(usage ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } } : {}) };
  } catch (error: unknown) {
    if (signal.aborted) return failure('timeout', 'Backend request timed out while connecting or reading its response.');
    if (error instanceof SyntaxError) return failure('malformed_response', 'Backend returned invalid JSON.');
    if (error instanceof TypeError) return failure('connection_error', 'Backend connection failed. Check connectivity and TLS trust; redirects are disabled.');
    throw error;
  }
}
