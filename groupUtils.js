const XLSX = require('xlsx');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { delay } = require('@whiskeysockets/baileys');
const fs = require('fs');

/**
 * 1. Export Members to CSV
 * Fixed to extract Phone Numbers from JIDs and handle LID privacy IDs.
 */
async function exportGroupMembers(group) {
    if (!fs.existsSync('./exports')) {
        fs.mkdirSync('./exports');
    }

    // Clean filename to remove illegal characters
    const fileName = `./exports/${group.subject.replace(/[/\\?%*:|"<>\s]/g, '_')}.csv`;

    const csvWriter = createCsvWriter({
        path: fileName,
        header: [
            { id: 'phone', title: 'Phone Number' },
            { id: 'fullJid', title: 'WhatsApp ID' },
            { id: 'admin', title: 'Role' }
        ]
    });

    const records = group.participants.map(p => {
        // Extract raw number part before the '@'
        const rawId = p.id.split('@')[0];
        const isLid = p.id.includes('@lid');

        return {
            // If it's a standard JID, take the number. If LID, mark as hidden.
            phone: isLid ? 'Hidden (LID)' : rawId.split(':')[0],
            fullJid: p.id,
            admin: p.admin || 'member'
        };
    });

    await csvWriter.writeRecords(records);
    console.log(`✅ Exported ${records.length} members to ${fileName}`);
}

/**
 * 2. Check if current user is admin
 */
function isUserAdmin(group, myJid) {
    const me = group.participants.find(p => p.id === myJid);
    return !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));
}

/**
 * 3. Parse JIDs from Excel/CSV for Importing
 */
function getJidsFromFile(filePath) {
    try {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        return data.map(row => {
            // Support multiple column names: JID, Phone, or WhatsApp ID
            let val = row.JID || row.Phone || row['Phone Number'] || row['WhatsApp ID'] || Object.values(row)[0];
            val = String(val).trim();
            
            // Ensure the string has a proper WhatsApp domain
            if (val.includes('@')) return val;
            return `${val}@s.whatsapp.net`;
        });
    } catch (err) {
        console.error("❌ Error reading file:", err.message);
        return [];
    }
}

/**
 * 4. Human-like Add Logic (Limit 50)
 */
async function addMembersSafely(sock, groupId, memberList) {
    const targetList = memberList.slice(0, 50); // Hard safety limit
    console.log(`🚀 Starting import for ${targetList.length} members...`);

    for (const jid of targetList) {
        // Randomized Human delay: 30 to 60 seconds
        const wait = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
        console.log(`⏳ Waiting ${wait / 1000}s before adding ${jid}...`);
        await delay(wait);

        try {
            const response = await sock.groupParticipantsUpdate(groupId, [jid], "add");

            // Status 200 = Success, 403 = Privacy Block (invite sent)
            const status = response[0].status;
            if (status === "200") {
                console.log(`✅ Added: ${jid}`);
            } else if (status === "403") {
                console.log(`⚠️ Privacy block for ${jid}: Invitation sent instead.`);
            } else {
                console.log(`❓ Status ${status} for ${jid}`);
            }

        } catch (e) {
            console.error(`❌ Connection error for ${jid}:`, e.message);
        }
    }
    console.log("🏁 Import process finished.");
}

module.exports = { exportGroupMembers, addMembersSafely, isUserAdmin, getJidsFromFile };