import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import type { Bot } from '@maxhub/max-bot-api';
import * as db from '../database';
import * as kb from '../keyboards';
import { uploadMaxFileWithFilename, type MaxFileAttachJson } from '../maxUpload';
import {
  States,
  getState,
  setState,
  updateData,
  clearState,
} from '../states';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

const ADMIN_IDS: number[] = (process.env.ADMIN_IDS ?? '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !Number.isNaN(n));

const MAX_API_URL = 'https://platform-api.max.ru/messages';

/** Persist post preview so «Опубликовать» works if in-memory FSM was lost between messages. */
const POST_DRAFT_KEY = 'max_admin_post_draft';
const POST_DRAFT_TTL_MS = 15 * 60 * 1000;

const CALLBACK_ACK_SILENT = { notification: '\u200b' };

type ReplyExtra = {
  attachments?: unknown[];
  format?: 'markdown' | 'html' | null;
  notify?: boolean;
};

function extra(e: ReplyExtra): ReplyExtra {
  return e;
}

function isAdmin(userId: number): boolean {
  return ADMIN_IDS.includes(userId);
}

function savePostDraft(
  userId: number,
  text: string,
  hasPhoto: boolean,
  previewJson?: string,
): void {
  db.setSetting(
    POST_DRAFT_KEY,
    JSON.stringify({
      u: userId,
      text,
      has_photo: hasPhoto ? 1 : 0,
      preview_json: previewJson ?? null,
      ts: Date.now(),
    }),
  );
}

function loadPostDraft(userId: number): {
  text: string;
  hasPhoto: boolean;
  previewJson?: string;
} | null {
  const raw = db.getSetting(POST_DRAFT_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as {
      u: number;
      text?: string;
      has_photo?: number;
      preview_json?: string | null;
      ts?: number;
    };
    if (d.u !== userId) return null;
    if (!d.ts || Date.now() - d.ts > POST_DRAFT_TTL_MS) {
      db.setSetting(POST_DRAFT_KEY, '');
      return null;
    }
    return {
      text: String(d.text ?? ''),
      hasPhoto: d.has_photo === 1,
      previewJson: d.preview_json ? String(d.preview_json) : undefined,
    };
  } catch {
    return null;
  }
}

function clearPostDraft(): void {
  db.setSetting(POST_DRAFT_KEY, '');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any;

/**
 * Edit the message that triggered a callback (in-place update like Telegram),
 * or fall back to sending a new message if no callback message is available.
 */
async function editOrReply(
  ctx: AnyCtx,
  text: string,
  keyboard?: unknown,
): Promise<void> {
  const attachments: unknown[] = [];
  if (keyboard) attachments.push(keyboard);

  const mid: string | undefined = ctx.message?.body?.mid;
  if (mid) {
    try {
      const editExtra: Record<string, unknown> = { text };
      if (attachments.length > 0) editExtra.attachments = attachments;
      await ctx.api.editMessage(mid, editExtra);
      return;
    } catch {
      // fall through to reply
    }
  }
  await ctx.reply(text, extra({ attachments }) as never);
}

async function sendMaxMessage(
  token: string,
  userId: number,
  text: string,
): Promise<boolean> {
  try {
    const url = new URL(MAX_API_URL);
    url.searchParams.set('user_id', String(userId));
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Download an image attachment from a Max message and save it to data/products/.
 * Returns the relative path (suitable for storing in photo_id) or null on failure.
 */
/**
 * Try to extract an image from an incoming Max message and save it locally.
 *
 * Returns:
 *  - "data/products/product_N.jpg"  → local file saved, works for both platforms
 *  - "max_token:{token}"            → only a Max-resend token was available (no URL)
 *  - null                           → no image found at all
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function downloadMaxPhoto(ctx: AnyCtx, productId: number): Promise<string | null> {
  // Attachments are nested inside message.body.attachments in the Max API update
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodyAttachments: any[] = ctx.message?.body?.attachments ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const directAttachments: any[] = ctx.message?.attachments ?? [];
  const allAttachments = [...bodyAttachments, ...directAttachments];

  console.log('[Photo] Received attachments:', JSON.stringify(allAttachments));

  // Find any attachment carrying an image
  const img = allAttachments.find(
    (a) => a.type === 'image' || a.payload?.photos || a.payload?.photo_id || a.photos,
  );
  if (!img) return null;

  // In Max API the download URL lives directly in payload.url (not in payload.photos)
  const photos: Record<string, { url?: string }> =
    img.payload?.photos ?? img.photos ?? {};
  const url: string | null =
    img.payload?.url
    ?? photos?.original?.url
    ?? photos?.['800']?.url
    ?? photos?.preview?.url
    ?? (Object.values(photos)[0] as { url?: string } | undefined)?.url
    ?? null;

  if (url) {
    try {
      const absPath = path.join(PROJECT_ROOT, 'data', 'products', `product_${productId}.jpg`);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const resp = await fetch(url);
      if (!resp.ok) return null;
      fs.writeFileSync(absPath, Buffer.from(await resp.arrayBuffer()));
      db.setSetting(`max_product_photo_${productId}`, '');
      return path.join('data', 'products', `product_${productId}.jpg`);
    } catch {
      return null;
    }
  }

  // No download URL — fall back to storing the raw resend token (Max-only display)
  const token: string | null = img.payload?.token ?? null;
  if (token) {
    db.setSetting(`max_product_photo_${productId}`, token);
    return `max_token:${productId}`;
  }

  return null;
}

/**
 * Download a file attachment from a Max message and save it to destPath.
 * Returns true on success, false if no file found or download failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function downloadMaxFile(ctx: AnyCtx, destPath: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodyAttachments: any[] = ctx.message?.body?.attachments ?? [];
  const fileAttach = bodyAttachments.find(
    (a) => a.type === 'file' || a.payload?.url || a.payload?.fileId,
  );
  if (!fileAttach) return false;

  const url: string | null = fileAttach.payload?.url ?? null;
  if (!url) return false;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

async function sendTelegramMessage(
  token: string,
  userId: number,
  text: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: userId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve chat ids to try for posting to a Max community/channel.
 * Official POST /messages docs use integer chat_id; SDK examples use numeric ids.
 * Public ids like "222179119507_biz" often work for links but not for sendMessageToChat — use MAX_GROUP_CHAT_ID first.
 */
function maxPostChatIdCandidates(): Array<string | number> {
  const out: Array<string | number> = [];
  const groupRaw = (process.env.MAX_GROUP_CHAT_ID ?? '').trim().replace(/^["']|["']$/g, '');
  if (groupRaw && /^-?\d+$/.test(groupRaw)) {
    out.push(Number(groupRaw));
  }
  const publicId = (process.env.MAX_CHANNEL_ID ?? '').trim();
  if (publicId && publicId !== '0' && !out.includes(publicId as never)) {
    out.push(publicId);
  }
  return out;
}

/**
 * Post text + optional image to the Max channel via bot.api (same as in client-ts docs).
 */
async function postToMaxChannel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  text: string,
  attachmentJson?: string,
): Promise<boolean> {
  const candidates = maxPostChatIdCandidates();
  if (candidates.length === 0) {
    console.error('[postToMaxChannel] Set MAX_GROUP_CHAT_ID (integer from bot_added) and/or MAX_CHANNEL_ID in max_bot/.env');
    return false;
  }
  const extra: Record<string, unknown> = {};
  if (attachmentJson) {
    try {
      extra.attachments = [JSON.parse(attachmentJson) as unknown];
    } catch (e) {
      console.error('[postToMaxChannel] bad attachment JSON', e);
    }
  }
  const t = text.trim();
  const sendText = t || ' ';

  let lastErr: unknown;
  for (const chatId of candidates) {
    try {
      await api.sendMessageToChat(
        chatId,
        sendText,
        Object.keys(extra).length > 0 ? extra : undefined,
      );
      console.log('[postToMaxChannel] OK chat_id=', chatId);
      return true;
    } catch (e) {
      lastErr = e;
      console.warn('[postToMaxChannel] failed chat_id=', chatId, e);
    }
  }
  console.error('[postToMaxChannel] all candidates failed, last:', lastErr);
  return false;
}

/**
 * Post text + optional local photo to the Telegram channel via Bot API.
 */
async function postToTelegramChannel(text: string, photoPath?: string): Promise<boolean> {
  const tgToken = process.env.BOT_TOKEN ?? '';
  const channelId = process.env.TELEGRAM_CHANNEL_ID ?? '';
  if (!tgToken || !channelId) return false;
  try {
    if (photoPath && fs.existsSync(photoPath)) {
      const buf = fs.readFileSync(photoPath);
      const formData = new FormData();
      formData.append('chat_id', channelId);
      if (text) formData.append('caption', text);
      formData.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'photo.jpg');
      const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendPhoto`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) console.error('[postToTelegramChannel] sendPhoto', res.status, await res.text());
      return res.ok;
    } else if (text) {
      const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: channelId, text }),
      });
      if (!res.ok) console.error('[postToTelegramChannel] sendMessage', res.status, await res.text());
      return res.ok;
    }
    return false;
  } catch (e) {
    console.error('[postToTelegramChannel]', e);
    return false;
  }
}

export function registerAdminHandlers(bot: Bot): void {

  // ---------- /admin entry ----------

  bot.command('admin', async (ctx) => {
    const sender = ctx.message?.sender;
    if (!sender || !isAdmin(sender.user_id)) return;
    clearState(sender.user_id);
    await ctx.reply('Добро пожаловать в админ-панель Max!', extra({
      attachments: [kb.adminMenu()],
    }) as never);
  });

  // ---------- admin_main ----------

  bot.action('admin_main', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    clearState(userId);
    await editOrReply(ctx, 'Добро пожаловать в админ-панель Max!', kb.adminMenu());
  });

  // ---------- Post to channels ----------

  bot.action('admin_create_post', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    clearPostDraft();
    setState(userId, States.POST_CONTENT);
    await editOrReply(
      ctx,
      'Отправьте контент для поста в каналы:\n\n'
      + '• Просто текст\n'
      + '• Фото (без подписи)\n'
      + '• Фото с подписью\n\n'
      + 'Пост будет опубликован в Max-канале и Telegram-канале.',
      kb.cancelKeyboard('admin_main'),
    );
  });

  bot.action('confirm_post', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;

    try {
      await ctx.answerOnCallback(CALLBACK_ACK_SILENT);
    } catch { /* ignore */ }

    const { state, data } = getState(userId);
    let text = '';
    let hasPhoto = false;
    let previewJson: string | undefined;

    if (state === States.POST_CONTENT) {
      text = String(data['text'] ?? '');
      hasPhoto = data['has_photo'] === 1 || data['has_photo'] === '1';
      previewJson = data['preview_json'] ? String(data['preview_json']) : undefined;
    } else {
      const draft = loadPostDraft(userId);
      if (!draft) {
        await editOrReply(
          ctx,
          'Черновик поста не найден. Откройте «📣 Пост в каналы» и снова отправьте текст.',
          kb.adminMenu(),
        );
        return;
      }
      text = draft.text;
      hasPhoto = draft.hasPhoto;
      previewJson = draft.previewJson;
    }

    const localPhoto = hasPhoto
      ? path.join(PROJECT_ROOT, 'data', 'post_preview.jpg')
      : undefined;

    clearState(userId);
    clearPostDraft();

    const maxOk = await postToMaxChannel(ctx.api, text, previewJson);
    const tgOk = await postToTelegramChannel(text, localPhoto);

    const result =
      `Результат публикации:\n\n📱 Telegram: ${tgOk ? '✅ Опубликовано' : '❌ Ошибка'}\n`
      + `💬 Max: ${maxOk ? '✅ Опубликовано' : '❌ Ошибка'}`;
    await editOrReply(ctx, result, kb.adminMenu());
  });

  bot.action('cancel_post', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    try {
      await ctx.answerOnCallback(CALLBACK_ACK_SILENT);
    } catch { /* ignore */ }
    clearState(userId);
    clearPostDraft();
    await editOrReply(ctx, 'Публикация отменена.', kb.adminMenu());
  });

  // ---------- Statistics ----------

  bot.action('admin_stats', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;

    const stats = db.getStats();
    const text =
      '📊 Статистика пользователей:\n\n'
      + `👥 Всего: ${stats.total}\n`
      + `  📱 Telegram: ${stats.tg_count}\n`
      + `  💬 Max: ${stats.max_count}\n`
      + `📝 В листе ожидания: ${stats.waitlist}\n`
      + `📖 Получили гайд: ${stats.guide}`;

    await editOrReply(ctx, text, kb.statsKeyboard());
  });

  bot.action('admin_export_users', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;

    const users = db.getAllUsers();
    if (users.length === 0) {
      await ctx.answerOnCallback({
        notification: 'Нет пользователей для экспорта.',
      });
      return;
    }

    try {
      await ctx.answerOnCallback(CALLBACK_ACK_SILENT);
    } catch { /* ignore */ }

    try {
      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Users');
      ws.addRow([
        'ID',
        'Username',
        'Full Name',
        'Phone',
        'Care Priority',
        'In Waitlist',
        'Has Guide',
        'Platform',
        'Registration Date',
      ]);
      for (const u of users) {
        ws.addRow([
          u.user_id,
          u.username ?? '',
          u.full_name ?? '',
          u.phone ?? '',
          u.care_priority ?? '',
          u.is_waitlist ? 'Да' : 'Нет',
          u.has_guide ? 'Да' : 'Нет',
          u.platform,
          u.registration_date ?? '',
        ]);
      }

      const exportPath = path.join(PROJECT_ROOT, 'data', 'users_export.xlsx');
      fs.mkdirSync(path.dirname(exportPath), { recursive: true });
      await workbook.xlsx.writeFile(exportPath);
      const buf = fs.readFileSync(exportPath);

      let attachJson: MaxFileAttachJson;
      try {
        attachJson = await uploadMaxFileWithFilename(ctx.api, buf, 'users_export.xlsx');
      } catch (uploadErr) {
        console.error('[admin_export_users] upload', uploadErr);
        await ctx.reply(
          'Не удалось подготовить файл для отправки.',
          extra({ attachments: [kb.statsKeyboard()] }) as never,
        );
        return;
      }

      await new Promise((r) => setTimeout(r, 600));

      await ctx.reply('Таблица с пользователями', extra({
        attachments: [attachJson, kb.statsKeyboard()],
      }) as never);
    } catch (e) {
      console.error('[admin_export_users]', e);
      await ctx.reply(
        'Ошибка при формировании таблицы. Попробуйте позже.',
        extra({ attachments: [kb.statsKeyboard()] }) as never,
      );
    }
  });

  // ---------- Guide management ----------

  bot.action('admin_change_guide', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    setState(userId, States.CHANGE_GUIDE);
    await editOrReply(
      ctx,
      'Отправьте PDF-файл гайда. Он будет сохранён и станет доступен пользователям в Telegram и Max после подписки на канал.',
      kb.cancelKeyboard('admin_main'),
    );
  });

  // ---------- Newsletter (all platforms) ----------

  bot.action('admin_newsletter', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    setState(userId, States.NEWSLETTER_TEXT);
    await editOrReply(ctx, 'Введите текст рассылки (для всех платформ):', kb.cancelKeyboard('admin_main'));
  });

  bot.action(/newsletter_cat:(.+)/, async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;

    const { state, data } = getState(userId);
    if (state !== States.NEWSLETTER_CATEGORY) return;

    const category = ctx.match![1] as 'all' | 'waitlist' | 'guide' | 'none';
    const text = String(data['text'] ?? '');
    const maxToken = process.env.MAX_BOT_TOKEN ?? '';
    const tgToken = process.env.BOT_TOKEN ?? '';

    const pairs = db.getUsersByCategory(category);
    if (pairs.length === 0) {
      await ctx.answerOnCallback({ notification: 'В этой категории нет пользователей.' });
      clearState(userId);
      return;
    }

    let maxSent = 0;
    let tgSent = 0;
    for (const item of pairs) {
      if (item.platform === 'max') {
        if (await sendMaxMessage(maxToken, item.user_id, text)) maxSent++;
      } else if (item.platform === 'telegram') {
        if (await sendTelegramMessage(tgToken, item.user_id, text)) tgSent++;
      }
    }

    clearState(userId);
    await editOrReply(
      ctx,
      `Рассылка завершена.\n\n📱 Telegram: ${tgSent}\n💬 Max: ${maxSent}\nИтого: ${tgSent + maxSent}`,
      kb.adminMenu(),
    );
  });

  // ---------- Product management ----------

  bot.action('admin_manage_products', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    const products = db.getAllProducts();
    await editOrReply(ctx, 'Управление продуктами:', kb.productManageKeyboard(products));
  });

  bot.action(/edit_prod:(\d+)/, async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    const productId = parseInt(ctx.match![1], 10);
    await editOrReply(ctx, `Редактирование продукта ID ${productId}:`, kb.productEditOptions(productId));
  });

  bot.action(/edit_field:(name|desc):(\d+)/, async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;

    const field = ctx.match![1] as 'name' | 'desc';
    const productId = parseInt(ctx.match![2], 10);
    const nextState = field === 'name' ? States.EDIT_PRODUCT_NAME : States.EDIT_PRODUCT_DESC;

    setState(userId, nextState, { product_id: productId });
    await editOrReply(
      ctx,
      field === 'name' ? 'Введите новое название:' : 'Введите новое описание:',
      kb.cancelKeyboard('admin_manage_products'),
    );
  });

  bot.action(/edit_field:photo:(\d+)/, async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    const productId = parseInt(ctx.match![1], 10);
    setState(userId, States.EDIT_PRODUCT_PHOTO, { product_id: productId });
    await editOrReply(ctx, 'Отправьте новое фото продукта:', kb.cancelKeyboard('admin_manage_products'));
  });

  bot.action('skip_product_photo', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    clearState(userId);
    await editOrReply(ctx, 'Продукт добавлен без фото.', kb.adminMenu());
  });

  bot.action(/delete_prod:(\d+)/, async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    const productId = parseInt(ctx.match![1], 10);
    db.deleteProduct(productId);
    const products = db.getAllProducts();
    await editOrReply(ctx, 'Продукт удалён.', kb.productManageKeyboard(products));
  });

  bot.action('add_product', async (ctx) => {
    const userId = ctx.user!.user_id;
    if (!isAdmin(userId)) return;
    setState(userId, States.ADD_PRODUCT_NAME);
    await editOrReply(ctx, 'Введите название нового продукта:', kb.cancelKeyboard('admin_manage_products'));
  });

  // ---------- Admin FSM message handler ----------

  bot.on('message_created', async (ctx, next) => {
    const sender = ctx.message?.sender;
    if (!sender || !isAdmin(sender.user_id)) return next();

    const userId = sender.user_id;
    const { state, data } = getState(userId);
    const text = (ctx.message?.body?.text ?? '').trim();

    // Photo states: handle image attachments (no text required)
    if (state === States.EDIT_PRODUCT_PHOTO) {
      const productId = Number(data['product_id']);
      const result = await downloadMaxPhoto(ctx, productId);
      if (result) {
        const products = db.getAllProducts();
        const product = products.find((p) => p.id === productId);
        if (product) db.updateProduct(productId, product.name, product.description, result);
        clearState(userId);
        const isLocalFile = result.startsWith('data');
        await ctx.reply(
          isLocalFile
            ? '✅ Фото обновлено! Доступно в Telegram и Max.'
            : '✅ Фото обновлено для Max.\n\nℹ️ Чтобы фото показывалось и в Telegram, загрузите его через Telegram-бот.',
          extra({ attachments: [kb.adminMenu()] }) as never,
        );
      } else {
        await ctx.reply(
          'Не удалось получить фото. Пожалуйста, отправьте изображение.',
          extra({ attachments: [kb.cancelKeyboard('admin_manage_products')] }) as never,
        );
      }
      return;
    }

    if (state === States.ADD_PRODUCT_PHOTO) {
      const productId = Number(data['product_id']);
      const result = await downloadMaxPhoto(ctx, productId);
      if (result) {
        const products = db.getAllProducts();
        const product = products.find((p) => p.id === productId);
        if (product) db.updateProduct(productId, product.name, product.description, result);
        clearState(userId);
        const isLocalFile = result.startsWith('data');
        await ctx.reply(
          isLocalFile
            ? '✅ Продукт добавлен с фото! Доступно в Telegram и Max.'
            : '✅ Продукт добавлен с фото для Max.\n\nℹ️ Чтобы фото было и в Telegram, загрузите его через Telegram-бот.',
          extra({ attachments: [kb.adminMenu()] }) as never,
        );
      } else {
        await ctx.reply(
          'Не удалось получить фото. Отправьте изображение или нажмите «Пропустить».',
          extra({ attachments: [kb.skipPhotoKeyboard()] }) as never,
        );
      }
      return;
    }

    // Post content: accepts text or photo+text (must be before the text-only guard)
    if (state === States.POST_CONTENT) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bodyAttachments: any[] = ctx.message?.body?.attachments ?? [];
      const imgAttach = bodyAttachments.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => a.type === 'image' || a.payload?.photo_id,
      );

      let hasPhoto = false;
      let previewJson: string | undefined;
      const photoPath = path.join(PROJECT_ROOT, 'data', 'post_preview.jpg');

      if (imgAttach) {
        const imgUrl: string | null = imgAttach.payload?.url ?? null;
        if (imgUrl) {
          try {
            const resp = await fetch(imgUrl);
            if (resp.ok) {
              fs.mkdirSync(path.dirname(photoPath), { recursive: true });
              fs.writeFileSync(photoPath, Buffer.from(await resp.arrayBuffer()));
              hasPhoto = true;
            }
          } catch { /* ignore download errors */ }
        }
      }

      setState(userId, States.POST_CONTENT, { text, has_photo: hasPhoto ? 1 : 0 });

      if (hasPhoto) {
        try {
          const buf = fs.readFileSync(photoPath);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const imageAttach = await ctx.api.uploadImage({ source: buf as any }) as any;
          const attachJson = typeof imageAttach.toJson === 'function' ? imageAttach.toJson() : null;
          const pl = attachJson?.payload;
          if (pl?.token || pl?.photos || pl?.url) {
            previewJson = JSON.stringify(attachJson);
            updateData(userId, { preview_json: previewJson });
            savePostDraft(userId, text, true, previewJson);
            await ctx.reply(
              `Превью поста:\n\n${text || '(без текста)'}`,
              extra({ attachments: [attachJson, kb.postConfirmKeyboard()] }) as never,
            );
          } else {
            savePostDraft(userId, text, true, undefined);
            await ctx.reply(
              `Превью поста (фото не загрузилось):\n\n${text || '(без текста)'}`,
              extra({ attachments: [kb.postConfirmKeyboard()] }) as never,
            );
          }
        } catch {
          savePostDraft(userId, text, true, undefined);
          await ctx.reply(
            `Превью поста (ошибка загрузки фото):\n\n${text || '(без текста)'}`,
            extra({ attachments: [kb.postConfirmKeyboard()] }) as never,
          );
        }
      } else if (text) {
        savePostDraft(userId, text, false, undefined);
        await ctx.reply(
          `Превью поста:\n\n${text}`,
          extra({ attachments: [kb.postConfirmKeyboard()] }) as never,
        );
      } else {
        await ctx.reply(
          'Пожалуйста, отправьте текст или фото для поста.',
          extra({ attachments: [kb.cancelKeyboard('admin_main')] }) as never,
        );
      }
      return;
    }

    // Guide upload state: expects a file attachment
    if (state === States.CHANGE_GUIDE) {
      const guidePath = path.join(PROJECT_ROOT, 'data', 'guide.pdf');
      const ok = await downloadMaxFile(ctx, guidePath);
      if (ok) {
        db.setSetting('max_guide_file_token', '');
        db.setSetting('max_guide_token_mtime', '');
        db.setSetting('guide_file_id', '');
        clearState(userId);
        await ctx.reply(
          '✅ Гайд обновлён! Доступен в Telegram и Max после подписки на канал.',
          extra({ attachments: [kb.adminMenu()] }) as never,
        );
      } else {
        await ctx.reply(
          'Не удалось получить файл. Пожалуйста, отправьте PDF-документ.',
          extra({ attachments: [kb.cancelKeyboard('admin_main')] }) as never,
        );
      }
      return;
    }

    // Text-only states
    if (!text) return next();

    if (state === States.NEWSLETTER_TEXT) {
      setState(userId, States.NEWSLETTER_CATEGORY, { ...data, text });
      await ctx.reply('Выберите категорию получателей:', extra({
        attachments: [kb.newsletterCategories()],
      }) as never);
      return;
    }

    if (state === States.EDIT_PRODUCT_NAME) {
      const productId = Number(data['product_id']);
      const products = db.getAllProducts();
      const product = products.find((p) => p.id === productId);
      if (product) db.updateProduct(productId, text, product.description, product.photo_id);
      clearState(userId);
      await ctx.reply('Название обновлено!', extra({ attachments: [kb.adminMenu()] }) as never);
      return;
    }

    if (state === States.EDIT_PRODUCT_DESC) {
      const productId = Number(data['product_id']);
      const products = db.getAllProducts();
      const product = products.find((p) => p.id === productId);
      if (product) db.updateProduct(productId, product.name, text, product.photo_id);
      clearState(userId);
      await ctx.reply('Описание обновлено!', extra({ attachments: [kb.adminMenu()] }) as never);
      return;
    }

    if (state === States.ADD_PRODUCT_NAME) {
      setState(userId, States.ADD_PRODUCT_DESC, { name: text });
      await ctx.reply('Введите описание нового продукта:', extra({
        attachments: [kb.cancelKeyboard('admin_manage_products')],
      }) as never);
      return;
    }

    if (state === States.ADD_PRODUCT_DESC) {
      // Create product in DB first to get its ID, then ask for optional photo
      const productId = db.addProduct(String(data['name']), text, null);
      setState(userId, States.ADD_PRODUCT_PHOTO, { product_id: productId });
      await ctx.reply(
        'Отправьте фото продукта или нажмите «Пропустить».',
        extra({ attachments: [kb.skipPhotoKeyboard()] }) as never,
      );
      return;
    }

    return next();
  });
}
