require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id TEXT PRIMARY KEY,
                start_balance BIGINT DEFAULT 0,
                target_win BIGINT DEFAULT 0,
                stop_loss BIGINT DEFAULT 0,
                interval_minutes INTEGER DEFAULT 5,
                is_active BOOLEAN DEFAULT FALSE
            );
            CREATE TABLE IF NOT EXISTS session_logs (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT REFERENCES users(telegram_id) ON DELETE CASCADE,
                time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                current_balance BIGINT,
                profit_loss BIGINT,
                status TEXT
            );
        `);
    } finally {
        client.release();
    }
};

async function sendTelegram(chatId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        });
    } catch (e) { console.error("Error Telegram Send:", e.message); }
}

const sessionsTimers = new Map();

async function stopSessiInternal(chatId) {
    await pool.query('UPDATE users SET is_active = FALSE WHERE telegram_id = $1', [chatId]);
    if (sessionsTimers.has(chatId)) {
        clearInterval(sessionsTimers.get(chatId));
        sessionsTimers.delete(chatId);
    }
}

// SOLUSI: Fungsi Polling menggunakan Rekursif untuk mencegah Double Insert
let lastUpdateId = 0;
async function pollTelegram() {
    try {
        const res = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`, {
            params: { offset: lastUpdateId + 1, timeout: 30 }
        });

        for (const update of res.data.result) {
            lastUpdateId = update.update_id; // Update ID segera setelah diterima
            
            if (!update.message || !update.message.text) continue;

            const chatId = update.message.chat.id.toString();
            const text = update.message.text.trim().toLowerCase();
            
            const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
            const user = userRes.rows[0];

            if (text === '/start') {
                await pool.query('INSERT INTO users (telegram_id, is_active) VALUES ($1, TRUE) ON CONFLICT (telegram_id) DO UPDATE SET is_active = TRUE', [chatId]);
                await sendTelegram(chatId, "✅ *BOT AKTIF*");
                continue;
            }

            if (text === '/stop') {
                await stopSessiInternal(chatId);
                await sendTelegram(chatId, "🛑 *SESI BERHENTI*");
                continue;
            }

            if (user) {
                // FITUR TOTAL
                if (text === 'total') {
                    const sumRes = await pool.query('SELECT SUM(profit_loss) as total FROM session_logs WHERE telegram_id = $1', [chatId]);
                    const netTotal = parseInt(sumRes.rows[0].total) || 0;
                    const curBal = parseInt(user.start_balance) + netTotal;
                    
                    await sendTelegram(chatId, 
                        `📈 *RINGKASAN SESI*\n\n` +
                        `💰 Saldo Awal: Rp ${parseInt(user.start_balance).toLocaleString('id-ID')}\n` +
                        `📊 Total Net: *Rp ${netTotal.toLocaleString('id-ID')}*\n` +
                        `🏦 Saldo Akhir: *Rp ${curBal.toLocaleString('id-ID')}*`
                    );
                    continue;
                }

                // INPUT WIN/LOSS
                const isWin = text.includes('win');
                const isLoss = text.includes('loss') || text.includes('lose');

                if (user.is_active && (isWin || isLoss)) {
                    const amount = parseInt(text.replace(/[^0-9]/g, '')) || 0;
                    if (amount === 0) continue;

                    const diff = isWin ? amount : -amount;
                    
                    // Hitung profit saat ini
                    const sumRes = await pool.query('SELECT SUM(profit_loss) as total FROM session_logs WHERE telegram_id = $1', [chatId]);
                    const currentNet = parseInt(sumRes.rows[0].total) || 0;
                    
                    const newNet = currentNet + diff;
                    const newBalance = parseInt(user.start_balance) + newNet;

                    // Simpan Log
                    await pool.query(
                        'INSERT INTO session_logs (telegram_id, current_balance, profit_loss, status) VALUES ($1, $2, $3, $4)',
                        [chatId, newBalance, diff, isWin ? 'WIN' : 'LOSS']
                    );

                    let msg = `📊 *DATA TERSIMPAN*\nNet Profit: *Rp ${newNet.toLocaleString('id-ID')}*\nSaldo: Rp ${newBalance.toLocaleString('id-ID')}\n\n`;
                    
                    // AUTO STOP SESUAI FLOW
                    if (newNet >= parseInt(user.target_win) && parseInt(user.target_win) > 0) {
                        msg += `🏆 *TARGET WIN TERCAPAI!* Sesi otomatis dihentikan.`;
                        await stopSessiInternal(chatId);
                    } else if (newNet <= -parseInt(user.stop_loss) && parseInt(user.stop_loss) > 0) {
                        msg += `🛑 *STOP LOSS TERCAPAI!* Sesi otomatis dihentikan.`;
                        await stopSessiInternal(chatId);
                    }
                    
                    await sendTelegram(chatId, msg);
                }
            }
        }
    } catch (e) { console.error("Polling Error:", e.message); }
    
    // Jalankan lagi setelah selesai memproses (Rekursif)
    setTimeout(pollTelegram, 500); 
}

// API
app.post('/api/start-session', async (req, res) => {
    const { telegramId, interval, startBalance, targetWin, stopLoss } = req.body;
    await pool.query(
        `INSERT INTO users (telegram_id, start_balance, target_win, stop_loss, interval_minutes, is_active) 
         VALUES ($1, $2, $3, $4, $5, TRUE) 
         ON CONFLICT (telegram_id) DO UPDATE SET start_balance=$2, target_win=$3, stop_loss=$4, interval_minutes=$5, is_active=TRUE`,
        [telegramId, startBalance, targetWin, stopLoss, interval]
    );

    if (sessionsTimers.has(telegramId)) clearInterval(sessionsTimers.get(telegramId));
    await sendTelegram(telegramId, "🚀 *ALARM AKTIF*");

    const timer = setInterval(async () => {
        await sendTelegram(telegramId, "🔔 *WAKTUNYA UPDATE*\nKetik *Win [angka]* atau *Loss [angka]*");
    }, interval * 60000);
    
    sessionsTimers.set(telegramId, timer);
    res.json({ success: true });
});

app.get('/api/logs/:telegramId', async (req, res) => {
    const r = await pool.query('SELECT * FROM session_logs WHERE telegram_id = $1 ORDER BY id DESC', [req.params.telegramId]);
    res.json(r.rows);
});

app.delete('/api/logs/:telegramId', async (req, res) => {
    // Menghapus record secara permanen (Clean Database)
    await pool.query('DELETE FROM session_logs WHERE telegram_id = $1', [req.params.telegramId]);
    res.json({ success: true });
});

app.post('/api/stop-session', async (req, res) => {
    await stopSessiInternal(req.body.telegramId);
    res.json({ success: true });
});

const startServer = async () => {
    await initDb();
    pollTelegram(); // Mulai polling secara rekursif
    app.listen(process.env.PORT || 3000, () => console.log('Server Ready'));
};
startServer();