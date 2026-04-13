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
// 🤖 MULTI-BOT ENGINE STATE
// ========================
const masterBot = new TelegramBot(MASTER_BOT_TOKEN, { polling: true });
const activeBots = {}; 
const masterStates = {}; 
const childStates = {}; 

// Boot System
async function loadAllBots() {
    console.log("Starting Bot Maker Engine...");
    const snapshot = await get(child(ref(db), `bots`));
    if (snapshot.exists()) {
        const bots = snapshot.val();
        for (const [botId, botData] of Object.entries(bots)) {
            if (botData.status === 'active') {
                startChildBot(botId, botData);
            }
        }
    }
    console.log(`Loaded ${Object.keys(activeBots).length} child bots.`);
}

// ========================
// 🛠️ CHILD BOT LOGIC
// ========================
function startChildBot(botId, botData) {
    try {
        if (activeBots[botId]) activeBots[botId].stopPolling();

        const bot = new TelegramBot(botData.token, { polling: true });
        activeBots[botId] = bot;
        console.log(`Child bot started: ${botId}`);

        bot.on('message', async (msg) => {
            if (!msg.text) return;
            const chatId = msg.chat.id;
            const text = msg.text;
            const stateKey = `${botId}_${chatId}`;

            // Fetch latest live configuration for this bot
            const liveBotSnap = await get(ref(db, `bots/${botId}`));
            const liveBotData = liveBotSnap.exists() ? liveBotSnap.val() : botData;

            // 1. User Registration & Verification
            const userRef = ref(db, `botUsers/${botId}/${chatId}`);
            let userSnap = await get(userRef);
            
            if (!userSnap.exists()) {
                await set(userRef, { balance: 0, refers: 0, phone: "", isBanned: false, joinedAt: Date.now() });
                
                // Handle Referral System
                if (text.startsWith('/start ') && text.split(' ')[1] !== chatId.toString()) {
                    const referrerId = text.split(' ')[1];
                    const refUserSnap = await get(ref(db, `botUsers/${botId}/${referrerId}`));
                    if (refUserSnap.exists()) {
                        const refData = refUserSnap.val();
                        await update(ref(db, `botUsers/${botId}/${referrerId}`), {
                            balance: (refData.balance || 0) + (Number(liveBotData.referAmount) || 20),
                            refers: (refData.refers || 0) + 1
                        });
                        bot.sendMessage(referrerId, `🎉 *New Referral!*\nYou earned ₹${liveBotData.referAmount || 20}.`, { parse_mode: "Markdown" });
                    }
                }
                userSnap = await get(userRef); // Refresh user data
            }

            const uData = userSnap.val();
            if (uData.isBanned) return bot.sendMessage(chatId, "🚫 You are banned from using this bot.");

            // 2. Handle Admin State Inputs First
            if (childStates[stateKey]) {
                const state = childStates[stateKey];
                let handled = true;

                if (state.step === 'awaiting_phone') {
                    await update(userRef, { phone: text });
                    bot.sendMessage(chatId, "✅ Wallet linked successfully!");
                } 
                else if (state.step === 'awaiting_withdraw_amount') {
                    const amount = parseFloat(text);
                    if (isNaN(amount) || amount < liveBotData.minWithdraw || amount > liveBotData.maxWithdraw) {
                        bot.sendMessage(chatId, `❌ Invalid amount. Limit: ₹${liveBotData.minWithdraw} - ₹${liveBotData.maxWithdraw}`);
                    } else if (uData.balance < amount) {
                        bot.sendMessage(chatId, "❌ Insufficient balance.");
                    } else {
                        // API Gateway Processing
                        bot.sendMessage(chatId, "⏳ Processing your withdrawal...");
                        const finalUrl = liveBotData.apiUrl.replace('{number}', uData.phone).replace('{amount}', amount);
                        try {
                            const response = await axios.get(finalUrl);
                            if (response.status === 200) {
                                await update(userRef, { balance: uData.balance - amount });
                                bot.sendMessage(chatId, "💸 Your Withdrawal Paid Successfully !! 💸\n\n🎉 Please Check Your Wallet 🎉");
                            } else throw new Error();
                        } catch (err) {
                            bot.sendMessage(chatId, "❌ Gateway Error: The API is currently unavailable or misconfigured.");
                        }
                    }
                }
                // ADMIN CONFIGURATION STATES
                else if (chatId.toString() === liveBotData.ownerId) {
                    const updates = {};
                    if (state.step === 'awaiting_api') updates.apiUrl = text;
                    if (state.step === 'awaiting_tax') updates.tax = parseFloat(text);
                    if (state.step === 'awaiting_bonus') updates.bonus = parseFloat(text);
                    if (state.step === 'awaiting_min_withdraw') updates.minWithdraw = parseFloat(text);
                    if (state.step === 'awaiting_max_withdraw') updates.maxWithdraw = parseFloat(text);
                    if (state.step === 'awaiting_refer_amount') updates.referAmount = parseFloat(text);
                    if (state.step === 'awaiting_min_refer') updates.minRefer = parseInt(text);

                    if (Object.keys(updates).length > 0) {
                        await update(ref(db, `bots/${botId}`), updates);
                        bot.sendMessage(chatId, "✅ Setting updated successfully!");
                    } else if (state.step === 'awaiting_ban_user') {
                        await update(ref(db, `botUsers/${botId}/${text}`), { isBanned: true });
                        bot.sendMessage(chatId, `✅ User ${text} has been BANNED.`);
                    } else if (state.step === 'awaiting_unban_user') {
                        await update(ref(db, `botUsers/${botId}/${text}`), { isBanned: false });
                        bot.sendMessage(chatId, `✅ User ${text} has been UNBANNED.`);
                    } else if (state.step === 'awaiting_add_bal' || state.step === 'awaiting_deduct_bal') {
                        const [targetId, amtStr] = text.split(' ');
                        const targetAmt = parseFloat(amtStr);
                        const tRef = ref(db, `botUsers/${botId}/${targetId}`);
                        const tSnap = await get(tRef);
                        if (tSnap.exists() && !isNaN(targetAmt)) {
                            const tData = tSnap.val();
                            const newBal = state.step === 'awaiting_add_bal' ? (tData.balance + targetAmt) : Math.max(0, tData.balance - targetAmt);
                            await update(tRef, { balance: newBal });
                            bot.sendMessage(chatId, `✅ Balance updated for ${targetId}. New balance: ₹${newBal}`);
                            bot.sendMessage(targetId, `💰 Your balance was adjusted by the admin. New Balance: ₹${newBal}`);
                        } else {
                            bot.sendMessage(chatId, "❌ Invalid ID or Format. Use: USER_ID AMOUNT");
                        }
                    }
                } else {
                    handled = false;
                }

                if (handled) {
                    delete childStates[stateKey];
                    return;
                }
            }

            // 3. User Commands (Reply Keyboard)
            if (text === '/start' || text.startsWith('/start ')) {
                const keyboard = {
                    keyboard: [[{ text: '💰 Balance' }, { text: '👥 Refer' }], [{ text: '🎁 Bonus' }, { text: '🔗 Link Wallet' }], [{ text: '🏧 Withdraw' }]],
                    resize_keyboard: true
                };
                return bot.sendMessage(chatId, "👋 Welcome to the bot! Select an option below:", { reply_markup: keyboard });
            }

            if (text === '💰 Balance') {
                return bot.sendMessage(chatId, `💰 *Account Balance*\n\n💵 Balance: ₹${uData.balance}\n👥 Total Refers: ${uData.refers || 0}`, { parse_mode: "Markdown" });
            }

            if (text === '👥 Refer') {
                const me = await bot.getMe();
                return bot.sendMessage(chatId, `🔗 *Your Referral Link:*\nhttps://t.me/${me.username}?start=${chatId}\n\n💸 Earn ₹${liveBotData.referAmount || 20} per verified invite!`, { parse_mode: "Markdown" });
            }

            if (text === '🎁 Bonus') {
                const now = Date.now();
                if (uData.lastBonus && (now - uData.lastBonus < 86400000)) {
                    return bot.sendMessage(chatId, `⏳ *Cooldown Active*\nPlease wait 24 hours between bonuses.`, { parse_mode: "Markdown" });
                }
                const bonusAmt = Number(liveBotData.bonus) || 5;
                await update(userRef, { balance: uData.balance + bonusAmt, lastBonus: now });
                return bot.sendMessage(chatId, `🎉 *Daily Bonus Claimed!*\nYou received ₹${bonusAmt}.`, { parse_mode: "Markdown" });
            }

            if (text === '🔗 Link Wallet') {
                childStates[stateKey] = { step: 'awaiting_phone' };
                return bot.sendMessage(chatId, "📌 Please enter your registered number.\n\n🔗 Register link: https://virtual-pocket.vercel.app/");
            }

            if (text === '🏧 Withdraw') {
                if (!liveBotData.apiUrl) return bot.sendMessage(chatId, "❌ Withdrawals are currently disabled (Gateway not set).");
                if (!uData.phone) return bot.sendMessage(chatId, "❌ Please use '🔗 Link Wallet' first.");
                
                const minRef = parseInt(liveBotData.minRefer) || 0;
                if ((uData.refers || 0) < minRef) {
                    return bot.sendMessage(chatId, `❌ *Withdrawal Locked*\nYou need at least ${minRef} referrals for your first withdrawal.\nCurrent Refers: ${uData.refers || 0}`, { parse_mode: "Markdown" });
                }

                childStates[stateKey] = { step: 'awaiting_withdraw_amount' };
                return bot.sendMessage(chatId, `💵 Enter amount to withdraw:\n(Min: ₹${liveBotData.minWithdraw || 10}, Max: ₹${liveBotData.maxWithdraw || 100})`);
            }

            // 4. Admin Command
            if (text === '/skadmin' && chatId.toString() === liveBotData.ownerId) {
                const adminKeyboard = {
                    inline_keyboard: [
                        [{ text: '⚙️ Set API Gateway', callback_data: 'adm_api' }, { text: '💸 Set Tax', callback_data: 'adm_tax' }],
                        [{ text: '🎁 Bonus Amount', callback_data: 'adm_bonus' }, { text: '📢 Add Channel (Soon)', callback_data: 'adm_chan' }],
                        [{ text: '⬇ Min Withdraw', callback_data: 'adm_min_w' }, { text: '⬆ Max Withdraw', callback_data: 'adm_max_w' }],
                        [{ text: '👥 Per Refer Amount', callback_data: 'adm_ref_amt' }, { text: '📉 Min Refer Required', callback_data: 'adm_min_ref' }],
                        [{ text: '📊 Verified Stats', callback_data: 'adm_stats' }, { text: '🏆 Leaderboard', callback_data: 'adm_leader' }],
                        [{ text: '🚫 Ban User', callback_data: 'adm_ban' }, { text: '✅ Unban User', callback_data: 'adm_unban' }],
                        [{ text: '➕ Add Amount', callback_data: 'adm_add' }, { text: '➖ Deduct Amount', callback_data: 'adm_deduct' }],
                        [{ text: '💳 Reset All User Balance', callback_data: 'adm_reset' }]
                    ]
                };
                return bot.sendMessage(chatId, "👨‍💻 *Advanced Admin Control Panel*\nSelect an option to configure your bot:", { parse_mode: "Markdown", reply_markup: adminKeyboard });
            }
        });

        // 5. Admin Callback Handling
        bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const data = query.data;
            const stateKey = `${botId}_${chatId}`;

            const botDataSnap = await get(ref(db, `bots/${botId}`));
            if (!botDataSnap.exists() || chatId.toString() !== botDataSnap.val().ownerId) return;

            const triggerState = (step, msg) => {
                childStates[stateKey] = { step };
                bot.sendMessage(chatId, msg);
            };

            switch (data) {
                case 'adm_api': triggerState('awaiting_api', "🔗 Send the full API URL.\nFormat expected:\n`https://virtual-pocket.vercel.app/api/pay?key=YOURKEY&paytm={number}&amount={amount}`"); break;
                case 'adm_tax': triggerState('awaiting_tax', "💸 Send the tax percentage for withdrawals (e.g. 5 for 5%):"); break;
                case 'adm_bonus': triggerState('awaiting_bonus', "🎁 Send the daily bonus amount:"); break;
                case 'adm_min_w': triggerState('awaiting_min_withdraw', "⬇ Send the Minimum Withdrawal Amount:"); break;
                case 'adm_max_w': triggerState('awaiting_max_withdraw', "⬆ Send the Maximum Withdrawal Amount:"); break;
                case 'adm_ref_amt': triggerState('awaiting_refer_amount', "👥 Send the amount to reward per referral:"); break;
                case 'adm_min_ref': triggerState('awaiting_min_refer', "📉 Send the Minimum Referrals required for first withdraw:"); break;
                case 'adm_ban': triggerState('awaiting_ban_user', "🚫 Send the User ID to Ban:"); break;
                case 'adm_unban': triggerState('awaiting_unban_user', "✅ Send the User ID to Unban:"); break;
                case 'adm_add': triggerState('awaiting_add_bal', "➕ Send the User ID and Amount separated by space.\nExample: `12345678 50`"); break;
                case 'adm_deduct': triggerState('awaiting_deduct_bal', "➖ Send the User ID and Amount separated by space.\nExample: `12345678 50`"); break;
                
                case 'adm_stats':
                    const uSnap = await get(ref(db, `botUsers/${botId}`));
                    const users = uSnap.exists() ? Object.keys(uSnap.val()).length : 0;
                    bot.sendMessage(chatId, `📊 *Bot Statistics*\nTotal Registered Users: ${users}`, { parse_mode: "Markdown" });
                    break;
                case 'adm_leader':
                    const lSnap = await get(ref(db, `botUsers/${botId}`));
                    if (lSnap.exists()) {
                        const allUsers = Object.entries(lSnap.val()).map(([id, data]) => ({ id, refers: data.refers || 0 })).sort((a, b) => b.refers - a.refers).slice(0, 10);
                        let msg = "🏆 *Top 10 Referrers*\n\n";
                        allUsers.forEach((u, i) => { msg += `${i+1}. ID: ${u.id} - ${u.refers} Refers\n`; });
                        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
                    }
                    break;
                case 'adm_reset':
                    bot.sendMessage(chatId, "⏳ Resetting all balances to 0...");
                    const rSnap = await get(ref(db, `botUsers/${botId}`));
                    if (rSnap.exists()) {
                        const updates = {};
                        Object.keys(rSnap.val()).forEach(uid => { updates[`${uid}/balance`] = 0; });
                        await update(ref(db, `botUsers/${botId}`), updates);
                        bot.sendMessage(chatId, "✅ All user balances have been reset to 0.");
                    }
                    break;
            }
            bot.answerCallbackQuery(query.id);
        });

    } catch (err) {
        console.error(`Error starting child bot ${botId}:`, err);
    }
}

// ========================
// 👑 MASTER BOT LOGIC
// ========================
const replyKeyboardOpts = {
    reply_markup: {
        keyboard: [[{ text: '➕ Add New Bot' }, { text: '❌ Remove Bot' }], [{ text: '🆘 Support' }, { text: '📊 Statics' }]],
        resize_keyboard: true
    }
};

masterBot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
        return masterBot.sendMessage(chatId, "👑 *Welcome to King Maker Bot Engine*\n\nUse the buttons below to control your bots.", { parse_mode: "Markdown", ...replyKeyboardOpts });
    }

    // Handle Token Input State
    if (masterStates[chatId] && masterStates[chatId].step === 'awaiting_token') {
        const token = text.trim();
        masterBot.sendMessage(chatId, "⏳ Validating API Token...");
        try {
            const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
            if (response.data.ok) {
                const botInfo = response.data.result;
                const botId = botInfo.id.toString();

                const existingSnap = await get(ref(db, `bots/${botId}`));
                if (existingSnap.exists()) return masterBot.sendMessage(chatId, "❌ This bot is already deployed.");

                const botData = {
                    ownerId: chatId.toString(),
                    token: token,
                    status: 'active',
                    apiUrl: "",
                    minWithdraw: 10,
                    maxWithdraw: 100,
                    bonus: 5,
                    referAmount: 20,
                    minRefer: 0,
                    createdAt: Date.now()
                };

                await set(ref(db, `bots/${botId}`), botData);
                await update(ref(db, `users/${chatId}/bots/${botId}`), { active: true });
                
                delete masterStates[chatId];
                startChildBot(botId, botData);

                const successMsg = `🎊 BOT DEPLOYED SUCCESSFULLY!\n━━━━━━━━━━━━━━━━━━━━\n\n🚀 Your bot is now LIVE\n\n⚙️ NEXT STEPS:\n1️⃣ Open your bot @${botInfo.username} and send /start\n2️⃣ Send /skadmin inside your bot to set it up\n3️⃣ Start your work with the bot!`;
                return masterBot.sendMessage(chatId, successMsg);
            }
        } catch (err) {
            return masterBot.sendMessage(chatId, "❌ Invalid Bot Token. Please ensure it is correct and try again.");
        }
    }

    if (text === '➕ Add New Bot') {
        masterStates[chatId] = { step: 'awaiting_token' };
        return masterBot.sendMessage(chatId, "✨ KING MAKER\n\n1️⃣ Go to @BotFather\n2️⃣ Create a new bot\n3️⃣ Copy the API Token\n4️⃣ Send the token here.");
    }

    if (text === '❌ Remove Bot') {
        const userBotsSnap = await get(ref(db, `users/${chatId}/bots`));
        if (!userBotsSnap.exists()) return masterBot.sendMessage(chatId, "❌ You have no active bots.");
        
        const botsList = Object.keys(userBotsSnap.val());
        const inlineKb = botsList.map(id => ([{ text: `🛑 Delete Bot ID: ${id}`, callback_data: `rm_${id}` }]));
        masterBot.sendMessage(chatId, "Select the bot you want to permanently delete:", { reply_markup: { inline_keyboard: inlineKb } });
    }

    if (text === '🆘 Support') {
        masterBot.sendMessage(chatId, `🛠 *Need Help?*\n\nContact the Administrator: tg://user?id=${MASTER_ADMIN_ID}`, { parse_mode: "Markdown" });
    }

    if (text === '📊 Statics') {
        const userBotsSnap = await get(ref(db, `users/${chatId}/bots`));
        const count = userBotsSnap.exists() ? Object.keys(userBotsSnap.val()).length : 0;
        masterBot.sendMessage(chatId, `📊 *Your Statistics*\n\nActive Bots: ${count}`, { parse_mode: "Markdown" });
    }
});

// Master Bot Callbacks (For Deleting)
masterBot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('rm_')) {
        const botId = data.split('_')[1];
        if (activeBots[botId]) {
            activeBots[botId].stopPolling();
            delete activeBots[botId];
        }
        await remove(ref(db, `bots/${botId}`));
        await remove(ref(db, `users/${chatId}/bots/${botId}`));
        masterBot.sendMessage(chatId, `✅ Bot ${botId} deleted successfully.`);
    }
    masterBot.answerCallbackQuery(query.id);
});

loadAllBots();
