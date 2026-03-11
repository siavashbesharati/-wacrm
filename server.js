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
    makeCacheableSignalKeyStore, // Added for v7 security
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
 * WhatsApp Connection Logic (v7 Optimized)
 */
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_store');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            // v7 uses a cacheable store for faster Signal handshakes
            keys: makeCacheableSignalKeyStore(state.keys, console.log),
        },
        printQRInTerminal: false,
        // v7 recommends a specific browser version to avoid LID-only constraints
        browser: ["Quantivo CRM", "Chrome", "121.0.0"],
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        // Keeps the connection alive more reliably in v7
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    // V7 Event: Listen for new LID <-> Phone Number mappings
    sock.ev.on('lid-mapping.update', (mappings) => {
        for (const map of mappings) {
            console.log(`📡 New Mapping Learned: LID ${map.lid} is PN ${map.phoneNumber}`);
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
            console.log("✅ WhatsApp Connected (v7 Protocol Active)");

            setTimeout(async () => {
                const rawGroups = await sock.groupFetchAllParticipating();

                // v7: participants now often contain 'id' (LID) and 'phoneNumber' (PN)
                groupsCache = Object.values(rawGroups).map(g => ({
                    id: g.id,
                    subject: g.subject,
                    memberCount: g.participants ? g.participants.length : 0,
                    // We pass the full participants array to the export function
                    rawParticipants: g.participants 
                }));

                io.emit('status', { state: 'connected', groups: groupsCache });
            }, 3000);
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) initWhatsApp();
        }
    });
}

/**
 * Socket.io Connection Handler
 */
io.on('connection', (socket) => {
    console.log('User connected to Dashboard UI');
    if (connectionStatus === 'connected') {
        socket.emit('status', { state: 'connected', groups: groupsCache });
    }
});

/**
 * API Routes
 */

// Export Members to CSV (Updated for v7 LID logic)
app.get('/export/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const allGroups = await sock.groupFetchAllParticipating();
        const group = allGroups[groupId];

        if (group) {
            // Pass 'sock' so groupUtils can access the LID mapping repository if needed
            await exportGroupMembers(group, sock); 
            
            const fileName = `${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;
            const filePath = path.join(__dirname, 'exports', fileName);
            
            // Give the file a moment to write
            setTimeout(() => res.download(filePath), 500);
        } else {
            res.status(404).send("Group not found.");
        }
    } catch (err) {
        console.error("Export Error:", err);
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
 * Background Import Logic (v7 LID-Aware)
 */
async function processImports(groupId, memberList) {
    const targetList = memberList.slice(0, 100); // Increased cap for Quantivo users

    for (let i = 0; i < targetList.length; i++) {
        let jid = targetList[i];
        const isLast = i === targetList.length - 1;

        // v7 logic: Try to see if we should be using a LID instead of a PN for this user
        try {
            if (jid.endsWith('@s.whatsapp.net')) {
                const pn = jid.split('@')[0];
                const lid = await sock.signalRepository.lidMapping.getLIDForPN(pn);
                if (lid) {
                    console.log(`🔄 Using mapped LID ${lid} for phone ${pn}`);
                    jid = lid; 
                }
            }
        } catch (e) {
            // Mapping not found, continue with the PN
        }

        const wait = Math.floor(Math.random() * (45000 - 30000 + 1)) + 30000;
        io.emit('import-progress', { message: `⏳ Human Delay: ${wait / 1000}s... Processing ${jid}` });
        await delay(wait);

        try {
            const response = await sock.groupParticipantsUpdate(groupId, [jid], "add");

            if (response && response[0]) {
                const status = response[0].status;

                if (status === "200") {
                    io.emit('import-progress', { status: 'success', message: `✅ Added: ${jid}`, done: isLast });
                } else if (status === "403") {
                    io.emit('import-progress', { status: 'warn', message: `⚠️ Privacy: Invite sent to ${jid}`, done: isLast });
                } else if (status === "409") {
                    io.emit('import-progress', { status: 'warn', message: `ℹ️ Already in group: ${jid}`, done: isLast });
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Quantivo CRM v7.0: http://localhost:${PORT}`);
    initWhatsApp();
});