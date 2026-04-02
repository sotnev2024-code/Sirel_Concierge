from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder, ReplyKeyboardBuilder
from config import CHANNEL_URL

def get_main_menu():
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="💎 Вступить в лист ожидания", callback_data="join_waitlist"))
    builder.row(InlineKeyboardButton(text="✨ Посмотреть продукты", callback_data="view_products"))
    builder.row(InlineKeyboardButton(text="📖 Получить Гайд по активам", callback_data="get_guide"))
    # Button 4 "Ask expert" is excluded as per instructions
    return builder.as_markup()

def get_admin_menu():
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="📊 Статистика", callback_data="admin_stats"))
    builder.row(InlineKeyboardButton(text="📢 Рассылка", callback_data="admin_newsletter"))
    builder.row(InlineKeyboardButton(text="📣 Пост в каналы", callback_data="admin_create_post"))
    builder.row(InlineKeyboardButton(text="📄 Изменить гайд", callback_data="admin_change_guide"))
    builder.row(InlineKeyboardButton(text="🛍️ Управление продуктами", callback_data="admin_manage_products"))
    return builder.as_markup()


def get_post_confirm_keyboard():
    builder = InlineKeyboardBuilder()
    builder.row(
        InlineKeyboardButton(text="✅ Опубликовать", callback_data="confirm_post"),
        InlineKeyboardButton(text="❌ Отмена", callback_data="cancel_post"),
    )
    return builder.as_markup()

def get_stats_keyboard():
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="📊 Выгрузить таблицу", callback_data="admin_export_users"))
    builder.row(InlineKeyboardButton(text="Назад", callback_data="admin_main"))
    return builder.as_markup()


def get_priority_keyboard():
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="Упругость и лифтинг", callback_data="priority:elasticity"))
    builder.row(InlineKeyboardButton(text="Сияние и тон", callback_data="priority:glow"))
    builder.row(InlineKeyboardButton(text="Глубокое очищение и обновление", callback_data="priority:cleansing"))
    return builder.as_markup()

def get_phone_keyboard():
    builder = ReplyKeyboardBuilder()
    builder.row(KeyboardButton(text="📱 Отправить номер телефона", request_contact=True))
    return builder.as_markup(resize_keyboard=True, one_time_keyboard=True)

def get_carousel_keyboard(current_index, total_count):
    builder = InlineKeyboardBuilder()
    row = []
    if current_index > 0:
        row.append(InlineKeyboardButton(text="<", callback_data=f"product_nav:{current_index-1}"))
    else:
        row.append(InlineKeyboardButton(text=" ", callback_data="noop"))
        
    row.append(InlineKeyboardButton(text=f"{current_index + 1}/{total_count}", callback_data="noop"))
    
    if current_index < total_count - 1:
        row.append(InlineKeyboardButton(text=">", callback_data=f"product_nav:{current_index+1}"))
    else:
        row.append(InlineKeyboardButton(text=" ", callback_data="noop"))
        
    builder.row(*row)
    builder.row(InlineKeyboardButton(text="Назад", callback_data="back_to_main"))
    return builder.as_markup()

def get_sub_check_keyboard():
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="Подписаться на канал", url=CHANNEL_URL))
    builder.row(InlineKeyboardButton(text="Проверить подписку", callback_data="check_sub"))
    builder.row(InlineKeyboardButton(text="Назад", callback_data="back_to_main"))
    return builder.as_markup()

def get_newsletter_categories():
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="Всем пользователям", callback_data="newsletter_cat:all"))
    builder.row(InlineKeyboardButton(text="Кто записался в лист ожидания", callback_data="newsletter_cat:waitlist"))
    builder.row(InlineKeyboardButton(text="Кто получил гайд", callback_data="newsletter_cat:guide"))
    builder.row(InlineKeyboardButton(text="Кто ничего не сделал", callback_data="newsletter_cat:none"))
    builder.row(InlineKeyboardButton(text="Отмена", callback_data="admin_cancel"))
    return builder.as_markup()

def get_product_manage_keyboard(products):
    builder = InlineKeyboardBuilder()
    for prod in products:
        builder.row(InlineKeyboardButton(text=f"Edit: {prod[1]}", callback_data=f"edit_prod:{prod[0]}"))
    builder.row(InlineKeyboardButton(text="+ Добавить продукт", callback_data="add_product"))
    builder.row(InlineKeyboardButton(text="Назад", callback_data="admin_main"))
    return builder.as_markup()

def get_product_edit_options(product_id):
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="Изменить название", callback_data=f"edit_field:name:{product_id}"))
    builder.row(InlineKeyboardButton(text="Изменить описание", callback_data=f"edit_field:desc:{product_id}"))
    builder.row(InlineKeyboardButton(text="Изменить фото", callback_data=f"edit_field:photo:{product_id}"))
    builder.row(InlineKeyboardButton(text="Удалить продукт", callback_data=f"delete_prod:{product_id}"))
    builder.row(InlineKeyboardButton(text="Назад", callback_data="admin_manage_products"))
    return builder.as_markup()
