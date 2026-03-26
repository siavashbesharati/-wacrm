const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');

const { exportGroupMembers, getJidsFromFile, toNormalizedPhone, extractPhoneFromParticipant } = require('./groupUtils');

// Prevent crash on uncaught errors (log instead of exit)
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

let sock;
let groupsCache = [];
let connectionStatus = 'disconnected';
let syncTimer = null;
let initInProgress = false;

/**
 * ایجاد پوشه صادرات
 */
const exportDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir);

async function initWhatsApp() {
    if (initInProgress) return;
    initInProgress = true;

    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
    const oldSock = sock;
    sock = null;
    if (oldSock?.ws) {
        try { oldSock.ws.close(); } catch (_) {}
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_store');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys),
        },
        printQRInTerminal: false,
        browser: ["Quantivo CRM", "Chrome", "121.0.0"],
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    // v7: lid-mapping.update — new LID/PN mappings when detected
    sock.ev.on('lid-mapping.update', (mapping) => {
        if (mapping) console.log('📋 LID/PN mapping updated:', Object.keys(mapping).slice(0, 3).join(', '), '...');
    });

    // رویداد دریافت تاریخچه (اگر زودتر از یک دقیقه برسد، کش را پر می‌کند)
    sock.ev.on('messaging-history.set', (data) => {
        const groups = data.groups || []; // اگر گروهی نبود، یک آرایه خالی در نظر بگیر

        if (groups.length > 0) {
            const mappedGroups = groups.map(g => ({
                id: g.id,
                subject: g.subject || 'No Name',
                memberCount: g.participants ? g.participants.length : 0,
                rawParticipants: g.participants || []
            }));

            // جلوگیری از تکرار و آپدیت کش
            groupsCache = [...new Map([...groupsCache, ...mappedGroups].map(item => [item.id, item])).values()];
            console.log(`📥 History received: ${groupsCache.length} groups.`);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImageUrl = await qrcode.toDataURL(qr);
            io.emit('qr', qrImageUrl);
            connectionStatus = 'qr_ready';
        }

        if (connection === 'open') {
            connectionStatus = 'syncing';
            console.log("🔗 Socket Connected. Starting 60s mandatory sync...");

            // Clear any previous timer
            if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }

            let timeLeft = 60;
            syncTimer = setInterval(() => {
                timeLeft--;
                io.emit('status', {
                    state: 'syncing',
                    message: `🔄 System is synchronizing. Please wait ${timeLeft}s...`,
                    progress: Math.round(((60 - timeLeft) / 60) * 100)
                });

                if (timeLeft <= 0) {
                    clearInterval(syncTimer);
                    syncTimer = null;
                    finalizeSync();
                }
            }, 1000);
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                const authPath = path.join(__dirname, 'auth_store');
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                setTimeout(() => initWhatsApp(), 3000);
            } else {
                initWhatsApp();
            }
        }
    });

    // تابع نهایی سازی سینک بعد از یک دقیقه
    async function finalizeSync() {
        console.log("⏰ 60s Timeout reached. Finalizing group list...");
        try {
            // اگر دیتای هیستوری کامل نیامده، دستی واکشی می‌کنیم
            if (groupsCache.length === 0) {
                const rawGroups = await sock.groupFetchAllParticipating();
                groupsCache = Object.values(rawGroups).map(g => ({
                    id: g.id,
                    subject: g.subject || 'No Name',
                    memberCount: g.participants ? g.participants.length : 0,
                    rawParticipants: g.participants || []
                }));
            }

            connectionStatus = 'ready';
            console.log(`✅ System Ready. ${groupsCache.length} groups loaded.`);
            io.emit('status', {
                state: 'ready',
                message: 'Connected & Synced',
                groups: groupsCache
            });
        } catch (err) {
            console.error("Manual fetch failed:", err);
            // حتی اگر خطا خورد، وضعیت را آماده می‌کنیم تا کاربر در منو گیر نکند
            connectionStatus = 'ready';
            io.emit('status', { state: 'ready', message: 'Connected (Limited Data)', groups: groupsCache });
        }
    }

    } catch (err) {
        console.error("initWhatsApp error:", err);
    } finally {
        initInProgress = false;
    }
}

// --- API ROUTES (عیناً مشابه کد قبلی شما) ---
app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        const authPath = path.join(__dirname, 'auth_store');
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        connectionStatus = 'disconnected';
        groupsCache = [];
        res.json({ success: true });
        setTimeout(() => initWhatsApp(), 2000);
    } catch (err) { res.status(500).json({ error: "Logout failed" }); }
});

app.get('/export/:groupId', async (req, res) => {
    if (connectionStatus !== 'ready') return res.status(503).send("Wait for sync...");
    const group = groupsCache.find(g => g.id === req.params.groupId);
    if (group) {
        const groupWithParticipants = { ...group, participants: group.rawParticipants || group.participants || [] };
        await exportGroupMembers(groupWithParticipants, sock);
        const fileName = `${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;
        res.download(path.join(exportDir, fileName));
    }
});

app.post('/upload-import', upload.single('file'), async (req, res) => {
    if (connectionStatus !== 'ready') return res.status(503).json({ error: "System not ready" });
    const jids = getJidsFromFile(req.file.path);
    res.json({ success: true, count: jids.length });
    processImports(req.body.groupId, jids);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
});

async function processImports(groupId, importList) {
    try {
        // ─── Step 1: Normalize Excel values to digits-only phone numbers ────────
        // Handles: "989112523756", "989112523756@s.whatsapp.net", "+98 911 252 3756"
        const normalizedPhones = importList
            .map(entry => toNormalizedPhone(entry))
            .filter(p => p.length > 5); // drop empty/bad rows
        const uniqueFromFile = [...new Set(normalizedPhones)]; // dedupe Excel rows

        io.emit('import-progress', {
            message: `📋 Loaded ${uniqueFromFile.length} numbers from file.`
        });

        // ─── Step 2: Fetch LIVE group members — compare by phone number only ───
        io.emit('import-progress', { message: `🔄 Fetching current group members from WhatsApp...` });

        let existingPhones = new Set();
        try {
            const groupMeta = await sock.groupMetadata(groupId);
            const liveParticipants = groupMeta.participants || [];
            existingPhones = new Set(liveParticipants.map(extractPhoneFromParticipant).filter(Boolean));
            io.emit('import-progress', {
                message: `👥 Group has ${liveParticipants.length} members. Comparing by phone number.`
            });
        } catch (metaErr) {
            console.warn("Live fetch failed, falling back to cache:", metaErr.message);
            const group = groupsCache.find(g => g.id === groupId);
            if (!group) {
                io.emit('import-progress', { status: 'error', message: "🚨 Group not found in cache either." });
                return;
            }
            const cachedParticipants = group.rawParticipants || group.participants || [];
            existingPhones = new Set(cachedParticipants.map(extractPhoneFromParticipant).filter(Boolean));
            io.emit('import-progress', {
                message: `⚠️ Using cached data: ${existingPhones.size} members.`
            });
        }

        // ─── Step 3: Filter out existing members (phone vs phone comparison) ─────
        const toAdd = uniqueFromFile.filter(phone => !existingPhones.has(phone));
        const skippedCount = uniqueFromFile.length - toAdd.length;

        const target = toAdd.slice(0, 150);

        io.emit('import-progress', {
            message: `🔍 Filter Report: ${skippedCount} already in group (by phone), ${target.length} new to add.`
        });

        if (target.length === 0) {
            io.emit('import-progress', { message: "✅ Nothing new to add. Done!", done: true });
            return;
        }

        // ─── Step 4: Add members one by one ───────────────────────────────────
        for (let i = 0; i < target.length; i++) {
            const phone = target[i];
            // JID format: digits only, no + - ( ) — e.g. 989120674032@s.whatsapp.net
            const rawJid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
            const isLast = i === target.length - 1;

            const wait = Math.floor(Math.random() * 5001) + 5000; // 5–10 seconds
            io.emit('import-progress', {
                message: `⏳ Cooldown: ${Math.round(wait / 1000)}s | Adding: ${phone}`,
                current: i + 1,
                total: target.length
            });

            await delay(wait);

            try {
                // 1. Verify number exists on WhatsApp and get validated JID (avoids "not recognized" issues)
                const onWa = await sock.onWhatsApp(phone);
                const result = Array.isArray(onWa) ? onWa[0] : onWa;
                if (!result?.exists) {
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Not on WhatsApp: ${phone}`, done: isLast });
                    console.log(`📵 onWhatsApp check failed for ${phone}:`, onWa);
                    continue;
                }
                const jidToAdd = result.jid || rawJid;

                // 2. Add using verified JID
                const response = await sock.groupParticipantsUpdate(groupId, [jidToAdd], "add");
                console.log(`📦 Raw response for ${phone}:`, JSON.stringify(response));

                // Parse [ { jid, status: '200'|'403'|'408'|'409'|... } ]
                const entry = Array.isArray(response) ? response[0] : Object.values(response || {})[0];
                const status = String(entry?.status ?? entry?.attrs?.code ?? entry?.content?.[0]?.attrs?.code ?? '');
                const respJid = entry?.jid || jidToAdd;

                console.log(`📊 Status for ${phone}: "${status}" | jid: ${respJid}`);

                if (status === "200") {
                    io.emit('import-progress', { status: 'success', message: `✅ Added: ${phone}`, done: isLast });
                } else if (status === "403") {
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Privacy restricted (403) — add manually: ${phone}`, done: isLast });
                } else if (status === "409") {
                    io.emit('import-progress', { status: 'info', message: `ℹ️ Already a member: ${phone}`, done: isLast });
                } else if (status === "404" || status === "408") {
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Not on WhatsApp / recently left (${status}): ${phone}`, done: isLast });
                } else {
                    const rawLog = JSON.stringify(response);
                    console.log(`⚠️ Unknown response for ${phone}: status="${status}" jid="${respJid}" | full:`, rawLog);
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Unknown (${status || 'empty'}) — check manually: ${phone}`, done: isLast });
                }

            } catch (e) {
                console.error(`Error adding ${phone}:`, e.message, e?.output);
                if (e.message?.includes('403') || e?.output?.statusCode === 403) {
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Privacy block — add manually: ${phone}`, done: isLast });
                } else {
                    io.emit('import-progress', { status: 'error', message: `🚨 Error for ${phone}: ${e.message}`, done: isLast });
                }
            }

            // 5-minute anti-ban break every 12 additions
            if ((i + 1) % 12 === 0 && !isLast) {
                io.emit('import-progress', { message: "☕ Anti-Ban Break: Resting 5 minutes..." });
                await delay(300000);
            }
        }

    } catch (err) {
        console.error("Critical Import Error:", err);
        io.emit('import-progress', { status: 'error', message: "🚨 Fatal error in import process." });
    }
}

io.on('connection', (socket) => socket.emit('status', { state: connectionStatus, groups: groupsCache }));

server.listen(3000, () => {
    console.log(`🚀 Server ready on http://localhost:3000`);
    initWhatsApp();
});