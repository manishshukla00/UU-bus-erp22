/*
 * Lost the admin password? Run:  npm run reset-admin
 * Sets a new random password for "admin" (or the one in ADMIN_PASSWORD) and prints it.
 * The admin must choose a new password at the next sign-in. Works on the local database, or on
 * Turso when TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set.
 */
import { createTables, get, batch, run, now, closeDb, dbKind } from '../server/db.js';
import { hashPassword, generatePassword } from '../server/security.js';

console.log(`Database: ${dbKind()}`);
await createTables();

const password = process.env.ADMIN_PASSWORD || generatePassword(16);
const t = now();
const admin = await get('SELECT id FROM users WHERE username = ?', 'admin');
if (admin) {
  // new password, unlocked, and signed out everywhere
  await batch([
    ['UPDATE users SET password_hash = ?, role = ?, active = 1, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(password), 'admin', t, admin.id],
    ['DELETE FROM sessions WHERE user_id = ?', admin.id],
  ]);
} else {
  await run('INSERT INTO users(username, name, role, password_hash, active, must_change_password, created_at, updated_at) VALUES(?, ?, ?, ?, 1, 1, ?, ?)', 'admin', 'Administrator', 'admin', hashPassword(password), t, t);
}
console.log(`\nadmin password reset.\n  username: admin\n  password: ${password}\n(you must change it at first sign-in)\n`);
await closeDb();
