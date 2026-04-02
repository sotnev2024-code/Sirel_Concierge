from aiogram.fsm.state import State, StatesGroup

class WaitlistStates(StatesGroup):
    NAME = State()
    PRIORITY = State()
    PHONE = State()

class AdminStates(StatesGroup):
    NEWSLETTER_TEXT = State()
    NEWSLETTER_CATEGORY = State()
    CHANGE_GUIDE = State()
    ADD_PRODUCT_PHOTO = State()
    ADD_PRODUCT_NAME = State()
    ADD_PRODUCT_DESC = State()
    EDIT_PRODUCT_PHOTO = State()
    EDIT_PRODUCT_NAME = State()
    EDIT_PRODUCT_DESC = State()
    POST_CONTENT = State()
