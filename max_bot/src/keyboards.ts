import { Keyboard } from '@maxhub/max-bot-api';
import type { InlineKeyboardAttachmentRequest } from '@maxhub/max-bot-api/types';

const { button } = Keyboard;

export function mainMenu(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('💎 Вступить в лист ожидания', 'join_waitlist')],
    [button.callback('✨ Посмотреть продукты', 'view_products')],
    [button.callback('📖 Получить Гайд по активам', 'get_guide')],
  ]);
}

/** Подэкран статистики: выгрузка Excel и возврат в админ-меню (как в Telegram). */
export function statsKeyboard(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('📊 Выгрузить таблицу', 'admin_export_users')],
    [button.callback('← Назад', 'admin_main')],
  ]);
}

export function adminMenu(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('📊 Статистика', 'admin_stats')],
    [button.callback('📢 Рассылка', 'admin_newsletter')],
    [button.callback('📣 Пост в каналы', 'admin_create_post')],
    [button.callback('🛍️ Управление продуктами', 'admin_manage_products')],
    [button.callback('📄 Управление гайдом', 'admin_change_guide')],
  ]);
}

export function postConfirmKeyboard(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [
      button.callback('✅ Опубликовать', 'confirm_post'),
      button.callback('❌ Отмена', 'cancel_post'),
    ],
  ]);
}

export function priorityKeyboard(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('Упругость и лифтинг', 'priority:elasticity')],
    [button.callback('Сияние и тон', 'priority:glow')],
    [button.callback('Глубокое очищение и обновление', 'priority:cleansing')],
  ]);
}

export function phoneKeyboard(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.requestContact('📱 Отправить номер телефона')],
    [button.callback('Отмена', 'back_to_main')],
  ]);
}

export function carouselKeyboard(
  currentIndex: number,
  total: number,
): InlineKeyboardAttachmentRequest {
  const navRow = [];

  if (currentIndex > 0) {
    navRow.push(button.callback('‹', `product_nav:${currentIndex - 1}`));
  } else {
    navRow.push(button.callback('·', 'noop'));
  }

  navRow.push(button.callback(`${currentIndex + 1}/${total}`, 'noop'));

  if (currentIndex < total - 1) {
    navRow.push(button.callback('›', `product_nav:${currentIndex + 1}`));
  } else {
    navRow.push(button.callback('·', 'noop'));
  }

  return Keyboard.inlineKeyboard([navRow, [button.callback('← Назад', 'back_to_main')]]);
}

export function newsletterCategories(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('Всем пользователям', 'newsletter_cat:all')],
    [button.callback('Кто записался в лист ожидания', 'newsletter_cat:waitlist')],
    [button.callback('Кто получил гайд', 'newsletter_cat:guide')],
    [button.callback('Кто ничего не сделал', 'newsletter_cat:none')],
    [button.callback('Отмена', 'admin_main')],
  ]);
}

export function productManageKeyboard(
  products: Array<{ id: number; name: string }>,
): InlineKeyboardAttachmentRequest {
  const rows = products.map((p) => [
    button.callback(`✏️ ${p.name}`, `edit_prod:${p.id}`),
  ]);
  rows.push([button.callback('+ Добавить продукт', 'add_product')]);
  rows.push([button.callback('← Назад', 'admin_main')]);
  return Keyboard.inlineKeyboard(rows);
}

export function productEditOptions(productId: number): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('Изменить название', `edit_field:name:${productId}`)],
    [button.callback('Изменить описание', `edit_field:desc:${productId}`)],
    [button.callback('Изменить фото', `edit_field:photo:${productId}`)],
    [button.callback('Удалить продукт', `delete_prod:${productId}`)],
    [button.callback('← Назад', 'admin_manage_products')],
  ]);
}

export function skipPhotoKeyboard(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.callback('Пропустить', 'skip_product_photo')],
    [button.callback('Отмена', 'admin_manage_products')],
  ]);
}

export function subCheckKeyboard(channelUrl: string): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([
    [button.link('Подписаться на сообщество', channelUrl)],
    [button.callback('✅ Я подписался — проверить', 'check_sub')],
    [button.callback('← Назад', 'back_to_main')],
  ]);
}

export function cancelKeyboard(cancelPayload = 'admin_main'): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([[button.callback('Отмена', cancelPayload)]]);
}
