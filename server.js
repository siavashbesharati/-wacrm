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
            // makeCacheableSignalKeyStore is critical for v7 performance
            keys: makeCacheableSignalKeyStore(state.keys, console.log),
        },
        printQRInTerminal: false,
        browser: ["Quantivo CRM", "Chrome", "121.0.0"],
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    // V7 Feature: Listen for new LID <-> Phone Number mappings
    sock.ev.on('lid-mapping.update', (mappings) => {
        for (const map of mappings) {
            console.log(`📡 Mapping Sync: ${map.lid} is now linked to ${map.phoneNumber}`);
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
            console.log("✅ WhatsApp Connected (v7 Engine Ready)");

            setTimeout(async () => {
                const rawGroups = await sock.groupFetchAllParticipating();
                groupsCache = Object.values(rawGroups).map(g => ({
                    id: g.id,
                    subject: g.subject,
                    memberCount: g.participants ? g.participants.length : 0,
                    rawParticipants: g.participants // Kept for groupUtils lookup
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

// LOGOUT: Securely wipe session and credentials
app.post('/logout', async (req, res) => {
    try {
        console.log("🚪 Initiating logout...");
        
        if (sock) {
            await sock.logout();
        }

        const authPath = path.join(__dirname, 'auth_store');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        connectionStatus = 'disconnected';
        groupsCache = [];
        
        res.json({ success: true });

        // Restart to provide a fresh QR code
        setTimeout(() => initWhatsApp(), 1000);
    } catch (err) {
        console.error("Logout Error:", err);
        res.status(500).json({ error: "Failed to logout safely" });
    }
});

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
 * Background Import Logic (v7 Deep Search)
 */
async function processImports(groupId, memberList) {
    const targetList = memberList.slice(0, 188); 

    for (let i = 0; i < targetList.length; i++) {
        let jid = targetList[i];
        const isLast = i === targetList.length - 1;

        // v7 Step: Check if we should use a LID instead of the PN provided
        try {
            if (jid.endsWith('@s.whatsapp.net')) {
                const pn = jid.split('@')[0];
                const lid = await sock.signalRepository.lidMapping.getLIDForPN(pn);
                if (lid) {
                    console.log(`🔄 Mapping found: Using LID ${lid} for ${pn}`);
                    jid = lid;
                }
            }
        } catch (e) { /* No mapping yet */ }

        // Human-like delay (30-45s) to avoid v7 ban triggers
        const wait = Math.floor(Math.random() * (45000 - 30000 + 1)) + 30000;
        io.emit('import-progress', { message: `⏳ Human Delay: ${wait / 1000}s... Adding ${jid}` });
        await delay(wait);

        try {
            const response = await sock.groupParticipantsUpdate(groupId, [jid], "add");

            if (response && response[0]) {
                const status = response[0].status;
                if (status === "200") {
                    io.emit('import-progress', { status: 'success', message: `✅ Added: ${jid}`, done: isLast });
                } else if (status === "403") {
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Privacy: Invite sent to ${jid}`, done: isLast });
                } else {
                    io.emit('import-progress', { status: 'error', message: `❌ Status ${status}: ${jid}`, done: isLast });
                }
            } else {
                io.emit('import-progress', { status: 'error', message: `❌ No response for ${jid}`, done: isLast });
            }
        } catch (e) {
            io.emit('import-progress', { status: 'error', message: `❌ Request Error: ${e.message}`, done: isLast });
        }
    }
}

/**
 * Dashboard Real-time sync
 */
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