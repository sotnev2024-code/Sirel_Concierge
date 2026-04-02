import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
MAX_BOT_TOKEN = os.getenv("MAX_BOT_TOKEN")
ADMIN_IDS = [int(admin_id) for admin_id in os.getenv("ADMIN_IDS", "").split(",") if admin_id]
CHANNEL_ID = os.getenv("CHANNEL_ID")
CHANNEL_URL = os.getenv("CHANNEL_URL")
MAX_CHANNEL_ID = os.getenv("MAX_CHANNEL_ID")
MAX_GROUP_CHAT_ID = os.getenv("MAX_GROUP_CHAT_ID", "").strip().strip('"').strip("'")
DB_PATH = os.path.join("data", "bot_database.db")

# Эквайринг (Т-Банк / универсальное подключение): терминал и пароль из кабинета «Терминалы».
# Для Telegram Payments отдельно нужен provider_token из @BotFather — это не то же самое.
PAYMENT_TERMINAL_ID = os.getenv("PAYMENT_TERMINAL_ID", "").strip()
PAYMENT_TERMINAL_PASSWORD = os.getenv("PAYMENT_TERMINAL_PASSWORD", "").strip()
