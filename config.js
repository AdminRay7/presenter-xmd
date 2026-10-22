"use strict";

const path = require("path");
// Force dotenv to load from the exact directory of config.js
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const { fancy } = require("./lib/font");

// ============================================================
//   RAW VALUES (safe for logic — never fancy these)
// ============================================================
const RAW = {
    name: process.env.BOT_NAME || "303-XMD",
    tagline: process.env.BOT_TAGLINE || "The Last Key",
    version: process.env.BOT_VERSION || "2.0.0",
    prefix: process.env.PREFIX || ".",

    ownerName: process.env.OWNER_NAME || "Mr Presenter",
    ownerNumber: process.env.OWNER_NUMBER || "254794376595",
    ownerEmail: process.env.ADMIN_EMAIL || "ryanobanga243@gmail.com",

    channelLink: process.env.CHANNEL_LINK || "",
    newsletterJid: process.env.NEWSLETTER_JID || ""
};

// ============================================================
//   EXPORT
// ============================================================
module.exports = {
    // --- identity (raw) ---
    name: RAW.name,
    tagline: RAW.tagline,
    version: RAW.version,
    prefix: RAW.prefix,

    // --- owner (raw) ---
    owner: {
        name: RAW.ownerName,
        number: RAW.ownerNumber,
        email: RAW.ownerEmail
    },

    // --- links ---
    links: {
        channel: RAW.channelLink,
        newsletter: RAW.newsletterJid
    },

    // --- pretty versions for messages ---
    display: {
        name: fancy(RAW.name),
        tagline: fancy(RAW.tagline),
        owner: fancy(RAW.ownerName),
        version: RAW.version,
        prefix: RAW.prefix
    },

    // --- menu labels ---
    menu: {
        version: fancy("Version"),
        prefix: fancy("Prefix"),
        owner: fancy("Owner"),
        channel: fancy("Channel"),
        menu: fancy("Menu"),
        general: fancy("General"),
        ai: fancy("AI"),
        download: fancy("Download"),
        ownerCat: fancy("Owner"),
        group: fancy("Group"),
        tools: fancy("Tools")
    },

    // --- mongo ---
    mongo: {
        uri: process.env.MONGODB_URI,
        db: process.env.DB_NAME || "xmd303",
        authCollection: process.env.AUTH_COLLECTION || "authState"
    },

    // --- api keys ---
    api: {
        botKey: process.env.BOT_API_KEY,
        huggingface: process.env.HUGGINGFACE_TOKEN,
        modelslab: process.env.MODELSLAB_KEY
    },

    // --- ai ---
    ai: {
        provider: process.env.AI_PROVIDER || "openai",
        model: process.env.AI_MODEL || "openai/gpt-oss-20b",
        baseUrl: process.env.AI_BASE_URL || "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY
    },

    // --- rapidapi ---
    rapidapi: {
        key: process.env.RAPIDAPI_KEY,
        host: process.env.RAPIDAPI_HOST,
        searchHost: process.env.SEARCH_API_HOST
    },

    // --- payments ---
    payments: {
        paystack: process.env.PAYSTACK_SECRET_KEY || "",
        stripe: process.env.STRIPE_SECRET_KEY || ""
    },

    // --- server ---
    server: {
        port: Number(process.env.PORT) || 3000,
        maxSessions: Number(process.env.MAX_SESSIONS) || 12
    }
};