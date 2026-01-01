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
    } catch (e) {
        console.error("Error Telegram Send:", e.message);
    }
}

const sessionsTimers = new Map();

async function handleTelegramUpdate() {
    let lastUpdateId = 0;
    // Interval dipercepat ke 1.5 detik untuk respon lebih instan
    setInterval(async () => {
        try {
            const res = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`);
            for (const update of res.data.result) {
                lastUpdateId = update.update_id;
                if (!update.message || !update.message.text) continue;

                const chatId = update.message.chat.id.toString();
                const text = update.message.text.trim().toLowerCase();
                
                const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [chatId]);
                const user = userRes.rows[0];

                if (text === '/start') {
                    await pool.query('INSERT INTO users (telegram_id, is_active) VALUES ($1, TRUE) ON CONFLICT (telegram_id) DO UPDATE SET is_active = TRUE', [chatId]);
                    await sendTelegram(chatId, "✅ *BOT DIAKTIFKAN*\nMonitoring sesi aktif. Pastikan Anda sudah mengatur target di Dashboard.");
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

                if (user) {
                    // Fitur Ringkasan Total
                    if (text === 'total' || text === '/total') {
                        const sumRes = await pool.query('SELECT SUM(profit_loss) as total FROM session_logs WHERE telegram_id = $1', [chatId]);
                        const netTotal = parseInt(sumRes.rows[0].total) || 0;
                        const currentBal = parseInt(user.start_balance) + netTotal;
                        
                        let summary = `📈 *RINGKASAN SESI*\n\n`;
                        summary += `💰 Saldo Awal: *Rp ${parseInt(user.start_balance).toLocaleString('id-ID')}*\n`;
                        summary += `📊 Total Net: *${netTotal >= 0 ? '🟢' : '🔴'} Rp ${netTotal.toLocaleString('id-ID')}*\n`;
                        summary += `🏦 Saldo Saat Ini: *Rp ${currentBal.toLocaleString('id-ID')}*\n\n`;
                        summary += `🎯 Target Win: Rp ${parseInt(user.target_win).toLocaleString('id-ID')}\n`;
                        summary += `📉 Stop Loss: Rp ${parseInt(user.stop_loss).toLocaleString('id-ID')}`;
                        
                        await sendTelegram(chatId, summary);
                        continue;
                    }

                    // Input Win/Loss
                    const isWin = text.includes('win');
                    const isLoss = text.includes('loss') || text.includes('lose');

                    if (user.is_active && (isWin || isLoss)) {
                        const amount = parseInt(text.replace(/[^0-9]/g, '')) || 0;
                        if (amount === 0) continue;

                        const diff = isWin ? amount : -amount;
                        
                        // Hitung Net Total saat ini sebelum insert
                        const currentSumRes = await pool.query('SELECT SUM(profit_loss) as total FROM session_logs WHERE telegram_id = $1', [chatId]);
                        const currentNet = parseInt(currentSumRes.rows[0].total) || 0;
                        
                        const newBalance = parseInt(user.start_balance) + currentNet + diff;

                        await pool.query(
                            'INSERT INTO session_logs (telegram_id, current_balance, profit_loss, status) VALUES ($1, $2, $3, $4)',
                            [chatId, newBalance, diff, isWin ? 'WIN' : 'LOSS']
                        );

                        const netTotal = currentNet + diff;

                        let responseMsg = `📊 *DATA TERSIMPAN*\n\n`;
                        responseMsg += `Status: ${isWin ? '✅ WIN' : '❌ LOSS'}\n`;
                        responseMsg += `Nominal: Rp ${amount.toLocaleString('id-ID')}\n`;
                        responseMsg += `Net Sesi: *Rp ${netTotal.toLocaleString('id-ID')}*\n`;
                        responseMsg += `Saldo: Rp ${newBalance.toLocaleString('id-ID')}\n\n`;
                        
                        if (netTotal >= parseInt(user.target_win) && parseInt(user.target_win) > 0) {
                            responseMsg += `🏆 *TARGET WIN TERCAPAI!*\nProfit: Rp ${netTotal.toLocaleString('id-ID')}\nSegera amankan saldo Anda!`;
                        } else if (netTotal <= -parseInt(user.stop_loss) && parseInt(user.stop_loss) > 0) {
                            responseMsg += `🛑 *STOP LOSS TERCAPAI!*\nMinus: Rp ${netTotal.toLocaleString('id-ID')}\nBerhenti sejenak, jangan paksa trading!`;
                        } else {
                            responseMsg += "Tetap disiplin pada plan.";
                        }
                        
                        await sendTelegram(chatId, responseMsg);
                    }
                }
            }
        } catch (e) {
            console.error("Polling Error:", e.message);
        }
    }, 1500);
}

// API Routes
app.post('/api/start-session', async (req, res) => {
    try {
        const { telegramId, interval, startBalance, targetWin, stopLoss } = req.body;
        await pool.query(
            `INSERT INTO users (telegram_id, start_balance, target_win, stop_loss, interval_minutes, is_active) 
             VALUES ($1, $2, $3, $4, $5, TRUE) 
             ON CONFLICT (telegram_id) DO UPDATE SET start_balance=$2, target_win=$3, stop_loss=$4, interval_minutes=$5, is_active=TRUE`,
            [telegramId, startBalance, targetWin, stopLoss, interval]
        );

        if (sessionsTimers.has(telegramId)) clearInterval(sessionsTimers.get(telegramId));
        
        await sendTelegram(telegramId, "🚀 *SESI DIMULAI*\nBot akan mengingatkan Anda setiap " + interval + " menit.");

        const timer = setInterval(async () => {
            await sendTelegram(telegramId, "🔔 *REMINDER UPDATE*\nBerapa hasil trade terakhir? Ketik: *Win [angka]* atau *Loss [angka]*");
        }, interval * 60000);
        
        sessionsTimers.set(telegramId, timer);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/logs/:telegramId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM session_logs WHERE telegram_id = $1 ORDER BY id DESC', [req.params.telegramId]);
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

app.delete('/api/logs/:telegramId', async (req, res) => {
    try {
        // Menggunakan DELETE dengan Telegram ID untuk membersihkan data spesifik user
        await pool.query('DELETE FROM session_logs WHERE telegram_id = $1', [req.params.telegramId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stop-session', async (req, res) => {
    const { telegramId } = req.body;
    await pool.query('UPDATE users SET is_active = FALSE WHERE telegram_id = $1', [telegramId]);
    if (sessionsTimers.has(telegramId)) {
        clearInterval(sessionsTimers.get(telegramId));
        sessionsTimers.delete(telegramId);
    }
    await sendTelegram(telegramId, "🛑 *SESI BERAKHIR*");
    res.json({ success: true });
});

const startServer = async () => {
    await initDb();
    handleTelegramUpdate();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
};

startServer();