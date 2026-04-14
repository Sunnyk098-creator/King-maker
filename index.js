const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, child, update, remove } = require('firebase/database');
const axios = require('axios');

// ========================
// 🔑 CONFIGURATION
// ========================
const MASTER_BOT_TOKEN = "8421008411:AAErexxRlg20aYZIbAOpldXI3YNOySRspWY";
const MASTER_ADMIN_ID = "8522410574";

// 🌐 UNIVERSAL VERIFY URL (Sabhi bots yahi use karenge)
const GLOBAL_VERIFY_URL = "https://yourdomain.com/verify"; // Yahan apna webapp link daal dena

const firebaseConfig = {
    apiKey: "AIzaSyCZsFiggS8phF6XbLj-mkFnsg7wleEHIAs",
    authDomain: "king-maker-bc025.firebaseapp.com",
    projectId: "king-maker-bc025",
    storageBucket: "king-maker-bc025.firebasestorage.app",
    messagingSenderId: "620796558624",
    appId: "1:620796558624:web:f3734be56163586f302b45"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

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
            startChildBot(botId, botData);
        }
    }
    console.log(`Loaded ${Object.keys(activeBots).length} child bots.`);
}

// Helper Function for checking channels
async function checkUserChannels(bot, channels, userId) {
    if (!channels) return true;
    for (const channel of Object.values(channels)) {
        try {
            const member = await bot.getChatMember(channel, userId);
            if (!['member', 'administrator', 'creator'].includes(member.status)) return false;
        } catch (err) { return false; }
    }
    return true;
}

// ========================
// 🛠️ CHILD BOT LOGIC
// ========================
function startChildBot(botId, botData) {
    try {
        if (activeBots[botId]) activeBots[botId].stopPolling();

        const bot = new TelegramBot(botData.token, { polling: true });
        activeBots[botId] = bot;
        console.log(`Child bot started: ${botId} (@${botData.username})`);

        // Helper: Show Admin Keyboard (Removed "Set Verify URL")
        const showAdminKeyboard = (chatId, liveBotData, message = "👨‍💻 *Advanced Admin Control Panel*") => {
            const botStatus = liveBotData.status === 'off' ? '🔴' : '🟢';
            const wdStatus = liveBotData.withdrawStatus === 'off' ? '🔴' : '🟢';
            const verStatus = liveBotData.verificationStatus === 'on' ? '🟢' : '🔴';
            
            const adminKb = {
                keyboard: [
                    [{ text: `🤖 Bot ${botStatus}` }, { text: `💸 Withdraw ${wdStatus}` }],
                    [{ text: `🛡 Verification ${verStatus}` }, { text: '⚙️ Set API Gateway' }],
                    [{ text: '💸 Set Tax' }, { text: '📢 Add Channel' }],
                    [{ text: '🎁 Bonus Amount' }, { text: '⬇ Min Withdraw' }],
                    [{ text: '⬆ Max Withdraw' }, { text: '👥 Per Refer Amount' }],
                    [{ text: '📉 Min Refer Required' }, { text: '📊 Verified Stats' }],
                    [{ text: '🏆 Leaderboard' }, { text: '🚫 Ban User' }],
                    [{ text: '✅ Unban User' }, { text: '💳 Reset All User Balance' }],
                    [{ text: '👨‍💻 Manage Admins' }, { text: '➕ Add Amount' }],
                    [{ text: '➖ Deduct Amount' }, { text: '🔙 Exit Admin Panel' }]
                ],
                resize_keyboard: true
            };
            bot.sendMessage(chatId, message, { parse_mode: "Markdown", reply_markup: adminKb });
        };

        bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const stateKey = `${botId}_${chatId}`;
            const now = Date.now();

            const liveBotSnap = await get(ref(db, `bots/${botId}`));
            const liveBotData = liveBotSnap.exists() ? liveBotSnap.val() : botData;

            const isOwner = liveBotData.ownerId === chatId.toString();
            const isSubAdmin = liveBotData.admins && liveBotData.admins[chatId.toString()];
            const isAdmin = isOwner || isSubAdmin;

            const userRef = ref(db, `botUsers/${botId}/${chatId}`);
            let userSnap = await get(userRef);
            
            if (!userSnap.exists()) {
                await set(userRef, { balance: 0, refers: 0, phone: "", isBanned: false, referred: false, invitedBy: null, joinedAt: now, lastAction: now, isVerified: false });
                userSnap = await get(userRef);
            }

            const uData = userSnap.val();

            if (now - (uData.lastAction || 0) < 1000) return;
            await update(userRef, { lastAction: now });

            if (uData.isBanned) return bot.sendMessage(chatId, "🚫 You are banned from using this bot.");

            if (liveBotData.status === 'off' && !isAdmin) {
                return bot.sendMessage(chatId, "Bot is currently off 🙇🏻");
            }

            // ==========================================
            // 🔐 DEVICE VERIFICATION HANDLER
            // ==========================================
            if (msg.web_app_data) {
                const deviceId = msg.web_app_data.data; 
                bot.sendMessage(chatId, "⏳ Checking Verification Status...");

                const joined = await checkUserChannels(bot, liveBotData.channels, chatId);
                if (!joined) return bot.sendMessage(chatId, "❌ Please join all channels first!");

                const deviceRef = ref(db, `botDevices/${botId}/${deviceId}`);
                const deviceSnap = await get(deviceRef);

                const mainKb = { keyboard: [[{ text: '💰 Balance' }, { text: '👥 Refer' }], [{ text: '🎁 Bonus' }, { text: '🔗 Link Wallet' }], [{ text: '🏧 Withdraw' }]], resize_keyboard: true };

                if (deviceSnap.exists() && deviceSnap.val().usedBy !== chatId) {
                    // SAME DEVICE DETECTED
                    bot.sendMessage(chatId, "⚠️ *Same Device Detected!*\nYou are allowed to use the bot, but referral bonus has been blocked for this device.", { parse_mode: "Markdown", reply_markup: mainKb });
                    await update(userRef, { isVerified: true, fakeDevice: true });
                } else {
                    // NEW DEVICE DETECTED
                    await set(deviceRef, { usedBy: chatId, timestamp: now });
                    await update(userRef, { isVerified: true });

                    if (uData.invitedBy && !uData.referred) {
                        const referrerId = uData.invitedBy;
                        const refUserSnap = await get(ref(db, `botUsers/${botId}/${referrerId}`));
                        if (refUserSnap.exists()) {
                            await update(ref(db, `botUsers/${botId}/${referrerId}`), {
                                balance: (refUserSnap.val().balance || 0) + (Number(liveBotData.referAmount) || 20),
                                refers: (refUserSnap.val().refers || 0) + 1
                            });
                            bot.sendMessage(referrerId, `🎉 *New Verified Referral!*\nYou earned ₹${liveBotData.referAmount || 20}.`, { parse_mode: "Markdown" });
                        }
                        await update(userRef, { referred: true });
                    }
                    bot.sendMessage(chatId, "✅ Verification Successful! Welcome.", { reply_markup: mainKb });
                }
                return;
            }

            if (!msg.text) return;
            const text = msg.text;

            // ==========================================
            // 👨‍💻 ADMIN PANEL HANDLER
            // ==========================================
            if (isAdmin) {
                if (text === '/skadmin') return showAdminKeyboard(chatId, liveBotData);

                if (text.startsWith('🤖 Bot ')) {
                    const newStatus = text.includes('🟢') ? 'off' : 'on';
                    await update(ref(db, `bots/${botId}`), { status: newStatus });
                    return showAdminKeyboard(chatId, { ...liveBotData, status: newStatus }, `✅ Bot is now ${newStatus.toUpperCase()}`);
                }
                if (text.startsWith('💸 Withdraw ')) {
                    const newStatus = text.includes('🟢') ? 'off' : 'on';
                    await update(ref(db, `bots/${botId}`), { withdrawStatus: newStatus });
                    return showAdminKeyboard(chatId, { ...liveBotData, withdrawStatus: newStatus }, `✅ Withdrawals are now ${newStatus.toUpperCase()}`);
                }
                if (text.startsWith('🛡 Verification ')) {
                    const newStatus = text.includes('🟢') ? 'off' : 'on';
                    await update(ref(db, `bots/${botId}`), { verificationStatus: newStatus });
                    return showAdminKeyboard(chatId, { ...liveBotData, verificationStatus: newStatus }, `✅ Verification is now ${newStatus.toUpperCase()}`);
                }

                if (text === '🔙 Exit Admin Panel') {
                    const kb = { keyboard: [[{ text: '💰 Balance' }, { text: '👥 Refer' }], [{ text: '🎁 Bonus' }, { text: '🔗 Link Wallet' }], [{ text: '🏧 Withdraw' }]], resize_keyboard: true };
                    return bot.sendMessage(chatId, "👋 Exited Admin Panel.", { reply_markup: kb });
                }

                const adminCommands = {
                    '⚙️ Set API Gateway': ['awaiting_api', '🔗 Send the API URL.\nFormat: `https://virtual-pocket.vercel.app/api/pay?key=YOUR_API_KEY&paytm={number}&amount={amount}`'],
                    '💸 Set Tax': ['awaiting_tax', '💸 Send tax percentage (e.g. 5):'],
                    '🎁 Bonus Amount': ['awaiting_bonus', '🎁 Send daily bonus amount:'],
                    '📢 Add Channel': ['awaiting_channel', '📢 Send channel username (e.g., @mychannel):'],
                    '⬇ Min Withdraw': ['awaiting_min_withdraw', '⬇ Send Min Withdrawal Amount:'],
                    '⬆ Max Withdraw': ['awaiting_max_withdraw', '⬆ Send Max Withdrawal Amount:'],
                    '👥 Per Refer Amount': ['awaiting_refer_amount', '👥 Send reward per referral:'],
                    '📉 Min Refer Required': ['awaiting_min_refer', '📉 Send Min Referrals required for first withdraw:'],
                    '🚫 Ban User': ['awaiting_ban_user', '🚫 Send User ID to Ban:'],
                    '✅ Unban User': ['awaiting_unban_user', '✅ Send User ID to Unban:'],
                    '➕ Add Amount': ['awaiting_add_bal', '➕ Send User ID and Amount (e.g., 1234 50):'],
                    '➖ Deduct Amount': ['awaiting_deduct_bal', '➖ Send User ID and Amount (e.g., 1234 50):']
                };

                if (adminCommands[text]) {
                    childStates[stateKey] = { step: adminCommands[text][0] };
                    return bot.sendMessage(chatId, adminCommands[text][1], { parse_mode: "Markdown" });
                }

                // ... (Other admin commands remain same)
                if (text === '📊 Verified Stats') {
                    const uSnap = await get(ref(db, `botUsers/${botId}`));
                    return bot.sendMessage(chatId, `📊 Total Users: ${uSnap.exists() ? Object.keys(uSnap.val()).length : 0}`);
                }
                if (text === '🏆 Leaderboard') {
                    const lSnap = await get(ref(db, `botUsers/${botId}`));
                    if (!lSnap.exists()) return bot.sendMessage(chatId, "No users yet.");
                    const topUsers = Object.entries(lSnap.val()).map(([id, d]) => ({ id, refers: d.refers || 0 })).sort((a, b) => b.refers - a.refers).slice(0, 10);
                    let msg = "🏆 *Top Referrers*\n\n";
                    topUsers.forEach((u, i) => msg += `${i+1}. ID: ${u.id} - ${u.refers} Refers\n`);
                    return bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
                }
                if (text === '💳 Reset All User Balance') {
                    bot.sendMessage(chatId, "⏳ Resetting balances...");
                    const rSnap = await get(ref(db, `botUsers/${botId}`));
                    if (rSnap.exists()) {
                        const updates = {};
                        Object.keys(rSnap.val()).forEach(uid => updates[`${uid}/balance`] = 0);
                        await update(ref(db, `botUsers/${botId}`), updates);
                        return bot.sendMessage(chatId, "✅ All balances reset to 0.");
                    }
                }
                if (text === '👨‍💻 Manage Admins' && isOwner) { 
                    const ikb = { inline_keyboard: [[{ text: '➕ Add Admin', callback_data: 'add_admin' }, { text: '❌ Remove Admin', callback_data: 'rem_admin' }], [{ text: '📋 Admin List', callback_data: 'list_admins' }]] };
                    return bot.sendMessage(chatId, "👨‍💻 *Admin Management*", { parse_mode: "Markdown", reply_markup: ikb });
                }
            }

            // ==========================================
            // STATE HANDLER (Admin Inputs)
            // ==========================================
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
                        bot.sendMessage(chatId, "⏳ Processing your withdrawal...");
                        const finalUrl = liveBotData.apiUrl
                            .replace('{number}', uData.phone)
                            .replace('{wallet}', uData.phone) 
                            .replace('{amount}', amount);
                            
                        try {
                            const response = await axios.get(finalUrl);
                            if (response.status === 200) {
                                await update(userRef, { balance: uData.balance - amount });
                                bot.sendMessage(chatId, "💸 Your Withdrawal Paid Successfully !! 💸\n\n🎉 Please Check Your Wallet 🎉");
                            } else throw new Error();
                        } catch (err) {
                            bot.sendMessage(chatId, "❌ Gateway Error: The API is currently unavailable or returned an error.");
                        }
                    }
                }
                else if (isAdmin) {
                    const updates = {};
                    if (state.step === 'awaiting_api') updates.apiUrl = text;
                    if (state.step === 'awaiting_tax') updates.tax = parseFloat(text);
                    if (state.step === 'awaiting_bonus') updates.bonus = parseFloat(text);
                    if (state.step === 'awaiting_min_withdraw') updates.minWithdraw = parseFloat(text);
                    if (state.step === 'awaiting_max_withdraw') updates.maxWithdraw = parseFloat(text);
                    if (state.step === 'awaiting_refer_amount') updates.referAmount = parseFloat(text);
                    if (state.step === 'awaiting_min_refer') updates.minRefer = parseInt(text);

                    if (state.step === 'awaiting_channel') {
                        await set(ref(db, `bots/${botId}/channels/${Date.now()}`), text);
                        bot.sendMessage(chatId, `✅ Channel ${text} added to force join.`);
                    } else if (Object.keys(updates).length > 0) {
                        await update(ref(db, `bots/${botId}`), updates);
                        bot.sendMessage(chatId, "✅ Setting updated successfully!");
                    } else if (state.step === 'awaiting_ban_user') {
                        await update(ref(db, `botUsers/${botId}/${text}`), { isBanned: true });
                        bot.sendMessage(chatId, `✅ User ${text} BANNED.`);
                    } else if (state.step === 'awaiting_unban_user') {
                        await update(ref(db, `botUsers/${botId}/${text}`), { isBanned: false });
                        bot.sendMessage(chatId, `✅ User ${text} UNBANNED.`);
                    } else if (state.step === 'awaiting_add_admin' && isOwner) {
                        await set(ref(db, `bots/${botId}/admins/${text}`), true);
                        bot.sendMessage(chatId, `✅ Admin ${text} Added.`);
                    } else if (state.step === 'awaiting_remove_admin' && isOwner) {
                        await remove(ref(db, `bots/${botId}/admins/${text}`));
                        bot.sendMessage(chatId, `✅ Admin ${text} Removed.`);
                    } else if (state.step === 'awaiting_add_bal' || state.step === 'awaiting_deduct_bal') {
                        const [targetId, amtStr] = text.split(' ');
                        const targetAmt = parseFloat(amtStr);
                        const tRef = ref(db, `botUsers/${botId}/${targetId}`);
                        const tSnap = await get(tRef);
                        if (tSnap.exists() && !isNaN(targetAmt)) {
                            const newBal = state.step === 'awaiting_add_bal' ? (tSnap.val().balance + targetAmt) : Math.max(0, tSnap.val().balance - targetAmt);
                            await update(tRef, { balance: newBal });
                            bot.sendMessage(chatId, `✅ Balance updated. New balance: ₹${newBal}`);
                            bot.sendMessage(targetId, `💰 Balance adjusted by admin. New: ₹${newBal}`);
                        } else {
                            bot.sendMessage(chatId, "❌ Invalid format. Use: USER_ID AMOUNT");
                        }
                    }
                } else { handled = false; }

                if (handled) { delete childStates[stateKey]; return; }
            }

            // ==========================================
            // USER FLOW & FORCE JOIN
            // ==========================================
            const sendForceJoinMenu = async () => {
                let ikb = [];
                if (liveBotData.channels) {
                    Object.values(liveBotData.channels).forEach(ch => {
                        ikb.push([{ text: `📢 Join ${ch}`, url: `https://t.me/${ch.replace('@', '')}` }]);
                    });
                }

                if (liveBotData.verificationStatus === 'on') {
                    // Start Verification Flow Callback Trigger
                    ikb.push([{ text: '✅ Verify Device & Channels', callback_data: 'start_verification_flow' }]);
                    bot.sendMessage(chatId, "📢 Please join all required channels, then click Verify to continue.", { reply_markup: { inline_keyboard: ikb } });
                } else {
                    ikb.push([{ text: '✅ I have Joined', callback_data: 'check_joined_fallback' }]);
                    bot.sendMessage(chatId, "📢 Please join all required channels and click below to continue.", { reply_markup: { inline_keyboard: ikb } });
                }
            };

            if (!isAdmin && liveBotData.channels) {
                const joined = await checkUserChannels(bot, liveBotData.channels, chatId);
                if (!joined || !uData.isVerified) return sendForceJoinMenu();
            }

            if (text === '/start' || text.startsWith('/start ')) {
                if (text.startsWith('/start ') && text.split(' ')[1] !== chatId.toString() && !uData.referred && !uData.invitedBy) {
                    const referrerId = text.split(' ')[1];
                    await update(userRef, { invitedBy: referrerId });
                }

                const keyboard = { keyboard: [[{ text: '💰 Balance' }, { text: '👥 Refer' }], [{ text: '🎁 Bonus' }, { text: '🔗 Link Wallet' }], [{ text: '🏧 Withdraw' }]], resize_keyboard: true };
                return bot.sendMessage(chatId, "👋 Welcome to the bot!", { reply_markup: keyboard });
            }

            if (text === '💰 Balance') return bot.sendMessage(chatId, `💰 *Account Balance*\n\n💵 Balance: ₹${uData.balance}\n👥 Total Refers: ${uData.refers || 0}`, { parse_mode: "Markdown" });
            
            // HTML parser fix for referral link
            if (text === '👥 Refer') {
                const refLink = `https://t.me/${liveBotData.username}?start=${chatId}`;
                return bot.sendMessage(chatId, `🔗 <b>Your Referral Link:</b>\n${refLink}\n\n💸 Earn ₹${liveBotData.referAmount || 20} per invite!`, { parse_mode: "HTML" });
            }

            if (text === '🎁 Bonus') {
                if (uData.lastBonus && (now - uData.lastBonus < 86400000)) return bot.sendMessage(chatId, `⏳ Please wait 24 hours between bonuses.`);
                const bonusAmt = Number(liveBotData.bonus) || 5;
                await update(userRef, { balance: uData.balance + bonusAmt, lastBonus: now });
                return bot.sendMessage(chatId, `🎉 You received ₹${bonusAmt}!`);
            }

            if (text === '🔗 Link Wallet') {
                childStates[stateKey] = { step: 'awaiting_phone' };
                return bot.sendMessage(chatId, "📌 Please enter your Phone/PayTM number:");
            }

            if (text === '🏧 Withdraw') {
                if (liveBotData.withdrawStatus === 'off') return bot.sendMessage(chatId, "Withdraw is currently disabled ❌");
                if (!liveBotData.apiUrl) return bot.sendMessage(chatId, "❌ Gateway not set.");
                if (!uData.phone) return bot.sendMessage(chatId, "❌ Please '🔗 Link Wallet' first.");
                
                const minRef = parseInt(liveBotData.minRefer) || 0;
                if ((uData.refers || 0) < minRef) return bot.sendMessage(chatId, `❌ You need at least ${minRef} referrals for first withdrawal.`);

                childStates[stateKey] = { step: 'awaiting_withdraw_amount' };
                return bot.sendMessage(chatId, `💵 Enter amount (Min: ₹${liveBotData.minWithdraw || 10}, Max: ₹${liveBotData.maxWithdraw || 100})`);
            }
        });

        // Child Bot Callbacks
        bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const stateKey = `${botId}_${chatId}`;
            const data = query.data;

            const snap = await get(ref(db, `bots/${botId}`));
            if (!snap.exists()) return;
            const liveBotData = snap.val();

            // Web App Verification Reply Keyboard Trigger
            if (data === 'start_verification_flow') {
                const joined = await checkUserChannels(bot, liveBotData.channels, chatId);
                if (!joined) return bot.sendMessage(chatId, "❌ Please join all channels first!");

                const verifyKb = {
                    keyboard: [[{ text: '🚀 Start Verification', web_app: { url: GLOBAL_VERIFY_URL } }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                };
                
                bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                return bot.sendMessage(chatId, "Click on Start Verification for your verification 👇", { reply_markup: verifyKb });
            }

            // Fallback Channel Verification
            if (data === 'check_joined_fallback') {
                const joined = await checkUserChannels(bot, liveBotData.channels, chatId);
                
                if (!joined) {
                    bot.sendMessage(chatId, "❌ Please join all channels first!");
                } else {
                    bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                    await update(ref(db, `botUsers/${botId}/${chatId}`), { isVerified: true, verifiedAt: Date.now() });

                    const uSnap = await get(ref(db, `botUsers/${botId}/${chatId}`));
                    const uData = uSnap.val();
                    if (uData.invitedBy && !uData.referred) {
                        const referrerId = uData.invitedBy;
                        const refUserSnap = await get(ref(db, `botUsers/${botId}/${referrerId}`));
                        if (refUserSnap.exists()) {
                            await update(ref(db, `botUsers/${botId}/${referrerId}`), {
                                balance: (refUserSnap.val().balance || 0) + (Number(liveBotData.referAmount) || 20),
                                refers: (refUserSnap.val().refers || 0) + 1
                            });
                            bot.sendMessage(referrerId, `🎉 *New Referral!*\nYou earned ₹${liveBotData.referAmount || 20}.`, { parse_mode: "Markdown" });
                        }
                        await update(ref(db, `botUsers/${botId}/${chatId}`), { referred: true });
                    }
                    
                    const mainKb = { keyboard: [[{ text: '💰 Balance' }, { text: '👥 Refer' }], [{ text: '🎁 Bonus' }, { text: '🔗 Link Wallet' }], [{ text: '🏧 Withdraw' }]], resize_keyboard: true };
                    bot.sendMessage(chatId, "✅ Joined successfully! Welcome.", { reply_markup: mainKb });
                }
            }

            // Sub-Admin Management Inline Callbacks
            if (chatId.toString() === liveBotData.ownerId) {
                if (data === 'add_admin') {
                    childStates[stateKey] = { step: 'awaiting_add_admin' };
                    bot.sendMessage(chatId, "➕ Send the Telegram User ID to add as Admin:");
                } else if (data === 'rem_admin') {
                    childStates[stateKey] = { step: 'awaiting_remove_admin' };
                    bot.sendMessage(chatId, "❌ Send the Telegram User ID to remove from Admins:");
                } else if (data === 'list_admins') {
                    const admins = liveBotData.admins ? Object.keys(liveBotData.admins) : [];
                    bot.sendMessage(chatId, `📋 *Admin List:*\nOwner: ${liveBotData.ownerId}\nSub-Admins:\n${admins.join('\n') || 'None'}`, { parse_mode: "Markdown" });
                }
            }
            bot.answerCallbackQuery(query.id);
        });

    } catch (err) { console.error(`Error starting ${botId}:`, err); }
}

// ========================
// 👑 MASTER BOT LOGIC
// ========================
const mKb = { reply_markup: { keyboard: [[{ text: '➕ Add New Bot' }, { text: '❌ Remove Bot' }], [{ text: '🆘 Support' }, { text: '📊 Statics' }]], resize_keyboard: true } };

masterBot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') return masterBot.sendMessage(chatId, "👑 *Welcome to King Maker Bot Engine*", { parse_mode: "Markdown", ...mKb });

    if (masterStates[chatId] && masterStates[chatId].step === 'awaiting_token') {
        const token = text.trim();
        masterBot.sendMessage(chatId, "⏳ Deploying...");
        try {
            const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
            if (response.data.ok) {
                const botId = response.data.result.id.toString();
                const existingSnap = await get(ref(db, `bots/${botId}`));
                if (existingSnap.exists()) return masterBot.sendMessage(chatId, "❌ Bot already deployed.");

                const botData = {
                    ownerId: chatId.toString(), token, status: 'on', withdrawStatus: 'on', verificationStatus: 'off',
                    username: response.data.result.username, 
                    apiUrl: "", minWithdraw: 10, maxWithdraw: 100, bonus: 5, referAmount: 20, minRefer: 0,
                    createdAt: Date.now()
                };

                await set(ref(db, `bots/${botId}`), botData);
                await update(ref(db, `users/${chatId}/bots/${botId}`), { active: true });
                
                delete masterStates[chatId];
                startChildBot(botId, botData);

                return masterBot.sendMessage(chatId, `🎊 BOT DEPLOYED SUCCESSFULLY!\n━━━━━━━━━━━━━━━━━━━━\n\n🚀 Your bot is now LIVE\n\n⚙️ NEXT STEPS:\n1️⃣ Open @${response.data.result.username} and send /start\n2️⃣ Send /skadmin to set it up.`);
            }
        } catch (err) { return masterBot.sendMessage(chatId, "❌ Invalid Token."); }
    }

    if (text === '➕ Add New Bot') {
        masterStates[chatId] = { step: 'awaiting_token' };
        return masterBot.sendMessage(chatId, "✨ KING MAKER\n1️⃣ Go to @BotFather\n2️⃣ Create a new bot\n3️⃣ Copy the API Token\n4️⃣ Send the token here.");
    }
    if (text === '❌ Remove Bot') {
        const userBotsSnap = await get(ref(db, `users/${chatId}/bots`));
        if (!userBotsSnap.exists()) return masterBot.sendMessage(chatId, "❌ You have no bots.");
        const ikb = Object.keys(userBotsSnap.val()).map(id => ([{ text: `🛑 Delete Bot ID: ${id}`, callback_data: `rm_${id}` }]));
        masterBot.sendMessage(chatId, "Select bot to delete:", { reply_markup: { inline_keyboard: ikb } });
    }
    if (text === '🆘 Support') masterBot.sendMessage(chatId, `🛠 Contact: tg://user?id=${MASTER_ADMIN_ID}`);
    if (text === '📊 Statics') {
        const uSnap = await get(ref(db, `users/${chatId}/bots`));
        masterBot.sendMessage(chatId, `📊 Bots: ${uSnap.exists() ? Object.keys(uSnap.val()).length : 0}`);
    }
});

masterBot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    if (query.data.startsWith('rm_')) {
        const botId = query.data.split('_')[1];
        if (activeBots[botId]) { activeBots[botId].stopPolling(); delete activeBots[botId]; }
        await remove(ref(db, `bots/${botId}`));
        await remove(ref(db, `users/${chatId}/bots/${botId}`));
        masterBot.sendMessage(chatId, `✅ Bot ${botId} deleted.`);
    }
    masterBot.answerCallbackQuery(query.id);
});

loadAllBots();
