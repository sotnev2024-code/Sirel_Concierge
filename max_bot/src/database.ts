// Using Node.js built-in SQLite (available since Node 22.5, no native compilation needed)
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.resolve(__dirname, '../../data/bot_database.db');

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for safe concurrent access alongside the Python Telegram bot
db.exec("PRAGMA journal_mode=WAL");

export interface Product {
  id: number;
  name: string;
  description: string;
  photo_id: string | null;
}

export interface UserRow {
  user_id: number;
  platform: string;
  username: string | null;
  full_name: string | null;
  phone: string | null;
  care_priority: string | null;
  is_waitlist: number;
  has_guide: number;
  registration_date: string;
}

export interface Stats {
  total: number;
  tg_count: number;
  max_count: number;
  waitlist: number;
  guide: number;
}

type Row = Record<string, unknown>;

export function getUser(userId: number, platform = 'max'): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE user_id = ? AND platform = ?')
    .get(userId, platform) as unknown as UserRow | undefined;
}

export function addUser(
  userId: number,
  username: string | null,
  fullName: string | null,
  platform = 'max',
): void {
  db.prepare(
    'INSERT OR IGNORE INTO users (user_id, platform, username, full_name) VALUES (?, ?, ?, ?)',
  ).run(userId, platform, username, fullName);
}

export function updateUserWaitlist(
  userId: number,
  name: string,
  priority: string,
  phone: string,
  platform = 'max',
): void {
  db.prepare(
    'UPDATE users SET full_name = ?, care_priority = ?, phone = ?, is_waitlist = 1 '
    + 'WHERE user_id = ? AND platform = ?',
  ).run(name, priority, phone, userId, platform);
}

export function setHasGuide(userId: number, platform = 'max'): void {
  db.prepare(
    'UPDATE users SET has_guide = 1 WHERE user_id = ? AND platform = ?',
  ).run(userId, platform);
}

export function getAllProducts(): Product[] {
  return db.prepare('SELECT * FROM products').all() as unknown as Product[];
}

export function updateProduct(
  productId: number,
  name: string,
  description: string,
  photoId: string | null,
): void {
  db.prepare(
    'UPDATE products SET name = ?, description = ?, photo_id = ? WHERE id = ?',
  ).run(name, description, photoId, productId);
}

export function addProduct(
  name: string,
  description: string,
  photoId: string | null,
): number {
  const result = db.prepare(
    'INSERT INTO products (name, description, photo_id) VALUES (?, ?, ?)',
  ).run(name, description, photoId) as { lastInsertRowid: number };
  return result.lastInsertRowid;
}

export function deleteProduct(productId: number): void {
  db.prepare('DELETE FROM products WHERE id = ?').run(productId);
}

export function getSetting(key: string): string | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as unknown as Row | undefined;
  return row ? String(row['value']) : null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function getStats(): Stats {
  const total = ((db.prepare('SELECT COUNT(*) as c FROM users').get() as unknown as Row)['c'] as number);
  const tg_count = ((db.prepare("SELECT COUNT(*) as c FROM users WHERE platform = 'telegram'").get() as unknown as Row)['c'] as number);
  const max_count = ((db.prepare("SELECT COUNT(*) as c FROM users WHERE platform = 'max'").get() as unknown as Row)['c'] as number);
  const waitlist = ((db.prepare('SELECT COUNT(*) as c FROM users WHERE is_waitlist = 1').get() as unknown as Row)['c'] as number);
  const guide = ((db.prepare('SELECT COUNT(*) as c FROM users WHERE has_guide = 1').get() as unknown as Row)['c'] as number);
  return { total, tg_count, max_count, waitlist, guide };
}

export function getAllUsers(): UserRow[] {
  return db.prepare('SELECT * FROM users').all() as unknown as UserRow[];
}

export interface UserIdPlatform {
  user_id: number;
  platform: string;
}

/** Returns (user_id, platform) pairs for the given broadcast category. */
export function getUsersByCategory(
  category: 'all' | 'waitlist' | 'guide' | 'none',
): UserIdPlatform[] {
  const queries: Record<string, string> = {
    all: 'SELECT user_id, platform FROM users',
    waitlist: 'SELECT user_id, platform FROM users WHERE is_waitlist = 1',
    guide: 'SELECT user_id, platform FROM users WHERE has_guide = 1',
    none: 'SELECT user_id, platform FROM users WHERE is_waitlist = 0 AND has_guide = 0',
  };
  const query = queries[category];
  if (!query) return [];
  return db.prepare(query).all() as unknown as UserIdPlatform[];
}

export default db;
