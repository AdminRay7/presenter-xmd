"use strict";

module.exports = {
    name: "ping",
    help: "Check bot latency",
    run: async ({ conn, m, reply, fancy }) => {
        const t = Date.now();
        await reply(conn, m, `🏓 ${fancy("Pong")}! ${Date.now() - t}ms`);
    }
};