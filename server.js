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
        auth: state,
        printQRInTerminal: false,
        browser: ["Quantivo CRM", "Chrome", "1.0.0"],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImageUrl = await qrcode.toDataURL(qr);
            io.emit('qr', qrImageUrl);
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            console.log("✅ WhatsApp Connected!");
            
            // Fetch groups with a slight delay to ensure sync
            setTimeout(async () => {
                const rawGroups = await sock.groupFetchAllParticipating();
                groupsCache = Object.values(rawGroups).map(g => ({
                    id: g.id,
                    subject: g.subject,
                    memberCount: g.participants ? g.participants.length : 0
                }));
                
                console.log(`Synced ${groupsCache.length} groups.`);
                io.emit('status', { state: 'connected', groups: groupsCache });
            }, 2000);
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) initWhatsApp();
        }
    });
}

/**
 * Socket.io Connection Handler
 * Ensures UI gets data immediately upon page load/refresh
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

// Export Members to CSV
app.get('/export/:groupId', async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const allGroups = await sock.groupFetchAllParticipating();
        const group = allGroups[groupId];

        if (group) {
            await exportGroupMembers(group);
            const fileName = `${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;
            const filePath = path.join(__dirname, 'exports', fileName);
            res.download(filePath);
        } else {
            res.status(404).send("Group not found.");
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Upload Excel and Start Import
app.post('/upload-import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    
    const { groupId } = req.body;
    const filePath = req.file.path;

    try {
        const jids = getJidsFromFile(filePath);
        res.json({ success: true, count: jids.length });

        // Run the import process in the background
        processImports(groupId, jids);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        // Clean up temp file
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});

/**
 * Background Import Logic
 */
async function processImports(groupId, memberList) {
    // Safety cap for testing - remove .slice(0, 50) for production
    const targetList = memberList.slice(0, 50); 
    
    for (let i = 0; i < targetList.length; i++) {
        const jid = targetList[i];
        const isLast = i === targetList.length - 1;

        // Random delay 5-10 seconds for testing (adjust to 30-50s for production)
        const wait = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
        io.emit('import-progress', { message: `⏳ Waiting ${wait/1000}s... Adding ${jid}` });
        await delay(wait);

        try {
            const response = await sock.groupParticipantsUpdate(groupId, [jid], "add");
            const status = response[0].status;

            if (status === "200") {
                io.emit('import-progress', { status: 'success', message: `✅ Added: ${jid}`, done: isLast });
            } else if (status === "403") {
                io.emit('import-progress', { status: 'warn', message: `⚠️ Privacy: Invite sent to ${jid}`, done: isLast });
            } else {
                io.emit('import-progress', { status: 'error', message: `❌ Failed (${status}): ${jid}`, done: isLast });
            }
        } catch (e) {
            io.emit('import-progress', { status: 'error', message: `❌ Error: ${e.message}`, done: isLast });
        }
    }
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Quantivo CRM Live: http://localhost:${PORT}`);
    initWhatsApp();
});