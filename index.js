const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, child, update, remove } = require('firebase/database');
const axios = require('axios');

// ========================
// 🔑 CONFIGURATION
// ========================
const MASTER_BOT_TOKEN = "8421008411:AAHittWT7bBAuDtB18WWlGwP7eUzX9HyKOk";
const MASTER_ADMIN_ID = "8522410574";

const firebaseConfig = {
    apiKey: "AIzaSyCZsFiggS8phF6XbLj-mkFnsg7wleEHIAs",
    authDomain: "king-maker-bc025.firebaseapp.com",
    projectId: "king-maker-bc025",
    storageBucket: "king-maker-bc025.firebasestorage.app",
    messagingSenderId: "620796558624",
    appId: "1:620796558624:web:f3734be56163586f302b45"
};

// ========================
// 🔥 INITIALIZE FIREBASE
// ========================
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ========================
// 🤖 MULTI-BOT ENGINE
// ========================
const masterBot = new TelegramBot(MASTER_BOT_TOKEN, { polling: true });
const activeBots = {}; // Stores running child bot instances
const userStates = {}; // State manager for master bot (e.g., waiting for token)
const childStates = {}; // State manager for child bots

// Load all active bots on startup
async function loadAllBots() {
    console.log("Loading bots from Firebase...");
    const snapshot = await get(child(ref(db), `bots`));
    if (snapshot.exists()) {
        const bots = snapshot.val();
        for (const [botId, botData] of Object.entries(bots)) {
            if (botData.status === 'active') {
                startChildBot(botId, botData);
            }
        }
    }
    console.log(`Loaded ${Object.keys(activeBots).length} bots successfully.`);
}

// ========================
// 🛠️ CHILD BOT LOGIC
// ========================
function startChildBot(botId, botData) {
    try {
        if (activeBots[botId]) {
            activeBots[botId].stopPolling();
        }

        const bot = new TelegramBot(botData.token, { polling: true });
        activeBots[botId] = bot;
        console.log(`Started child bot: ${botId}`);

        // Handle Child Bot Messages
        bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const text = msg.text;
            const stateKey = `${botId}_${chatId}`;

            // Register User
            const userRef = ref(db, `botUsers/${botId}/${chatId}`);
            const userSnap = await get(userRef);
            if (!userSnap.exists()) {
                await set(userRef, { balance: 0, refers: 0, phone: "", joinedAt: Date.now() });
                // Check if referral code is used
                if (text && text.startsWith('/start ') && text.split(' ')[1] !== chatId.toString()) {
                    const referrerId = text.split(' ')[1];
                    const refUserSnap = await get(ref(db, `botUsers/${botId}/${referrerId}`));
                    if (refUserSnap.exists()) {
                        const refData = refUserSnap.val();
                        await update(ref(db, `botUsers/${botId}/${referrerId}`), {
                            balance: (refData.balance || 0) + (botData.referAmount || 20),
                            refers: (refData.refers || 0) + 1
                        });
                        bot.sendMessage(referrerId, `🎉 New Referral! You earned ${botData.referAmount || 20}`);
                    }
                }
            }

            // Route Commands
            if (text && text.startsWith('/start')) {
                const keyboard = {
                    keyboard: [
                        [{ text: '💰 Balance' }, { text: '👥 Refer' }],
                        [{ text: '🎁 Bonus' }, { text: '🔗 Link Wallet' }],
                        [{ text: '🏧 Withdraw' }]
                    ],
                    resize_keyboard: true
                };
                return bot.sendMessage(chatId, "Welcome to the bot! Choose an option:", { reply_markup: keyboard });
            }

            if (text === '💰 Balance') {
                const uData = (await get(userRef)).val() || { balance: 0 };
                return bot.sendMessage(chatId, `💰 *Your Balance:* ${uData.balance}\n👥 *Total Refers:* ${uData.refers || 0}`, { parse_mode: "Markdown" });
            }

            if (text === '👥 Refer') {
                const me = await bot.getMe();
                return bot.sendMessage(chatId, `🔗 *Your Referral Link:*\nhttps://t.me/${me.username}?start=${chatId}\n\nEarn ${botData.referAmount || 20} per invite!`, { parse_mode: "Markdown" });
            }

            if (text === '🎁 Bonus') {
                const uData = (await get(userRef)).val();
                const now = Date.now();
                const cooldown = 24 * 60 * 60 * 1000;
                if (uData.lastBonus && (now - uData.lastBonus < cooldown)) {
                    return bot.sendMessage(chatId, `⏳ Please wait 24 hours between bonuses.`);
                }
                const bonusAmt = botData.bonus || 5;
                await update(userRef, { balance: (uData.balance || 0) + bonusAmt, lastBonus: now });
                return bot.sendMessage(chatId, `🎉 You received a daily bonus of ${bonusAmt}!`);
            }

            if (text === '🔗 Link Wallet') {
                childStates[stateKey] = { step: 'awaiting_phone' };
                return bot.sendMessage(chatId, "📱 Please enter your Paytm number / wallet account:");
            }

            if (text === '🏧 Withdraw') {
                const liveBotData = (await get(ref(db, `bots/${botId}`))).val();
                if (!liveBotData.apiUrl) return bot.sendMessage(chatId, "❌ Gateway not set by Admin.");
                
                const uData = (await get(userRef)).val();
                if (!uData.phone) return bot.sendMessage(chatId, "❌ Please '🔗 Link Wallet' first.");
                
                childStates[stateKey] = { step: 'awaiting_withdraw_amount', data: { uData, liveBotData } };
                return bot.sendMessage(chatId, `💵 Enter amount to withdraw (Min: ${liveBotData.minWithdraw || 10}, Max: ${liveBotData.maxWithdraw || 100}):`);
            }

            // Handle State Inputs
            if (childStates[stateKey]) {
                const state = childStates[stateKey];
                
                if (state.step === 'awaiting_phone') {
                    await update(userRef, { phone: text });
                    delete childStates[stateKey];
                    return bot.sendMessage(chatId, "✅ Wallet linked successfully!");
                }

                if (state.step === 'awaiting_withdraw_amount') {
                    const amount = parseFloat(text);
                    const { uData, liveBotData } = state.data;
                    delete childStates[stateKey];

                    if (isNaN(amount) || amount < liveBotData.minWithdraw || amount > liveBotData.maxWithdraw) {
                        return bot.sendMessage(chatId, "❌ Invalid amount.");
                    }
                    if (uData.balance < amount) {
                        return bot.sendMessage(chatId, "❌ Insufficient balance.");
                    }

                    // Process API Withdrawal
                    bot.sendMessage(chatId, "⏳ Processing withdrawal...");
                    // Updated finalUrl logic with {wallet}
                    const finalUrl = liveBotData.apiUrl.replace('{wallet}', uData.phone).replace('{amount}', amount);
                    
                    try {
                        const response = await axios.get(finalUrl);
                        if (response.status === 200) {
                            // Deduct and log
                            await update(userRef, { balance: uData.balance - amount });
                            await set(ref(db, `botUsers/${botId}/${chatId}/history/${Date.now()}`), { amount, status: 'success', time: Date.now() });
                            return bot.sendMessage(chatId, "✅ Withdraw Successful!");
                        } else {
                            throw new Error("API Returned non-200");
                        }
                    } catch (error) {
                        return bot.sendMessage(chatId, "❌ Withdrawal failed. Gateway error.");
                    }
                }
                
                // Admin State Inputs (e.g. setting API URL)
                if (state.step === 'awaiting_api_url' && chatId.toString() === botData.ownerId) {
                    await update(ref(db, `bots/${botId}`), { apiUrl: text });
                    delete childStates[stateKey];
                    return bot.sendMessage(chatId, "✅ API Gateway URL updated successfully!");
                }
            }

            // 👨‍💻 ADVANCED ADMIN PANEL
            if (text === '/skadmin' && chatId.toString() === botData.ownerId) {
                const adminKeyboard = {
                    inline_keyboard: [
                        [{ text: '⚙️ Set API Gateway URL', callback_data: 'admin_set_api' }],
                        [{ text: '🎁 Set Bonus Amount', callback_data: 'admin_set_bonus' }, { text: '💸 Set Tax', callback_data: 'admin_set_tax' }],
                        [{ text: '💳 Reset Balances', callback_data: 'admin_reset_all' }, { text: '📊 Verified Stats', callback_data: 'admin_stats' }],
                        [{ text: '🚫 Ban Wallet', callback_data: 'admin_ban_wallet' }, { text: '✅ Unban Wallet', callback_data: 'admin_unban_wallet' }],
                        [{ text: '➕ Add Balance', callback_data: 'admin_add_bal' }, { text: '🏆 Leaderboard', callback_data: 'admin_leaderboard' }]
                    ]
                };
                return bot.sendMessage(chatId, "👨‍💻 *Advanced Admin Panel*\nSelect an option below:", { parse_mode: "Markdown", reply_markup: adminKeyboard });
            }
        });

        // Handle Child Admin Callbacks
        bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const stateKey = `${botId}_${chatId}`;

            // Updated Admin Instruction with {wallet}
            if (query.data === 'admin_set_api') {
                childStates[stateKey] = { step: 'awaiting_api_url' };
                bot.sendMessage(chatId, "🔗 Send the API URL.\nUse `{wallet}` for user Paytm number/wallet and `{amount}` for withdrawal amount.\nExample: `https://site.com/api.php?paytm={wallet}&amount={amount}`");
            } else if (query.data === 'admin_stats') {
                const usersSnap = await get(ref(db, `botUsers/${botId}`));
                const count = usersSnap.exists() ? Object.keys(usersSnap.val()).length : 0;
                bot.sendMessage(chatId, `📊 Total Users: ${count}`);
            }
            // Add remaining admin callback listeners here following the same pattern
            
            bot.answerCallbackQuery(query.id);
        });

    } catch (err) {
        console.error(`Failed to start bot ${botId}:`, err.message);
    }
}

// ========================
// 👑 MASTER BOT MAKER LOGIC
// ========================
masterBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ Add New Bot', callback_data: 'add_bot' }],
                    [{ text: '❌ Remove Existing Bot', callback_data: 'remove_bot' }],
                    [{ text: '🆘 Support', callback_data: 'support' }, { text: '📊 Statics', callback_data: 'stats' }]
                ]
            }
        };
        masterBot.sendMessage(chatId, "🤖 *Welcome to Bot Maker!*\nCreate and manage your own bots dynamically.", { parse_mode: "Markdown", ...options });
    }

    if (text === '/Botmaker99' && chatId.toString() === MASTER_ADMIN_ID) {
        const usersSnap = await get(ref(db, `users`));
        const botsSnap = await get(ref(db, `bots`));
        const userCount = usersSnap.exists() ? Object.keys(usersSnap.val()).length : 0;
        const botCount = botsSnap.exists() ? Object.keys(botsSnap.val()).length : 0;
        
        masterBot.sendMessage(chatId, `🛠 *Bot Maker Admin*\n👥 Total Users: ${userCount}\n🤖 Total Bots: ${botCount}`, { parse_mode: "Markdown" });
    }

    // Handle State for Adding Bot
    if (userStates[chatId] && userStates[chatId].step === 'awaiting_bot_token') {
        const token = text.trim();
        masterBot.sendMessage(chatId, "⏳ Validating token...");
        
        try {
            // Verify token with Telegram API
            const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
            if (response.data.ok) {
                const botInfo = response.data.result;
                const botId = botInfo.id.toString();

                // Check for duplicates
                const existingSnap = await get(ref(db, `bots/${botId}`));
                if (existingSnap.exists()) {
                    return masterBot.sendMessage(chatId, "❌ This bot is already registered in the system.");
                }

                // Save to DB
                const botData = {
                    ownerId: chatId.toString(),
                    token: token,
                    status: 'active',
                    apiUrl: "",
                    minWithdraw: 10,
                    maxWithdraw: 100,
                    bonus: 5,
                    referAmount: 20,
                    createdAt: Date.now()
                };

                await set(ref(db, `bots/${botId}`), botData);
                await update(ref(db, `users/${chatId}/bots/${botId}`), { active: true });
                
                delete userStates[chatId];
                startChildBot(botId, botData);

                masterBot.sendMessage(chatId, `✅ *Bot Created Successfully!*\n\nUsername: @${botInfo.username}\n\nStart your bot and send \`/skadmin\` to access your advanced admin panel. You have been made admin automatically.`, { parse_mode: "Markdown" });
            }
        } catch (err) {
            masterBot.sendMessage(chatId, "❌ Invalid Bot Token. Please try again.");
        }
    }
});

masterBot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'add_bot') {
        userStates[chatId] = { step: 'awaiting_bot_token' };
        masterBot.sendMessage(chatId, "📝 Please forward the HTTP API Token you got from @BotFather:");
    }

    if (data === 'remove_bot') {
        const userBotsSnap = await get(ref(db, `users/${chatId}/bots`));
        if (!userBotsSnap.exists()) {
            return masterBot.sendMessage(chatId, "❌ You don't have any active bots.");
        }
        
        const botsList = Object.keys(userBotsSnap.val());
        const keyboard = botsList.map(id => ([{ text: `🤖 Bot ID: ${id}`, callback_data: `del_${id}` }]));
        
        masterBot.sendMessage(chatId, "Select a bot to remove:", { reply_markup: { inline_keyboard: keyboard } });
    }

    if (data.startsWith('del_')) {
        const botId = data.split('_')[1];
        
        // Stop instance
        if (activeBots[botId]) {
            activeBots[botId].stopPolling();
            delete activeBots[botId];
        }

        // Delete from DB
        await remove(ref(db, `bots/${botId}`));
        await remove(ref(db, `users/${chatId}/bots/${botId}`));
        
        masterBot.sendMessage(chatId, `✅ Bot ${botId} stopped and deleted successfully.`);
    }

    if (data === 'support') {
        masterBot.sendMessage(chatId, `🆘 Contact Developer: tg://user?id=${MASTER_ADMIN_ID}`);
    }

    if (data === 'stats') {
        const userBotsSnap = await get(ref(db, `users/${chatId}/bots`));
        const count = userBotsSnap.exists() ? Object.keys(userBotsSnap.val()).length : 0;
        masterBot.sendMessage(chatId, `📊 *Your Statistics*\n\nBots Created: ${count}`, { parse_mode: "Markdown" });
    }

    masterBot.answerCallbackQuery(query.id);
});

// Boot System
console.log("Starting Bot Maker System...");
loadAllBots();
