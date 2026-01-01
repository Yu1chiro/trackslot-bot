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
                telegram_id TEXT REFERENCES users(telegram_id),
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
    } catch (e) {
        console.error("Error Telegram:", e.message);
    }
}

const sessionsTimers = new Map();

async function handleTelegramUpdate() {
    let lastUpdateId = 0;
    setInterval(async () => {
        try {
            const res = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
            for (const update of res.data.result) {
                lastUpdateId = update.update_id;
                if (!update.message || !update.message.text) continue;

                const chatId = update.message.chat.id.toString();
                const text = update.message.text.trim().toLowerCase();
                
                const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
                
                if (text === '/start') {
                    await pool.query('UPDATE users SET is_active = TRUE WHERE telegram_id = $1', [chatId]);
                    await sendTelegram(chatId, "✅ *BOT DIAKTIFKAN*\nMonitoring sesi trading aktif.");
                    continue;
                }
                if (text === '/stop') {
                    await pool.query('UPDATE users SET is_active = FALSE WHERE telegram_id = $1', [chatId]);
                    if (sessionsTimers.has(chatId)) {
                        clearInterval(sessionsTimers.get(chatId));
                        sessionsTimers.delete(chatId);
                    }
                    await sendTelegram(chatId, "🛑 *BOT DINONAKTIFKAN*");
                    continue;
                }

                if (userRes.rows.length > 0) {
                    const user = userRes.rows[0];
                    const isWin = text.includes('win');
                    const isLoss = text.includes('loss') || text.includes('lose');

                    if (user.is_active && (isWin || isLoss)) {
                        const amount = parseInt(text.replace(/[^0-9]/g, '')) || 0;
                        const diff = isWin ? amount : -amount;
                        
                        const lastLogRes = await pool.query('SELECT current_balance FROM session_logs WHERE telegram_id = $1 ORDER BY id DESC LIMIT 1', [chatId]);
                        const lastBalance = lastLogRes.rows.length > 0 ? parseInt(lastLogRes.rows[0].current_balance) : parseInt(user.start_balance);
                        const newBalance = lastBalance + diff;

                        await pool.query(
                            'INSERT INTO session_logs (telegram_id, current_balance, profit_loss, status) VALUES ($1, $2, $3, $4)',
                            [chatId, newBalance, diff, isWin ? 'WIN' : 'LOSS']
                        );

                        const sumRes = await pool.query('SELECT SUM(profit_loss) as total FROM session_logs WHERE telegram_id = $1', [chatId]);
                        const netTotal = parseInt(sumRes.rows[0].total) || 0;

                        let responseMsg = `📊 *DATA TERSIMPAN*\n\nStatus: ${isWin ? 'WIN' : 'LOSS'}\nNominal: Rp ${amount.toLocaleString('id-ID')}\nSaldo: Rp ${newBalance.toLocaleString('id-ID')}\nNet Sesi: Rp ${netTotal.toLocaleString('id-ID')}\n\n`;
                        
                        if (netTotal >= parseInt(user.target_win)) {
                            responseMsg += `🏆 *STOP WIN ${user.target_win} TERCAPAI!*\nTarget profit harian Anda sudah terpenuhi. Amankan profit dan istirahatlah!`;
                        } else if (netTotal <= -parseInt(user.stop_loss)) {
                            responseMsg += `🛑 *STOP LOSS ${user.stop_loss} TERCAPAI!*\nBatas kerugian sudah tersentuh. Berhenti sekarang untuk mencegah blunder!`;
                        } else {
                            responseMsg += "Tetap fokus dan disiplin.";
                        }
                        
                        await sendTelegram(chatId, responseMsg);
                    }
                    
                    if (text === 'total') {
                        const sumRes = await pool.query('SELECT SUM(profit_loss) as total FROM session_logs WHERE telegram_id = $1', [chatId]);
                        const netTotal = sumRes.rows[0].total || 0;
                        await sendTelegram(chatId, `📈 *RINGKASAN*\n\n Saldo awal: Rp ${parseInt(user.start_balance).toLocaleString('id-ID')}\n Stop Win: Rp ${parseInt(user.target_win).toLocaleString('id-ID')}\n Stop Loss: Rp ${parseInt(user.stop_loss).toLocaleString('id-ID')}\n Total Net: *Rp ${parseInt(netTotal).toLocaleString('id-ID')}*`);
                        continue;
                    }
                }
            }
        } catch (e) {}
    }, 2500);
}

app.post('/api/start-session', async (req, res) => {
    const { telegramId, interval, startBalance, targetWin, stopLoss } = req.body;
    await pool.query(
        `INSERT INTO users (telegram_id, start_balance, target_win, stop_loss, interval_minutes, is_active) 
         VALUES ($1, $2, $3, $4, $5, TRUE) 
         ON CONFLICT (telegram_id) DO UPDATE SET start_balance=$2, target_win=$3, stop_loss=$4, interval_minutes=$5, is_active=TRUE`,
        [telegramId, startBalance, targetWin, stopLoss, interval]
    );

    if (sessionsTimers.has(telegramId)) clearInterval(sessionsTimers.get(telegramId));
    
    await sendTelegram(telegramId, "✅ *Bot aktif selamat bermain!*");

    const intervalMs = interval * 60000;
    const timer = setInterval(async () => {
        await sendTelegram(telegramId, "🔔 *ALARM UPDATE*\nKetik *Win [angka]* atau *Loss [angka]* untuk mencatat hasil trading saat ini.");
    }, intervalMs);
    
    sessionsTimers.set(telegramId, timer);
    res.json({ success: true });
});

app.get('/api/logs/:telegramId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM session_logs WHERE telegram_id = $1 ORDER BY id DESC', [req.params.telegramId]);
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

app.delete('/api/logs/:telegramId', async (req, res) => {
    await pool.query('DELETE FROM session_logs WHERE telegram_id = $1', [req.params.telegramId]);
    res.json({ success: true });
});

app.post('/api/stop-session', async (req, res) => {
    const { telegramId } = req.body;
    await pool.query('UPDATE users SET is_active = FALSE WHERE telegram_id = $1', [telegramId]);
    if (sessionsTimers.has(telegramId)) {
        clearInterval(sessionsTimers.get(telegramId));
        sessionsTimers.delete(telegramId);
    }
    await sendTelegram(telegramId, "🛑 *TRACKING BERHENTI*");
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/tutor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tutor.html'));
});

const startServer = async () => {
    await initDb();
    handleTelegramUpdate();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
};

startServer();