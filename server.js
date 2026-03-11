const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');

const { exportGroupMembers, getJidsFromFile } = require('./groupUtils');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

let sock;
let groupsCache = [];
let connectionStatus = 'disconnected';

// --- SETTINGS MANAGEMENT ---
const SETTINGS_FILE = './settings.json';
let botSettings = {
    apiKey: '',
    knowledgeBase: '',
    autoReply: false
};

// Load settings on startup
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        botSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading settings file:", e);
    }
}

/**
 * AI Logic: Gemini Integration
 */
async function getAiResponse(userMessage) {
    if (!botSettings.apiKey || !botSettings.autoReply) return null;

    try {
        const genAI = new GoogleGenerativeAI(botSettings.apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
            You are a helpful AI assistant for Quantivo CRM. 
            Use the following Knowledge Base to answer the user politely and professionally. 
            
            Knowledge Base:
            ${botSettings.knowledgeBase}
            
            Instructions:
            - If the answer isn't in the Knowledge Base, say you'll check with the team.
            - Do not mention you are an AI unless asked.
            - Keep responses concise.

            User Question: ${userMessage}
        `;

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("🤖 Gemini Error:", error.message);
        return null;
    }
}

/**
 * WhatsApp Connection Logic
 */
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_store');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, console.log),
        },
        printQRInTerminal: false,
        browser: ["Quantivo CRM", "Chrome", "121.0.0"],
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    // --- AI AUTO-REPLY LISTENER ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' && botSettings.autoReply) {
            for (const msg of m.messages) {
                // Ignore messages from ourselves or status updates
                if (!msg.key.fromMe && msg.message) {
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                    
                    if (text) {
                        console.log(`📩 New message from ${msg.key.remoteJid}: ${text}`);
                        const aiReply = await getAiResponse(text);
                        
                        if (aiReply) {
                            // Optional: Add a small delay to look more human
                            await delay(2000); 
                            await sock.sendMessage(msg.key.remoteJid, { text: aiReply });
                            console.log(`📤 AI Replied to ${msg.key.remoteJid}`);
                        }
                    }
                }
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImageUrl = await qrcode.toDataURL(qr);
            io.emit('qr', qrImageUrl);
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            console.log("✅ WhatsApp Connected (Quantivo Engine Ready)");

            setTimeout(async () => {
                const rawGroups = await sock.groupFetchAllParticipating();
                groupsCache = Object.values(rawGroups).map(g => ({
                    id: g.id,
                    subject: g.subject,
                    memberCount: g.participants ? g.participants.length : 0,
                    rawParticipants: g.participants 
                }));
                io.emit('status', { state: 'connected', groups: groupsCache });
            }, 3000);
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) initWhatsApp();
        }
    });
}

/**
 * API Routes
 */

// Settings Endpoints
app.get('/api/settings', (req, res) => {
    res.json(botSettings);
});

app.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 2));
    res.json({ success: true });
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        const authPath = path.join(__dirname, 'auth_store');
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        
        connectionStatus = 'disconnected';
        groupsCache = [];
        res.json({ success: true });
        setTimeout(() => initWhatsApp(), 1000);
    } catch (err) {
        res.status(500).json({ error: "Logout failed" });
    }
});

// Group Export
app.get('/export/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const allGroups = await sock.groupFetchAllParticipating();
        const group = allGroups[groupId];

        if (group) {
            await exportGroupMembers(group, sock);
            const fileName = `${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;
            const filePath = path.join(__dirname, 'exports', fileName);
            setTimeout(() => res.download(filePath), 500);
        } else {
            res.status(404).send("Group not found.");
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Member Import
app.post('/upload-import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { groupId } = req.body;
    const filePath = req.file.path;

    try {
        const jids = getJidsFromFile(filePath);
        res.json({ success: true, count: jids.length });
        processImports(groupId, jids);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});

/**
 * Background Import Logic
 */
async function processImports(groupId, memberList) {
    const targetList = memberList.slice(0, 188);

    for (let i = 0; i < targetList.length; i++) {
        let jid = targetList[i];
        const isLast = i === targetList.length - 1;

        const wait = Math.floor(Math.random() * (45000 - 30000 + 1)) + 30000;
        io.emit('import-progress', { message: `⏳ Human Delay: ${wait / 1000}s... Adding ${jid}` });
        await delay(wait);

        try {
            const response = await sock.groupParticipantsUpdate(groupId, [jid], "add");
            const status = response[0]?.status;

            if (status === "200") {
                io.emit('import-progress', { status: 'success', message: `✅ Added: ${jid}`, done: isLast });
            } else if (status === "403") {
                io.emit('import-progress', { status: 'warn', message: `⚠️ Privacy: Invite sent to ${jid}`, done: isLast });
            } else {
                io.emit('import-progress', { status: 'error', message: `❌ Status ${status}: ${jid}`, done: isLast });
            }
        } catch (e) {
            io.emit('import-progress', { status: 'error', message: `❌ Request Error: ${e.message}`, done: isLast });
        }
    }
}

io.on('connection', (socket) => {
    if (connectionStatus === 'connected') {
        socket.emit('status', { state: 'connected', groups: groupsCache });
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Quantivo CRM Live: http://localhost:${PORT}`);
    initWhatsApp();
});