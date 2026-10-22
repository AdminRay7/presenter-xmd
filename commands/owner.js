"use strict";

module.exports = {
    name: "owner",
    help: "Get owner contact",
    run: async ({ conn, m, cfg }) => {
        const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${cfg.owner.name}
TEL;type=CELL;type=VOICE;waid=${cfg.owner.number}:+${cfg.owner.number}
END:VCARD`;
        await conn.sendMessage(m.key.remoteJid, {
            contacts: { displayName: cfg.owner.name, contacts: [{ vcard }] }
        }, { quoted: m });
    }
};