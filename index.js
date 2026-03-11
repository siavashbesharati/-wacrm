const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const { connectToWhatsApp } = require('./connection');
const { exportGroupMembers, isUserAdmin } = require('./groupUtils');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let sock;
let groupsCache = [];

async function init() {
    sock = await connectToWhatsApp();

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            const qrImageUrl = await qrcode.toDataURL(qr);
            io.emit('qr', qrImageUrl);
        }

        if (connection === 'open') {
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const rawGroups = await sock.groupFetchAllParticipating();
            
            // Format groups for the UI
            groupsCache = Object.values(rawGroups).map(g => ({
                id: g.id,
                subject: g.subject,
                isAdmin: isUserAdmin(g, myJid)
            }));

            io.emit('status', { state: 'connected', groups: groupsCache });
        }
    });
}

// Endpoint to trigger CSV download
app.get('/export/:groupId', async (req, res) => {
    const groupId = req.params.groupId;
    const allGroups = await sock.groupFetchAllParticipating();
    const group = allGroups[groupId];

    if (group) {
        await exportGroupMembers(group);
        const fileName = `${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;
        res.download(`./exports/${fileName}`);
    } else {
        res.status(404).send("Group not found");
    }
});

server.listen(3000, () => {
    console.log('🚀 Dashboard: http://localhost:3000');
    init();
});