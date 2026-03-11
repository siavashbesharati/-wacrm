const XLSX = require('xlsx');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');

/**
 * 1. Export Members to CSV
 * Updated for v7: Uses signalRepository to map LIDs back to Phone Numbers
 */
async function exportGroupMembers(group, sock) {
    if (!fs.existsSync('./exports')) {
        fs.mkdirSync('./exports');
    }

    const fileName = `./exports/${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;

    const csvWriter = createCsvWriter({
        path: fileName,
        header: [
            { id: 'phone', title: 'Phone Number' },
            { id: 'fullJid', title: 'WhatsApp ID' },
            { id: 'type', title: 'Identity Type' },
            { id: 'admin', title: 'Role' }
        ]
    });

    const records = await Promise.all(group.participants.map(async (p) => {
        let phone = '';
        const isLid = p.id.includes('@lid');

        // v7 Strategy: 1. Check if phoneNumber is already in the participant object
        // 2. If not, check the internal lidMapping store
        if (p.phoneNumber) {
            phone = p.phoneNumber;
        } else if (isLid && sock) {
            try {
                // Deep Search: Attempt to find PN for this LID in the session store
                const foundPn = await sock.signalRepository.lidMapping.getPNForLID(p.id);
                phone = foundPn || 'Hidden (LID)';
            } catch (e) {
                phone = 'Hidden (LID)';
            }
        } else {
            // Standard JID: just strip the domain
            phone = p.id.split('@')[0].split(':')[0];
        }

        return {
            phone: phone,
            fullJid: p.id,
            type: isLid ? 'LID (Private)' : 'PN (Standard)',
            admin: p.admin || 'member'
        };
    }));

    await csvWriter.writeRecords(records);
    console.log(`✅ Exported ${records.length} members to ${fileName}`);
}

/**
 * 2. Check if current user is admin
 */
function isUserAdmin(group, myJid) {
    if (!group.participants) return false;
    const me = group.participants.find(p => p.id === myJid);
    return !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));
}

/**
 * 3. Parse JIDs from Excel/CSV for Importing
 * Enhanced to clean raw phone numbers into valid WhatsApp JIDs
 */
function getJidsFromFile(filePath) {
    try {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        return data.map(row => {
            let val = row.JID || row.Phone || row['Phone Number'] || row['WhatsApp ID'] || Object.values(row)[0];
            if (!val) return null;

            let cleaned = String(val).trim();

            // If it's just a number, clean it and add the domain
            if (!cleaned.includes('@')) {
                cleaned = cleaned.replace(/\D/g, ''); // Remove all non-numeric chars (+, -, spaces)
                
                // Optional: Force country code if missing (example for Iran 98)
                // if (!cleaned.startsWith('98')) cleaned = '98' + cleaned; 
                
                return `${cleaned}@s.whatsapp.net`;
            }
            
            return cleaned;
        }).filter(jid => jid !== null);
    } catch (err) {
        console.error("❌ Error reading file:", err.message);
        return [];
    }
}

module.exports = { exportGroupMembers, isUserAdmin, getJidsFromFile };