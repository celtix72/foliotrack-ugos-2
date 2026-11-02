#!/usr/bin/env node
'use strict';

/**
 * Utility per il reset o l'aggiornamento della password utente in FolioTrack.
 * Utilizzo:
 *   node reset_password.js [username] [nuova_password]
 *
 * Esempio da NAS via Docker:
 *   docker exec -it foliotrack-2 node reset_password.js mauro miaPassword123
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'foliotrack.db');
const username = process.argv[2] || 'mauro';
const newPassword = process.argv[3];

console.log(`📁 Connessione al database: ${dbPath}`);
let db;
try {
    db = new Database(dbPath);
} catch (err) {
    console.error(`❌ Impossibile aprire il database in ${dbPath}:`, err.message);
    process.exit(1);
}

const user = db.prepare('SELECT id, username, email, role FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(username, username);

if (!user) {
    console.error(`❌ Utente "${username}" non trovato nel database.`);
    const allUsers = db.prepare('SELECT id, username, email, role FROM users').all();
    console.log('\n📋 Utenti attualmente registrati:');
    if (allUsers.length === 0) {
        console.log('   (Nessun utente presente nel database)');
    } else {
        allUsers.forEach(u => console.log(`   - ID: ${u.id} | Username: "${u.username}" | Email: "${u.email || '(vuota)'}" | Ruolo: ${u.role}`));
    }
    process.exit(1);
}

if (!newPassword) {
    console.log(`\nℹ️ Utente trovato:`);
    console.log(`   ID: ${user.id}`);
    console.log(`   Username: ${user.username}`);
    console.log(`   Email: ${user.email || '(nessuna)'}`);
    console.log(`   Ruolo: ${user.role}`);
    console.log(`\nPer impostare una nuova password esegui:`);
    console.log(`   node reset_password.js "${user.username}" "la_tua_nuova_password"`);
    process.exit(0);
}

const hash = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);

// Sblocca eventuali IP bloccati per troppi tentativi falliti
try {
    db.prepare('DELETE FROM failed_logins').run();
} catch (e) {}

console.log(`\n✅ Password per "${user.username}" impostata con successo!`);
console.log(`✅ Blocco tentativi falliti azzerato.`);
console.log(`\nOra puoi effettuare l'accesso con:`);
console.log(`   Username: ${user.username}`);
console.log(`   Password: ${newPassword}\n`);
