import path from 'path';
import fs from 'fs';
import type { Bot } from '@maxhub/max-bot-api';
import * as db from '../database';
import * as kb from '../keyboards';
import { uploadMaxFileWithFilename } from '../maxUpload';
import {
  States,
  getState,
  setState,
  clearState,
} from '../states';

const WELCOME_TEXT =
  'Добро пожаловать!\n\n'
  + 'Вы прикоснулись к миру Sirel. Мы создаём косметику для женщин, '
  + 'которые ценят качество и уверены в результате. До официального запуска '
  + 'нашей коллекции из 4-х продуктов осталось совсем немного времени. Рады, что вы с нами.';

const PRIORITY_LABELS: Record<string, string> = {
  elasticity: 'Упругость и лифтинг',
  glow: 'Сияние и тон',
  cleansing: 'Глубокое очищение и обновление',
};

type ReplyExtra = {
  attachments?: unknown[];
  format?: 'markdown' | 'html' | null;
  notify?: boolean;
};

function extra(e: ReplyExtra): ReplyExtra {
  return e;
}

const GUIDE_PATH = path.resolve(__dirname, '../../../data/guide.pdf');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** mtime (mtimeMs) файла guide.pdf на момент кэширования токена Max — если PDF заменили, кэш игнорируем. */
const MAX_GUIDE_TOKEN_MTIME_KEY = 'max_guide_token_mtime';
/** Смена схемы кэша (upload с именем guide.pdf) — однократный сброс у всех. */
const MAX_GUIDE_CACHE_SCHEMA = '3';
const MAX_GUIDE_CACHE_SCHEMA_KEY = 'max_guide_cache_schema';

/** Max /answers rejects an empty body — use this for “silent” callback ack (noop / padding). */
const CALLBACK_ACK_SILENT = { notification: '\u200b' };

/**
 * Public channel id for sending messages (e.g. "222179119507_biz" in ?chat_id=).
 * Not usable in GET /chats/{chatId}/members — that path requires an integer id (Max API).
 */
function maxChannelIdFromEnv(): string | null {
  const raw = (process.env.MAX_CHANNEL_ID ?? '').trim();
  if (!raw || raw === '0') return null;
  return raw;
}

/** Path segment from MAX_CHANNEL_URL, e.g. "id222179119507_biz" */
function extractPublicChatLinkSlug(): string | null {
  const urlStr = (process.env.MAX_CHANNEL_URL ?? '').trim();
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    const seg = u.pathname.replace(/^\//, '').replace(/\/$/, '');
    return seg || null;
  } catch {
    if (!urlStr.includes('://') && /^[\w/-]+$/.test(urlStr)) return urlStr;
    return null;
  }
}

/**
 * Integer chat_id for GET /chats/{chatId}/members (docs: chatId must match -?\\d+).
 * Order: MAX_GROUP_CHAT_ID → getChatByLink (URL / id+MAX_CHANNEL_ID) → plain numeric MAX_CHANNEL_ID.
 */
async function resolveNumericChatIdForMembership(ctx: AnyCtx): Promise<number | null> {
  const explicit = (process.env.MAX_GROUP_CHAT_ID ?? '').trim();
  if (explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n)) return Math.trunc(n);
  }

  const linkCandidates: string[] = [];
  const slug = extractPublicChatLinkSlug();
  if (slug) linkCandidates.push(slug);

  const channelIdStr = (process.env.MAX_CHANNEL_ID ?? '').trim();
  if (channelIdStr && channelIdStr !== '0') {
    const prefixed = channelIdStr.startsWith('id') ? channelIdStr : `id${channelIdStr}`;
    if (!linkCandidates.includes(prefixed)) linkCandidates.push(prefixed);
  }

  for (const link of linkCandidates) {
    try {
      const chat = await ctx.api.getChatByLink(link);
      if (chat?.chat_id != null && Number.isFinite(Number(chat.chat_id))) {
        return Number(chat.chat_id);
      }
    } catch (e) {
      console.warn('[check_sub] getChatByLink failed for', JSON.stringify(link), e);
    }
  }

  // Do not use MAX_CHANNEL_ID as integer: values like 222179119507 can be a *dialog* id →
  // "Method is not available for dialogs". Use MAX_GROUP_CHAT_ID from max_bot/.env (bot_added → chat_id).

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any;

/**
 * Edit the message that triggered a callback (in-place update like Telegram),
 * or fall back to sending a new message if no callback message is available.
 * imageAttachment is placed before the keyboard in the attachments array.
 */
async function editOrReply(
  ctx: AnyCtx,
  text: string,
  keyboard?: unknown,
  format?: 'markdown' | 'html' | null,
  imageAttachment?: unknown,
): Promise<void> {
  const attachments: unknown[] = [];
  if (imageAttachment) attachments.push(imageAttachment);
  if (keyboard) attachments.push(keyboard);

  const mid: string | undefined = ctx.message?.body?.mid;
  if (mid) {
    try {
      const editExtra: Record<string, unknown> = { text };
      if (attachments.length > 0) editExtra.attachments = attachments;
      if (format) editExtra.format = format;
      await ctx.api.editMessage(mid, editExtra);
      return;
    } catch {
      // fall through to reply
    }
  }
  await ctx.reply(text, extra({ attachments, format }) as never);
}

/**
 * Return an image attachment object for a product photo.
 *
 * Handles two cases:
 *  1. Local file path ("data/products/…") → upload to Max and cache the token
 *  2. Max-only token ("max_token:{productId}") → use the cached token directly
 *
 * Returns null if no photo is available or upload fails.
 */
async function getProductPhotoAttachment(
  ctx: AnyCtx,
  productId: number,
  photoId: string | null,
): Promise<unknown | null> {
  if (!photoId) return null;

  const cacheKey = `max_product_photo_${productId}`;

  // Case 1: token-only photo (uploaded via Max admin, no local file)
  if (photoId.startsWith('max_token:')) {
    const token = db.getSetting(cacheKey);
    return token ? { type: 'image', payload: { token } } : null;
  }

  // Case 2: local file — upload to Max and cache the result as JSON
  const absPath = path.join(PROJECT_ROOT, photoId);
  if (!fs.existsSync(absPath)) return null;

  const cached = db.getSetting(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Record<string, unknown>;
      const pl = parsed?.payload as Record<string, unknown> | undefined;
      // Only use cache if the payload is valid (has token, url, or photos)
      if (pl?.token || pl?.url || pl?.photos) return parsed;
      // Otherwise fall through and re-upload
      db.setSetting(cacheKey, '');
    } catch {
      // Legacy plain token string (not JSON)
      if (!cached.startsWith('{')) {
        return { type: 'image', payload: { token: cached } };
      }
      db.setSetting(cacheKey, '');
    }
  }

  try {
    // Pass as Buffer so the library uses uploadFromBuffer (proper Blob),
    // which is compatible with Node.js 24's native fetch.
    const buf = fs.readFileSync(absPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageAttachment = await ctx.api.uploadImage({ source: buf as any }) as any;

    // Build and validate the attachment JSON
    const attachJson = typeof imageAttachment.toJson === 'function'
      ? imageAttachment.toJson() as Record<string, unknown>
      : null;
    const pl = attachJson?.payload as Record<string, unknown> | undefined;
    if (!pl?.token && !pl?.url && !pl?.photos) {
      console.error('[PhotoAttach] upload returned empty payload:', JSON.stringify(attachJson));
      return null;
    }

    db.setSetting(cacheKey, JSON.stringify(attachJson));
    return attachJson;
  } catch (err) {
    console.error('[PhotoAttach] upload failed:', err);
    return null;
  }
}

/** Upload (or reuse cached token) and send the guide PDF to the user. */
async function sendGuide(ctx: AnyCtx): Promise<void> {
  const userId: number | undefined = ctx.user?.user_id;

  if (!fs.existsSync(GUIDE_PATH)) {
    await ctx.reply('Гайд ещё не загружен. Попробуйте позже.');
    return;
  }

  try {
    if (db.getSetting(MAX_GUIDE_CACHE_SCHEMA_KEY) !== MAX_GUIDE_CACHE_SCHEMA) {
      db.setSetting('max_guide_file_token', '');
      db.setSetting(MAX_GUIDE_TOKEN_MTIME_KEY, '');
      db.setSetting(MAX_GUIDE_CACHE_SCHEMA_KEY, MAX_GUIDE_CACHE_SCHEMA);
    }

    const cacheKey = 'max_guide_file_token';
    const st = fs.statSync(GUIDE_PATH);
    const fileMtime = st.mtimeMs;
    const boundMtime = db.getSetting(MAX_GUIDE_TOKEN_MTIME_KEY);
    const cachedRaw = db.getSetting(cacheKey);

    let useCache = false;
    if (cachedRaw && boundMtime !== null && boundMtime !== '' && Number(boundMtime) === fileMtime) {
      try {
        const parsed = JSON.parse(cachedRaw) as Record<string, unknown>;
        const pl = parsed?.payload as Record<string, unknown> | undefined;
        if (pl?.token || pl?.url) useCache = true;
      } catch {
        if (cachedRaw.length > 0) useCache = true;
      }
    }

    if (!useCache) {
      db.setSetting(cacheKey, '');
      db.setSetting(MAX_GUIDE_TOKEN_MTIME_KEY, '');
    }

    let attachJson: unknown;

    if (useCache) {
      try {
        attachJson = JSON.parse(cachedRaw!);
      } catch {
        attachJson = { type: 'file', payload: { token: cachedRaw } };
      }
    } else {
      const buf = fs.readFileSync(GUIDE_PATH);
      try {
        attachJson = await uploadMaxFileWithFilename(ctx.api, buf, 'guide.pdf');
      } catch (e) {
        console.error('[sendGuide] upload', e);
        await ctx.reply('Не удалось отправить гайд. Попробуйте позже.');
        return;
      }
      db.setSetting(cacheKey, JSON.stringify(attachJson));
      db.setSetting(MAX_GUIDE_TOKEN_MTIME_KEY, String(fileMtime));
      await new Promise((r) => setTimeout(r, 800));
    }

    await ctx.reply('Ваш гайд по активам!', extra({
      attachments: [attachJson],
    }));
    if (userId !== undefined) db.setHasGuide(userId);
  } catch {
    db.setSetting('max_guide_file_token', '');
    db.setSetting(MAX_GUIDE_TOKEN_MTIME_KEY, '');
    await ctx.reply('Не удалось отправить гайд. Попробуйте ещё раз.');
  }
}

/** Register user and show welcome message — shared by bot_started and /start command. */
async function showWelcome(ctx: AnyCtx): Promise<void> {
  const sender = ctx.user ?? ctx.message?.sender;
  if (!sender) return;
  db.addUser(sender.user_id, sender.username ?? null, sender.name ?? null);
  clearState(sender.user_id);
  await ctx.reply(WELCOME_TEXT, extra({ attachments: [kb.mainMenu()] }));
}

export function registerUserHandlers(bot: Bot): void {

  // ---------- bot_started (first open / Start button) ----------

  bot.on('bot_started', showWelcome);

  // ---------- /start command (subsequent launches) ----------

  bot.command('start', showWelcome);

  // ---------- back_to_main ----------

  bot.action('back_to_main', async (ctx) => {
    const userId = ctx.user!.user_id;
    clearState(userId);
    await editOrReply(ctx, WELCOME_TEXT, kb.mainMenu());
  });

  // ---------- noop (carousel padding) ----------

  bot.action('noop', async (ctx) => {
    await ctx.answerOnCallback(CALLBACK_ACK_SILENT);
  });

  // ---------- Waitlist ----------

  bot.action('join_waitlist', async (ctx) => {
    const userId = ctx.user!.user_id;
    const userRow = db.getUser(userId);
    if (userRow && userRow.is_waitlist) {
      await editOrReply(
        ctx,
        '✅ Вы уже записаны в лист ожидания!\n\n'
        + 'Как только откроется предзаказ — мы сразу с вами свяжемся.',
        kb.mainMenu(),
      );
      return;
    }
    setState(userId, States.WAITLIST_NAME);
    await editOrReply(
      ctx,
      'Первая партия Sirel будет строго лимитирована. Участницы списка получат доступ к заказу '
      + 'на 24 часа раньше официального старта. Чтобы мы закрепили за вами статус '
      + 'привилегированного клиента, ответьте на 2 вопроса.\n\nКак нам к вам обращаться?',
      kb.cancelKeyboard('back_to_main'),
    );
  });

  bot.action(/priority:(.+)/, async (ctx) => {
    const userId = ctx.user!.user_id;
    const { state, data } = getState(userId);
    if (state !== States.WAITLIST_PRIORITY) return;

    const key = ctx.match![1];
    const priorityText = PRIORITY_LABELS[key] ?? key;
    setState(userId, States.WAITLIST_PHONE, { ...data, priority: priorityText });

    await editOrReply(
      ctx,
      `Благодарим, ${data.name}! Вы в списке. Нажмите кнопку ниже, чтобы поделиться `
      + 'номером телефона для SMS-уведомления в момент открытия предзаказа.',
      kb.phoneKeyboard(),
    );
  });

  // ---------- Product carousel ----------

  bot.action('view_products', async (ctx) => {
    const products = db.getAllProducts();
    if (products.length === 0) {
      await ctx.answerOnCallback({ notification: 'Продукты пока не добавлены.' });
      return;
    }
    const p = products[0];
    const photo = await getProductPhotoAttachment(ctx, p.id, p.photo_id);
    await editOrReply(
      ctx,
      `*${p.name}*\n\n${p.description}`,
      kb.carouselKeyboard(0, products.length),
      'markdown',
      photo ?? undefined,
    );
  });

  bot.action(/product_nav:(\d+)/, async (ctx) => {
    const index = parseInt(ctx.match![1], 10);
    const products = db.getAllProducts();
    if (index < 0 || index >= products.length) {
      await ctx.answerOnCallback(CALLBACK_ACK_SILENT);
      return;
    }
    const p = products[index];
    const photo = await getProductPhotoAttachment(ctx, p.id, p.photo_id);
    await editOrReply(
      ctx,
      `*${p.name}*\n\n${p.description}`,
      kb.carouselKeyboard(index, products.length),
      'markdown',
      photo ?? undefined,
    );
  });

  // ---------- Guide (subscription-gated) ----------

  bot.action('get_guide', async (ctx) => {
    const channelUrl = process.env.MAX_CHANNEL_URL ?? '';
    const channelId = maxChannelIdFromEnv();

    if (!channelId || !channelUrl) {
      await sendGuide(ctx);
      return;
    }

    await editOrReply(
      ctx,
      'Чтобы получить гайд, пожалуйста, подпишитесь на наше сообщество.',
      kb.subCheckKeyboard(channelUrl),
    );
  });

  bot.action('check_sub', async (ctx) => {
    const userId = ctx.user!.user_id;
    const channelId = maxChannelIdFromEnv();

    if (!channelId) {
      await sendGuide(ctx);
      return;
    }

    const numericChatId = await resolveNumericChatIdForMembership(ctx);
    if (numericChatId == null) {
      console.error(
        '[check_sub] No integer chat_id for /chats/.../members. Set MAX_GROUP_CHAT_ID in max_bot/.env '
        + '(see update bot_added → chat_id) or check MAX_CHANNEL_URL.',
      );
      await ctx.answerOnCallback({
        notification:
          'Проверка подписки не настроена: укажите MAX_GROUP_CHAT_ID в .env (числовой chat_id сообщества, см. лог bot_added).',
      });
      return;
    }

    try {
      const result = await ctx.api.getChatMembers(numericChatId, { user_ids: [userId] });
      const isMember = result.members.length > 0;

      if (isMember) {
        await ctx.answerOnCallback({
          notification: '✅ Подписка подтверждена. Отправляем гайд…',
        });
        await sendGuide(ctx);
      } else {
        await ctx.answerOnCallback({
          notification: 'Вы не подписаны на сообщество.',
        });
      }
    } catch (err) {
      console.error('[check_sub] getChatMembers failed chat_id=', numericChatId, err);
      await ctx.answerOnCallback({
        notification: 'Ошибка проверки подписки. Убедитесь, что бот — администратор сообщества.',
      });
    }
  });

  // ---------- FSM message handler ----------
  // Registered last so it only catches raw text after actions are processed

  bot.on('message_created', async (ctx, next) => {
    const sender = ctx.message?.sender;
    if (!sender) return next();
    const userId = sender.user_id;

    const { state, data } = getState(userId);
    const text = ctx.message?.body?.text ?? '';

    if (state === States.WAITLIST_NAME) {
      if (!text.trim()) return next();
      setState(userId, States.WAITLIST_PRIORITY, { name: text.trim() });
      await ctx.reply(
        'Какую задачу в уходе вы считаете приоритетной? (Это поможет нам подготовить персональные советы)',
        extra({ attachments: [kb.priorityKeyboard()] }) as never,
      );
      return;
    }

    if (state === States.WAITLIST_PHONE) {
      let phone: string | undefined;

      if (ctx.contactInfo?.tel) {
        phone = ctx.contactInfo.tel;
      } else if (text.trim()) {
        const digits = text.trim().replace(/[\s-]/g, '');
        if (/^\+?\d{7,15}$/.test(digits)) {
          phone = digits;
        }
      }

      if (!phone) {
        await ctx.reply(
          'Пожалуйста, нажмите кнопку «Отправить номер телефона» или введите номер в формате +7XXXXXXXXXX.',
          extra({ attachments: [kb.phoneKeyboard()] }) as never,
        );
        return;
      }

      db.updateUserWaitlist(userId, String(data.name), String(data.priority), phone);
      clearState(userId);
      await ctx.reply('Спасибо! Вы успешно записаны в лист ожидания. Мы свяжемся с вами!');
      await ctx.reply(WELCOME_TEXT, extra({ attachments: [kb.mainMenu()] }) as never);
      return;
    }

    // Fallback: any unknown message outside of FSM state → show main menu hint
    if (text.trim() && !text.startsWith('/')) {
      await ctx.reply(
        'Выберите действие из меню:',
        extra({ attachments: [kb.mainMenu()] }) as never,
      );
      return;
    }

    return next();
  });
}
