import os
import re
import openpyxl
import aiohttp

from aiogram import Router, F
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import (
    CallbackQuery, Message,
    InlineKeyboardButton, InlineKeyboardMarkup,
    FSInputFile,
)

from data import database as db
from keyboards import keyboards as kb
from states.states import AdminStates
from config import (
    ADMIN_IDS,
    MAX_BOT_TOKEN,
    MAX_CHANNEL_ID,
    MAX_GROUP_CHAT_ID,
    CHANNEL_ID,
)

PRODUCTS_DIR = os.path.join("data", "products")

router = Router()

MAX_API_URL = "https://platform-api.max.ru/messages"


def is_admin(user_id):
    return user_id in ADMIN_IDS


async def _save_product_photo(bot, photo, product_id: int) -> str:
    """Download photo from Telegram, save as local file, clear Max upload cache."""
    os.makedirs(PRODUCTS_DIR, exist_ok=True)
    local_path = os.path.join(PRODUCTS_DIR, f"product_{product_id}.jpg")
    await bot.download(photo, destination=local_path)
    await db.set_setting(f"max_product_photo_{product_id}", "")
    return local_path


async def _send_max_message(user_id: int, text: str) -> bool:
    """Send a text message to a Max user via the Max REST API."""
    if not MAX_BOT_TOKEN:
        return False
    headers = {
        "Authorization": MAX_BOT_TOKEN,
        "Content-Type": "application/json",
    }
    params = {"user_id": str(user_id)}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                MAX_API_URL, params=params, json={"text": text}, headers=headers
            ) as resp:
                return resp.status == 200
    except Exception:
        return False


def _max_channel_post_chat_ids():
    """Integer group id first (API /messages chat_id), then public *_biz id."""
    out = []
    gid = (MAX_GROUP_CHAT_ID or "").strip().strip('"').strip("'")
    if gid and re.fullmatch(r"-?\d+", gid) and gid not in out:
        out.append(gid)
    mid = (MAX_CHANNEL_ID or "").strip()
    if mid and mid != "0" and mid not in out:
        out.append(mid)
    return out


async def _post_to_max_channel(text: str, photo_path: str = None) -> bool:
    """Post content (text + optional photo) to the Max channel."""
    if not MAX_BOT_TOKEN:
        return False
    chat_ids = _max_channel_post_chat_ids()
    if not chat_ids:
        return False
    headers_json = {"Authorization": MAX_BOT_TOKEN, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as session:
            attachment = None
            if photo_path and os.path.isfile(photo_path):
                async with session.get(
                    "https://platform-api.max.ru/uploads?type=image",
                    headers={"Authorization": MAX_BOT_TOKEN},
                ) as resp:
                    if not resp.ok:
                        return False
                    upload_info = await resp.json()
                    upload_url = upload_info.get("url")
                    pre_token = upload_info.get("token")
                if not upload_url:
                    return False
                with open(photo_path, "rb") as f:
                    form = aiohttp.FormData()
                    form.add_field("data", f, filename="photo.jpg", content_type="image/jpeg")
                    async with session.post(upload_url, data=form) as upload_resp:
                        upload_result = await upload_resp.json()
                if pre_token:
                    attachment = {"type": "image", "payload": {"token": pre_token}}
                elif upload_result.get("token"):
                    attachment = {"type": "image", "payload": {"token": upload_result["token"]}}
                elif upload_result.get("photos"):
                    attachment = {"type": "image", "payload": {"photos": upload_result["photos"]}}
            body = {"text": text or ""}
            if attachment:
                body["attachments"] = [attachment]
            for chat_id in chat_ids:
                async with session.post(
                    f"https://platform-api.max.ru/messages?chat_id={chat_id}",
                    headers=headers_json,
                    json=body,
                ) as resp:
                    if resp.ok:
                        return True
            return False
    except Exception:
        return False


# --- Admin entry ---

@router.message(Command("admin"))
async def cmd_admin(message: Message):
    if not is_admin(message.from_user.id):
        return
    await message.answer("Добро пожаловать в админ-панель!", reply_markup=kb.get_admin_menu())


@router.callback_query(F.data == "admin_main")
async def admin_main(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.edit_text("Добро пожаловать в админ-панель!", reply_markup=kb.get_admin_menu())


@router.callback_query(F.data == "admin_cancel")
async def admin_cancel(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.edit_text("Действие отменено.", reply_markup=kb.get_admin_menu())


# --- Stats ---

@router.callback_query(F.data == "admin_stats")
async def admin_stats(callback: CallbackQuery):
    total, tg_count, max_count, waitlist, guide = await db.get_stats()
    stats_text = (
        "📊 Статистика пользователей:\n\n"
        f"👥 Всего пользователей: {total}\n"
        f"  📱 Telegram: {tg_count}\n"
        f"  💬 Max: {max_count}\n"
        f"📝 В листе ожидания: {waitlist}\n"
        f"📖 Получили гайд: {guide}"
    )
    await callback.message.edit_text(stats_text, reply_markup=kb.get_stats_keyboard())


@router.callback_query(F.data == "admin_export_users")
async def admin_export_users(callback: CallbackQuery):
    users = await db.get_all_users()
    if not users:
        await callback.answer("Нет пользователей для экспорта.", show_alert=True)
        return

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Users"

    # Columns: user_id, username, full_name, phone, care_priority,
    #          is_waitlist, has_guide, platform, registration_date
    headers = [
        "ID", "Username", "Full Name", "Phone", "Care Priority",
        "In Waitlist", "Has Guide", "Platform", "Registration Date",
    ]
    ws.append(headers)

    for user in users:
        row = list(user)
        row[5] = "Да" if row[5] else "Нет"  # is_waitlist
        row[6] = "Да" if row[6] else "Нет"  # has_guide
        ws.append(row)

    file_path = os.path.join("data", "users_export.xlsx")
    wb.save(file_path)

    await callback.message.answer_document(
        FSInputFile(file_path), caption="Таблица с пользователями"
    )
    await callback.answer()


# --- Newsletter ---

@router.callback_query(F.data == "admin_newsletter")
async def admin_newsletter(callback: CallbackQuery, state: FSMContext):
    await callback.message.edit_text(
        "Введите текст рассылки:",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="Отмена", callback_data="admin_cancel")]]
        ),
    )
    await state.set_state(AdminStates.NEWSLETTER_TEXT)


@router.message(AdminStates.NEWSLETTER_TEXT)
async def newsletter_text(message: Message, state: FSMContext):
    await state.update_data(text=message.text)
    await message.answer("Выберите категорию получателей:", reply_markup=kb.get_newsletter_categories())
    await state.set_state(AdminStates.NEWSLETTER_CATEGORY)


@router.callback_query(AdminStates.NEWSLETTER_CATEGORY, F.data.startswith("newsletter_cat:"))
async def newsletter_send(callback: CallbackQuery, state: FSMContext, bot):
    category = callback.data.split(":")[1]
    data = await state.get_data()
    text = data["text"]

    user_pairs = await db.get_users_by_category(category)
    if not user_pairs:
        await callback.answer("В этой категории нет пользователей.", show_alert=True)
        return

    tg_sent = 0
    max_sent = 0

    for user_id, platform in user_pairs:
        if platform == "telegram":
            try:
                await bot.send_message(user_id, text)
                tg_sent += 1
            except Exception:
                pass
        elif platform == "max":
            if await _send_max_message(user_id, text):
                max_sent += 1

    result_text = (
        f"Рассылка завершена.\n\n"
        f"📱 Telegram: {tg_sent}\n"
        f"💬 Max: {max_sent}\n"
        f"Итого отправлено: {tg_sent + max_sent}"
    )
    await callback.message.edit_text(result_text, reply_markup=kb.get_admin_menu())
    await state.clear()


# --- Change Guide (Telegram + save locally for Max) ---

@router.callback_query(F.data == "admin_change_guide")
async def admin_change_guide(callback: CallbackQuery, state: FSMContext):
    await callback.message.edit_text(
        "Пришлите PDF файл для замены гайда.\n"
        "Файл будет использован и в Telegram, и в Max:",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="Отмена", callback_data="admin_cancel")]]
        ),
    )
    await state.set_state(AdminStates.CHANGE_GUIDE)


@router.message(AdminStates.CHANGE_GUIDE, F.document)
async def newsletter_guide(message: Message, state: FSMContext, bot):
    if not message.document.file_name.lower().endswith(".pdf"):
        await message.answer("Пожалуйста, пришлите PDF файл.")
        return

    # Save Telegram file_id for Telegram bot
    await db.set_setting("guide_file_id", message.document.file_id)

    # Download and save locally so Max bot can upload it to users
    guide_path = os.path.join("data", "guide.pdf")
    await bot.download(message.document, destination=guide_path)

    # Сброс кэша Max (токен + привязка к mtime файла на диске)
    await db.set_setting("max_guide_file_token", "")
    await db.set_setting("max_guide_token_mtime", "")

    await message.answer(
        "Гайд успешно обновлён! Файл сохранён для Telegram и Max.",
        reply_markup=kb.get_admin_menu(),
    )
    await state.clear()


# --- Product Management ---

@router.callback_query(F.data == "admin_manage_products")
async def admin_manage_products(callback: CallbackQuery):
    products = await db.get_all_products()
    await callback.message.edit_text(
        "Управление продуктами:", reply_markup=kb.get_product_manage_keyboard(products)
    )


@router.callback_query(F.data.startswith("edit_prod:"))
async def edit_product(callback: CallbackQuery):
    product_id = int(callback.data.split(":")[1])
    await callback.message.edit_text(
        f"Редактирование продукта ID {product_id}:",
        reply_markup=kb.get_product_edit_options(product_id),
    )


@router.callback_query(F.data.startswith("edit_field:"))
async def edit_field(callback: CallbackQuery, state: FSMContext):
    field = callback.data.split(":")[1]
    product_id = int(callback.data.split(":")[2])
    await state.update_data(product_id=product_id, field=field)

    if field == "name":
        await callback.message.edit_text("Введите новое название:")
        await state.set_state(AdminStates.EDIT_PRODUCT_NAME)
    elif field == "desc":
        await callback.message.edit_text("Введите новое описание:")
        await state.set_state(AdminStates.EDIT_PRODUCT_DESC)
    elif field == "photo":
        await callback.message.edit_text("Пришлите новое фото:")
        await state.set_state(AdminStates.EDIT_PRODUCT_PHOTO)


@router.message(AdminStates.EDIT_PRODUCT_NAME)
async def edit_product_name(message: Message, state: FSMContext):
    data = await state.get_data()
    product_id = data["product_id"]
    products = await db.get_all_products()
    product = next(p for p in products if p[0] == product_id)
    await db.update_product(product_id, message.text, product[2], product[3])
    await message.answer("Название обновлено!", reply_markup=kb.get_admin_menu())
    await state.clear()


@router.message(AdminStates.EDIT_PRODUCT_DESC)
async def edit_product_desc(message: Message, state: FSMContext):
    data = await state.get_data()
    product_id = data["product_id"]
    products = await db.get_all_products()
    product = next(p for p in products if p[0] == product_id)
    await db.update_product(product_id, product[1], message.text, product[3])
    await message.answer("Описание обновлено!", reply_markup=kb.get_admin_menu())
    await state.clear()


@router.message(AdminStates.EDIT_PRODUCT_PHOTO, F.photo)
async def edit_product_photo(message: Message, state: FSMContext, bot):
    data = await state.get_data()
    product_id = data["product_id"]
    products = await db.get_all_products()
    product = next(p for p in products if p[0] == product_id)
    local_path = await _save_product_photo(bot, message.photo[-1], product_id)
    await db.update_product(product_id, product[1], product[2], local_path)
    await message.answer("Фото обновлено!", reply_markup=kb.get_admin_menu())
    await state.clear()


@router.callback_query(F.data.startswith("delete_prod:"))
async def delete_product(callback: CallbackQuery):
    product_id = int(callback.data.split(":")[1])
    await db.delete_product(product_id)
    await callback.answer("Продукт удален.", show_alert=True)
    products = await db.get_all_products()
    await callback.message.edit_text(
        "Управление продуктами:", reply_markup=kb.get_product_manage_keyboard(products)
    )


@router.callback_query(F.data == "add_product")
async def add_product(callback: CallbackQuery, state: FSMContext):
    await callback.message.edit_text("Введите название нового продукта:")
    await state.set_state(AdminStates.ADD_PRODUCT_NAME)


@router.message(AdminStates.ADD_PRODUCT_NAME)
async def add_product_name(message: Message, state: FSMContext):
    await state.update_data(name=message.text)
    await message.answer("Введите описание нового продукта:")
    await state.set_state(AdminStates.ADD_PRODUCT_DESC)


@router.message(AdminStates.ADD_PRODUCT_DESC)
async def add_product_desc(message: Message, state: FSMContext):
    await state.update_data(desc=message.text)
    await message.answer("Пришлите фото продукта (или отправьте любой текст, чтобы пропустить):")
    await state.set_state(AdminStates.ADD_PRODUCT_PHOTO)


@router.message(AdminStates.ADD_PRODUCT_PHOTO)
async def add_product_photo(message: Message, state: FSMContext, bot):
    data = await state.get_data()
    # Create product first to get its ID, then optionally attach a photo
    product_id = await db.add_product(data["name"], data["desc"], None)
    if message.photo:
        local_path = await _save_product_photo(bot, message.photo[-1], product_id)
        await db.update_product(product_id, data["name"], data["desc"], local_path)
    await message.answer("Продукт добавлен!", reply_markup=kb.get_admin_menu())
    await state.clear()


# --- Post to channels ---

@router.callback_query(F.data == "admin_create_post")
async def admin_create_post(callback: CallbackQuery, state: FSMContext):
    if not is_admin(callback.from_user.id):
        return
    await state.set_state(AdminStates.POST_CONTENT)
    await callback.message.edit_text(
        "Отправьте контент для поста в каналы:\n\n"
        "• Просто текст\n"
        "• Фото (без подписи)\n"
        "• Фото с подписью\n\n"
        "Пост будет отправлен в Telegram-канал и Max-канал.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="Отмена", callback_data="admin_cancel")]]
        ),
    )


@router.message(AdminStates.POST_CONTENT)
async def post_content_received(message: Message, state: FSMContext, bot):
    if not is_admin(message.from_user.id):
        return
    text = message.caption or message.text or ""
    local_photo = None
    has_photo = False

    if message.photo:
        has_photo = True
        os.makedirs("data", exist_ok=True)
        local_photo = os.path.join("data", "post_preview.jpg")
        await bot.download(message.photo[-1], destination=local_photo)

    await state.update_data(text=text, has_photo=has_photo, local_photo=local_photo)

    confirm_kb = kb.get_post_confirm_keyboard()
    if has_photo and local_photo:
        await message.answer_photo(
            FSInputFile(local_photo),
            caption=f"Превью поста:\n\n{text}" if text else "Превью поста:",
            reply_markup=confirm_kb,
        )
    else:
        await message.answer(f"Превью поста:\n\n{text}", reply_markup=confirm_kb)


@router.callback_query(F.data == "confirm_post")
async def confirm_post(callback: CallbackQuery, state: FSMContext, bot):
    if not is_admin(callback.from_user.id):
        return
    data = await state.get_data()
    text = data.get("text", "")
    has_photo = data.get("has_photo", False)
    local_photo = data.get("local_photo")
    await state.clear()

    tg_ok = False
    max_ok = False

    # Post to Telegram channel
    try:
        if has_photo and local_photo and os.path.isfile(local_photo):
            await bot.send_photo(CHANNEL_ID, FSInputFile(local_photo), caption=text or None)
        elif text:
            await bot.send_message(CHANNEL_ID, text)
        tg_ok = True
    except Exception:
        pass

    # Post to Max channel
    max_ok = await _post_to_max_channel(text, local_photo if has_photo else None)

    try:
        await callback.message.delete()
    except Exception:
        pass

    result_text = (
        "Результат публикации:\n\n"
        f"📱 Telegram: {'✅ Опубликовано' if tg_ok else '❌ Ошибка'}\n"
        f"💬 Max: {'✅ Опубликовано' if max_ok else '❌ Ошибка'}"
    )
    await callback.message.answer(result_text, reply_markup=kb.get_admin_menu())


@router.callback_query(F.data == "cancel_post")
async def cancel_post(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    try:
        await callback.message.delete()
    except Exception:
        pass
    await callback.message.answer("Публикация отменена.", reply_markup=kb.get_admin_menu())
