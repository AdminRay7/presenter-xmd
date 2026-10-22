"use strict";

module.exports = {
    name: "menu",
    help: "Show command menu",
    run: async ({ conn, m, reply, cfg, commands }) => {
        const groups = new Map();
        for (const c of commands.values()) {
            if (!groups.has(c.category)) groups.set(c.category, []);
            groups.get(c.category).push(c);
        }

        let body = "";
        for (const [cat, list] of groups) {
            body += `\n╭─「 *${cat.toUpperCase()}* 」─\n`;
            for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
                body += `│ • ${cfg.prefix}${c.name}${c.help ? ` — ${c.help}` : ""}\n`;
            }
            body += `╰──────────────────\n`;
        }

        await reply(conn, m,
`╭─「 *${cfg.name}* — ${cfg.tagline} 」─╮
│ Version : ${cfg.version}
│ Prefix  : ${cfg.prefix}
│ Owner   : ${cfg.owner.name}
╰──────────────────────────╯
${body}
📢 Channel : ${cfg.links.channel}`);
    }
};