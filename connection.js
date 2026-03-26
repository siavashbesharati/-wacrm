const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_store');
    const { version } = await fetchLatestBaileysVersion();

    // v7: auth must use creds + makeCacheableSignalKeyStore(keys) for LID-mapping support
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys),
        },
        // Remove printQRInTerminal: true to stop the warning
        browser: ["Chrome", "MacOS", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    // This is the part you need to handle manually now:
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("Scan the QR code below to log in:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log("🚀 System Online and Connected!");
        }
        
        if (connection === 'close') {
            console.log("Connection closed. Attempting to reconnect...");
            // Add your reconnection logic here if needed
        }
    });

    return sock;
}

module.exports = { connectToWhatsApp };