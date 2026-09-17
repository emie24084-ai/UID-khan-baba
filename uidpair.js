const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const cookieParser = require("cookie-parser");
const chalk = require("chalk");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 30118;

// Cyan separator for console logs
const CYAN_SEPARATOR = chalk.cyan('═'.repeat(70));

function logInfo(message) {
    console.log(CYAN_SEPARATOR);
    console.log(chalk.cyan('ℹ'), chalk.white(message));
    console.log(CYAN_SEPARATOR);
}

function logSuccess(message) {
    console.log(CYAN_SEPARATOR);
    console.log(chalk.green('✓'), chalk.greenBright(message));
    console.log(CYAN_SEPARATOR);
}

function logError(message) {
    console.log(CYAN_SEPARATOR);
    console.log(chalk.red('✖'), chalk.redBright(message));
    console.log(CYAN_SEPARATOR);
}

// Create necessary directories
if (!fs.existsSync("temp")) {
    fs.mkdirSync("temp", { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static('public'));

// Active sessions store
const activeClients = new Map();

// Generate session ID
function generateSessionId() {
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 17);
}

// Format date
function formatDate(dateInput) {
    const date = new Date(dateInput);
    const day = date.getDate();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
}

// ============================================
// 🔑 PAIRING CODE GENERATE (ONLY THIS)
// ============================================
app.post("/generate-pairing-code", async (req, res) => {
    const { number: num } = req.body;

    if (!num) {
        return res.json({ success: false, error: "Phone number is required" });
    }

    try {
        const sessionId = generateSessionId();
        const sessionPath = path.join("temp", sessionId);

        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async key => { return {} },
            markOnlineOnConnect: false,
            retryRequestDelayMs: 3000,
            maxRetries: 1000000000,
            connectTimeoutMs: 60000
        });

        if (!waClient.authState.creds.registered) {
            await delay(1500);

            const phoneNumber = num.replace(/[^0-9]/g, "");
            const code = await waClient.requestPairingCode(phoneNumber);

            activeClients.set(sessionId, {
                client: waClient,
                number: num,
                authPath: sessionPath,
                isConnected: false,
                createdAt: new Date().toISOString()
            });

            res.json({
                success: true,
                code: code,
                sessionId: sessionId,
                number: num
            });
        }

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection } = s;

            if (connection === "open") {
                logSuccess(`WhatsApp Connected for ${num}! Session ID: ${sessionId}`);
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo) {
                    clientInfo.isConnected = true;
                }
            } else if (connection === "close") {
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo) {
                    clientInfo.isConnected = false;
                }
            }
        });

    } catch (err) {
        logError("Error in pairing: " + err.message);
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// 👥 GET GROUPS WITH UID (ONLY THIS)
// ============================================
app.get("/get-groups", async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || !activeClients.has(sessionId)) {
        return res.json({ success: false, error: "Invalid session selected" });
    }

    const clientInfo = activeClients.get(sessionId);

    try {
        const { client: waClient, number: senderNumber } = clientInfo;
        const groups = await waClient.groupFetchAllParticipating();

        const groupsList = Object.keys(groups).map((groupId, index) => {
            const group = groups[groupId];
            const participants = group.participants || [];

            return {
                index: index + 1,
                groupId: groupId.replace('@g.us', ''),   // 👈 GROUP UID
                subject: group.subject || 'Unnamed Group',
                participantsCount: participants.length,
                creation: group.creation ? formatDate(group.creation * 1000) : null
            };
        });

        res.json({
            success: true,
            number: senderNumber,
            groups: groupsList
        });

    } catch (error) {
        logError("Error fetching groups: " + error.message);
        res.json({ success: false, error: error.message });
    }
});

// ============================================
// SESSION STATUS (simple check)
// ============================================
app.get("/session-status", (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || !activeClients.has(sessionId)) {
        return res.json({ success: false, error: "Invalid session" });
    }

    const clientInfo = activeClients.get(sessionId);

    res.json({
        success: true,
        isConnected: clientInfo.isConnected,
        number: clientInfo.number,
        createdAt: clientInfo.createdAt,
        createdAtFormatted: clientInfo.createdAt ? formatDate(clientInfo.createdAt) : null
    });
});

// ============================================
// SERVE INDEX
// ============================================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    logSuccess(`Server running on http://localhost:${PORT}`);
    logInfo('✅ Pairing code endpoint: POST /generate-pairing-code');
    logInfo('✅ Groups with UID endpoint: GET /get-groups?sessionId=...');
});