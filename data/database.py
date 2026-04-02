import os
import aiosqlite
from config import DB_PATH

PRODUCTS_DIR = os.path.join("data", "products")


async def init_db():
    os.makedirs(PRODUCTS_DIR, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        # Enable WAL mode for safe concurrent access from multiple processes
        await db.execute("PRAGMA journal_mode=WAL")

        # Check if migration is needed (users table exists but lacks platform column)
        async with db.execute("PRAGMA table_info(users)") as cursor:
            columns = await cursor.fetchall()
            column_names = [col[1] for col in columns]

        if columns and 'platform' not in column_names:
            # Migrate existing table: add platform column + change to composite PK
            await db.execute("""
                CREATE TABLE users_new (
                    user_id INTEGER NOT NULL,
                    platform TEXT NOT NULL DEFAULT 'telegram',
                    username TEXT,
                    full_name TEXT,
                    phone TEXT,
                    care_priority TEXT,
                    is_waitlist BOOLEAN DEFAULT 0,
                    has_guide BOOLEAN DEFAULT 0,
                    registration_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, platform)
                )
            """)
            await db.execute("""
                INSERT INTO users_new
                    (user_id, platform, username, full_name, phone,
                     care_priority, is_waitlist, has_guide, registration_date)
                SELECT user_id, 'telegram', username, full_name, phone,
                       care_priority, is_waitlist, has_guide, registration_date
                FROM users
            """)
            await db.execute("DROP TABLE users")
            await db.execute("ALTER TABLE users_new RENAME TO users")
        elif not columns:
            # Fresh installation — create with composite PK from the start
            await db.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER NOT NULL,
                    platform TEXT NOT NULL DEFAULT 'telegram',
                    username TEXT,
                    full_name TEXT,
                    phone TEXT,
                    care_priority TEXT,
                    is_waitlist BOOLEAN DEFAULT 0,
                    has_guide BOOLEAN DEFAULT 0,
                    registration_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, platform)
                )
            """)

        # Products table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                description TEXT,
                photo_id TEXT
            )
        """)

        # Settings table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)

        # Insert default products if empty
        async with db.execute("SELECT COUNT(*) FROM products") as cursor:
            count = await cursor.fetchone()
            if count[0] == 0:
                default_products = [
                    ("Пенка", "Очищение безсульфатной нежностью", None),
                    ("Тоник", "Фундамент сияния: аминокислоты", None),
                    ("Сыворотка", "Технология микроигл: ретинол в глубоких слоях", None),
                    ("Крем-флюид", "Антигликация: защита вашего коллагена", None),
                ]
                await db.executemany(
                    "INSERT INTO products (name, description, photo_id) VALUES (?, ?, ?)",
                    default_products,
                )

        await db.commit()


async def get_user(user_id, platform='telegram'):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT * FROM users WHERE user_id = ? AND platform = ?",
            (user_id, platform),
        ) as cursor:
            return await cursor.fetchone()


async def add_user(user_id, username, full_name, platform='telegram'):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO users (user_id, platform, username, full_name) VALUES (?, ?, ?, ?)",
            (user_id, platform, username, full_name),
        )
        await db.commit()


async def update_user_waitlist(user_id, name, priority, phone, platform='telegram'):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET full_name = ?, care_priority = ?, phone = ?, is_waitlist = 1 "
            "WHERE user_id = ? AND platform = ?",
            (name, priority, phone, user_id, platform),
        )
        await db.commit()


async def set_has_guide(user_id, platform='telegram'):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET has_guide = 1 WHERE user_id = ? AND platform = ?",
            (user_id, platform),
        )
        await db.commit()


async def get_all_products():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT * FROM products") as cursor:
            return await cursor.fetchall()


async def update_product(product_id, name, description, photo_id):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE products SET name = ?, description = ?, photo_id = ? WHERE id = ?",
            (name, description, photo_id, product_id),
        )
        await db.commit()


async def add_product(name, description, photo_id) -> int:
    """Insert product and return its new ID."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO products (name, description, photo_id) VALUES (?, ?, ?)",
            (name, description, photo_id),
        )
        await db.commit()
        return cursor.lastrowid


async def delete_product(product_id):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM products WHERE id = ?", (product_id,))
        await db.commit()


async def get_setting(key):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else None


async def set_setting(key, value):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        await db.commit()


async def get_stats():
    """Returns (total, telegram_count, max_count, waitlist, guide)."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM users") as c:
            total = (await c.fetchone())[0]
        async with db.execute(
            "SELECT COUNT(*) FROM users WHERE platform = 'telegram'"
        ) as c:
            tg_count = (await c.fetchone())[0]
        async with db.execute(
            "SELECT COUNT(*) FROM users WHERE platform = 'max'"
        ) as c:
            max_count = (await c.fetchone())[0]
        async with db.execute(
            "SELECT COUNT(*) FROM users WHERE is_waitlist = 1"
        ) as c:
            waitlist = (await c.fetchone())[0]
        async with db.execute(
            "SELECT COUNT(*) FROM users WHERE has_guide = 1"
        ) as c:
            guide = (await c.fetchone())[0]
        return total, tg_count, max_count, waitlist, guide


async def get_all_users():
    """Returns rows: (user_id, username, full_name, phone, care_priority,
                      is_waitlist, has_guide, platform, registration_date)"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT user_id, username, full_name, phone, care_priority, "
            "is_waitlist, has_guide, platform, registration_date FROM users"
        ) as cursor:
            return await cursor.fetchall()


async def get_users_by_category(category):
    """Returns list of (user_id, platform) tuples for the given category."""
    async with aiosqlite.connect(DB_PATH) as db:
        if category == "all":
            query = "SELECT user_id, platform FROM users"
        elif category == "waitlist":
            query = "SELECT user_id, platform FROM users WHERE is_waitlist = 1"
        elif category == "guide":
            query = "SELECT user_id, platform FROM users WHERE has_guide = 1"
        elif category == "none":
            query = "SELECT user_id, platform FROM users WHERE is_waitlist = 0 AND has_guide = 0"
        else:
            return []

        async with db.execute(query) as cursor:
            return await cursor.fetchall()
