"use strict";

module.exports = {
    name: "menu",
    help: "Show command menu",
    run: async ({ conn, m, reply, cfg, commands, fancy }) => {
        const groups = new Map();
        for (const c of commands.values()) {
            if (!groups.has(c.category)) groups.set(c.category, []);
            groups.get(c.category).push(c);
        }

        let body = "";
        for (const [cat, list] of groups) {
            body += `\n╭─「 *${fancy(cat)}* 」─\n`;
            for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
                body += `│ • ${cfg.prefix}${c.name}${c.help ? ` — ${fancy(c.help)}` : ""}\n`;
            }
            body += `╰──────────────────\n`;
        }

        await reply(conn, m,
`╭─「 *${fancy(cfg.name)}* — ${fancy(cfg.tagline)} 」─╮
│ ${fancy("Version")} : ${cfg.version}
│ ${fancy("Prefix")}  : ${cfg.prefix}
│ ${fancy("Owner")}   : ${fancy(cfg.owner.name)}
╰──────────────────────────╯
${body}
📢 ${fancy("Channel")} : ${cfg.links.channel}`);
    }
};