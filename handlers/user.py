import os
from typing import Optional
from aiogram import Router, F, types
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message, FSInputFile
from data import database as db
from keyboards import keyboards as kb
from states.states import WaitlistStates
from config import CHANNEL_ID
from aiogram.utils.keyboard import InlineKeyboardBuilder

router = Router()

WELCOME_TEXT = (
    "Добро пожаловать!\n\n"
    "Вы прикоснулись к миру Sirel. Мы создаем косметику для женщин, "
    "которые ценят качество и уверены в результате. До официального запуска "
    "нашей коллекции из 4-х продуктов осталось совсем немного времени. Рады, что вы с нами."
)

@router.message(Command("start"))
async def cmd_start(message: Message):
    await db.add_user(message.from_user.id, message.from_user.username, message.from_user.full_name)
    await message.answer(WELCOME_TEXT, reply_markup=kb.get_main_menu())

@router.callback_query(F.data == "back_to_main")
async def back_to_main(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    if callback.message.photo:
        await callback.message.delete()
        await callback.message.answer(WELCOME_TEXT, reply_markup=kb.get_main_menu())
    else:
        await callback.message.edit_text(WELCOME_TEXT, reply_markup=kb.get_main_menu())

# --- Waitlist ---
@router.callback_query(F.data == "join_waitlist")
async def join_waitlist(callback: CallbackQuery, state: FSMContext):
    user_data = await db.get_user(callback.from_user.id)
    if user_data and user_data[6]:  # is_waitlist is at index 6 (platform column added at index 1)
        await callback.answer("Вы уже записаны в лист ожидания!", show_alert=True)
        return

    await callback.message.edit_text(
        "Первая партия Sirel будет строго лимитирована. Участницы списка получат доступ к заказу "
        "на 24 часа раньше официального старта. Чтобы мы закрепили за вами статус "
        "привилегированного клиента, ответьте на 2 вопроса.\n\n"
        "Как нам к вам обращаться?",
        reply_markup=None # InlineKeyboardBuilder().button(text="Отмена", callback_data="back_to_main").as_markup()
    )
    await state.set_state(WaitlistStates.NAME)

@router.message(WaitlistStates.NAME)
async def waitlist_name(message: Message, state: FSMContext):
    await state.update_data(name=message.text)
    await message.answer(
        "Какую задачу в уходе вы считаете приоритетной? (Это поможет нам подготовить персональные советы)",
        reply_markup=kb.get_priority_keyboard()
    )
    await state.set_state(WaitlistStates.PRIORITY)

@router.callback_query(WaitlistStates.PRIORITY, F.data.startswith("priority:"))
async def waitlist_priority(callback: CallbackQuery, state: FSMContext):
    priority_map = {
        "elasticity": "Упругость и лифтинг",
        "glow": "Сияние и тон",
        "cleansing": "Глубокое очищение и обновление"
    }
    priority_key = callback.data.split(":")[1]
    priority_text = priority_map.get(priority_key, priority_key)
    await state.update_data(priority=priority_text)
    
    data = await state.get_data()
    await callback.message.answer(
        f"Благодарим, {data['name']}! Вы в списке. Нажмите на кнопку ниже, чтобы отправить номер телефона "
        "для получения SMS-уведомления в момент открытия предзаказа.",
        reply_markup=kb.get_phone_keyboard()
    )
    await callback.message.delete()
    await state.set_state(WaitlistStates.PHONE)

@router.message(WaitlistStates.PHONE, F.contact)
async def waitlist_phone(message: Message, state: FSMContext):
    phone = message.contact.phone_number
    data = await state.get_data()
    await db.update_user_waitlist(message.from_user.id, data['name'], data['priority'], phone)
    await message.answer(
        f"Спасибо! Вы успешно записаны в лист ожидания. Мы свяжемся с вами!",
        reply_markup=types.ReplyKeyboardRemove()
    )
    await message.answer(WELCOME_TEXT, reply_markup=kb.get_main_menu())
    await state.clear()

def _photo_input(photo_id: Optional[str]):
    """Return FSInputFile for a local path, None otherwise.
    Ignores max_token: entries (Max-only photos with no local file)."""
    if photo_id and not photo_id.startswith('max_token:') and os.path.isfile(photo_id):
        return FSInputFile(photo_id)
    return None


# --- Products Carousel ---
@router.callback_query(F.data == "view_products")
async def view_products(callback: CallbackQuery):
    products = await db.get_all_products()
    if not products:
        await callback.answer("Продукты пока не добавлены.", show_alert=True)
        return

    product = products[0]
    text = f"<b>{product[1]}</b>\n\n{product[2]}"
    keyboard = kb.get_carousel_keyboard(0, len(products))
    photo = _photo_input(product[3])

    if photo:
        await callback.message.delete()
        await callback.message.answer_photo(
            photo=photo, caption=text, reply_markup=keyboard, parse_mode="HTML"
        )
    else:
        await callback.message.edit_text(text, reply_markup=keyboard, parse_mode="HTML")


@router.callback_query(F.data.startswith("product_nav:"))
async def product_nav(callback: CallbackQuery):
    index = int(callback.data.split(":")[1])
    products = await db.get_all_products()
    product = products[index]
    text = f"<b>{product[1]}</b>\n\n{product[2]}"
    keyboard = kb.get_carousel_keyboard(index, len(products))
    photo = _photo_input(product[3])

    if callback.message.photo:
        if photo:
            await callback.message.edit_media(
                media=types.InputMediaPhoto(media=photo, caption=text, parse_mode="HTML"),
                reply_markup=keyboard,
            )
        else:
            await callback.message.delete()
            await callback.message.answer(text, reply_markup=keyboard, parse_mode="HTML")
    else:
        if photo:
            await callback.message.delete()
            await callback.message.answer_photo(
                photo=photo, caption=text, reply_markup=keyboard, parse_mode="HTML"
            )
        else:
            await callback.message.edit_text(text, reply_markup=keyboard, parse_mode="HTML")

# --- Guide ---
@router.callback_query(F.data == "get_guide")
async def get_guide(callback: CallbackQuery):
    await callback.message.edit_text(
        "Чтобы получить гайд, пожалуйста, подпишитесь на наш канал.",
        reply_markup=kb.get_sub_check_keyboard()
    )

@router.callback_query(F.data == "check_sub")
async def check_sub(callback: CallbackQuery, bot):
    try:
        user_channel_status = await bot.get_chat_member(chat_id=CHANNEL_ID, user_id=callback.from_user.id)
        if user_channel_status.status != "left":
            guide_file_id = await db.get_setting("guide_file_id")
            guide_local = os.path.join("data", "guide.pdf")

            # Всегда отдаём локальный guide.pdf (тот же файл, что и в Max). Старый file_id мог указывать на другую версию.
            if os.path.isfile(guide_local):
                sent = await callback.message.answer_document(
                    FSInputFile(guide_local), caption="Ваш гайд по активам!"
                )
                if sent and sent.document:
                    await db.set_setting("guide_file_id", sent.document.file_id)
            elif guide_file_id:
                sent = await callback.message.answer_document(
                    guide_file_id, caption="Ваш гайд по активам!"
                )
                if sent and sent.document:
                    await db.set_setting("guide_file_id", sent.document.file_id)
            else:
                await callback.answer("Гайд еще не загружен администратором.", show_alert=True)
                return

            await db.set_has_guide(callback.from_user.id)
            await callback.answer("Гайд отправлен!", show_alert=True)
        else:
            await callback.answer("Вы не подписаны на канал.", show_alert=True)
    except Exception:
        await callback.answer("Ошибка проверки подписки. Убедитесь, что бот является администратором канала.", show_alert=True)

@router.callback_query(F.data == "noop")
async def noop(callback: CallbackQuery):
    await callback.answer()
