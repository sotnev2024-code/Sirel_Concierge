import path from 'path';
import dotenv from 'dotenv';

// Always load max_bot/.env (start.py used to run node from repo root — cwd .env was the wrong file).
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { Bot } from '@maxhub/max-bot-api';
import { registerUserHandlers } from './handlers/user';
import { registerAdminHandlers } from './handlers/admin';

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;

if (!MAX_BOT_TOKEN) {
  console.error('Error: MAX_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new Bot(MAX_BOT_TOKEN);

// Debug: log every incoming update
bot.use((ctx, next) => {
  console.log('[DEBUG] update_type:', ctx.updateType, '| raw:', JSON.stringify(ctx.update).slice(0, 300));
  return next();
});

registerAdminHandlers(bot);
registerUserHandlers(bot);

// Suppress the default "crash on any error" behaviour — log and keep running
bot.catch((err, ctx) => {
  console.error(`[ERROR] processing update ${ctx.updateType}:`, err);
});

/** Network error codes that should trigger a reconnect instead of a crash. */
const RETRIABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Node 24 native fetch wraps network errors as TypeError with a cause
  const cause = (err as NodeJS.ErrnoException & { cause?: Error }).cause;
  const code = (err as NodeJS.ErrnoException).code ?? (cause as NodeJS.ErrnoException | undefined)?.code ?? '';
  return (
    RETRIABLE_CODES.has(code)
    || err.message.includes('fetch failed')
    || err.message.includes('ECONNRESET')
    || err.message.includes('socket disconnected')
  );
}

async function startWithRetry(): Promise<void> {
  const RETRY_DELAY_MS = 5_000;

  while (true) {
    try {
      console.log('Max bot is starting...');
      console.log(`[Max] Loaded env: ${envPath}`);
      // Reset internal flag so bot.start() can run again after an unexpected exit
      (bot as unknown as { pollingIsStarted: boolean }).pollingIsStarted = false;

      // ── Diagnostic: show which bot we are ──────────────────────────────
      try {
        const me = await bot.api.getMyInfo();
        console.log(`[Max] Connected as: @${me.username} (id=${me.user_id}, name="${me.name}")`);
      } catch (e) {
        console.error('[Max] Failed to get bot info:', e);
      }

      // ── Diagnostic: one test getUpdates call ────────────────────────────
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await (bot.api as any).getUpdates([], { timeout: 1 });
        console.log('[Max] Test getUpdates:', JSON.stringify(raw).slice(0, 400));
      } catch (e) {
        console.error('[Max] Test getUpdates failed:', e);
      }

      await bot.start();
      // bot.start() should block indefinitely; if it returned without error
      // it means polling exited unexpectedly — restart it
      console.warn(`Polling loop exited unexpectedly — restarting in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    } catch (err) {
      if (isNetworkError(err)) {
        console.warn(
          `Network error while connecting to Max API — retrying in ${RETRY_DELAY_MS / 1000}s...`,
          (err as Error).message,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        bot.stop();
        continue;
      }
      // Unknown error — rethrow
      throw err;
    }
  }
}

startWithRetry().catch((err) => {
  console.error('Fatal error, cannot start Max bot:', err);
  process.exit(1);
});
