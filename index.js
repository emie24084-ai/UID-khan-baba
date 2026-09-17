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

const CYAN_SEPARATOR = chalk.cyan('═'.repeat(70));

function logInfo(msg) {
    console.log(CYAN_SEPARATOR);
    console.log(chalk.cyan('ℹ'), chalk.white(msg));
    console.log(CYAN_SEPARATOR);
}
function logSuccess(msg) {
    console.log(CYAN_SEPARATOR);
    console.log(chalk.green('✓'), chalk.greenBright(msg));
    console.log(CYAN_SEPARATOR);
}
function logError(msg) {
    console.log(CYAN_SEPARATOR);
    console.log(chalk.red('✖'), chalk.redBright(msg));
    console.log(CYAN_SEPARATOR);
}

if (!fs.existsSync("temp")) fs.mkdirSync("temp", { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static('public'));

const activeClients = new Map();

function generateSessionId() {
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 17);
}

function formatDate(dateInput) {
    const date = new Date(dateInput);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

// ============================================
// 🔑 PAIRING CODE — fixed timing
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
            getMessage: async () => ({}),
            markOnlineOnConnect: false,
            retryRequestDelayMs: 3000,
            maxRetries: 1000000000,
            connectTimeoutMs: 60000
        });

        // Register session in memory FIRST (so frontend can poll)
        const sessionData = {
            client: waClient,
            number: num,
            authPath: sessionPath,
            isConnected: false,
            pairingCode: null,
            pairingCodeError: null,
            pairingCodeRequested: false,
            createdAt: new Date().toISOString()
        };
        activeClients.set(sessionId, sessionData);

        // Respond immediately with sessionId — frontend will poll for code
        res.json({
            success: true,
            sessionId: sessionId,
            number: num,
            message: "Pairing code generate ho raha hai, thoda wait karo..."
        });

        waClient.ev.on("creds.update", saveCreds);

        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            logInfo(`[${sessionId}] connection.update: ${connection || 'qr event'}`);

            // 🔥 KEY FIX: Request pairing code AFTER connection starts (qr or connecting)
            if ((connection === "connecting" || qr) &&
                !waClient.authState.creds.registered &&
                !sessionData.pairingCodeRequested) {

                sessionData.pairingCodeRequested = true;

                // Wait for socket to be fully ready before requesting code
                await delay(3000);

                try {
                    const phoneNumber = String(num).replace(/[^0-9]/g, "");
                    logInfo(`[${sessionId}] Requesting pairing code for ${phoneNumber}...`);

                    const code = await waClient.requestPairingCode(phoneNumber);

                    sessionData.pairingCode = code;
                    sessionData.pairingCodeError = null;
                    logSuccess(`[${sessionId}] ✅ Pairing Code: ${code}`);

                } catch (err) {
                    sessionData.pairingCodeError = err.message;
                    logError(`[${sessionId}] Pairing code request failed: ${err.message}`);
                }
            }

            if (connection === "open") {
                logSuccess(`[${sessionId}] WhatsApp connected for ${num}`);
                sessionData.isConnected = true;
                sessionData.pairingCodeError = null;
            }

            if (connection === "close") {
                sessionData.isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                logError(`[${sessionId}] Connection closed. Code: ${statusCode}`);

                // Don't delete session if it hasn't paired yet — user might retry
                if (statusCode === 401) {
                    logError(`[${sessionId}] Logged out. Cleaning up.`);
                    try { waClient.end(); } catch(e) {}
                    activeClients.delete(sessionId);
                }
            }
        });

    } catch (err) {
        logError("Error in pairing: " + err.message);
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// 🔎 POLL PAIRING CODE
// ============================================
app.get("/pairing-code-status", (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || !activeClients.has(sessionId)) {
        return res.json({ success: false, error: "Invalid session" });
    }

    const s = activeClients.get(sessionId);

    res.json({
        success: true,
        sessionId,
        isConnected: s.isConnected,
        pairingCode: s.pairingCode,
        pairingCodeError: s.pairingCodeError,
        pairingCodeRequested: s.pairingCodeRequested,
        number: s.number
    });
});

// ============================================
// 👥 GET GROUPS WITH UID
// ============================================
app.get("/get-groups", async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || !activeClients.has(sessionId)) {
        return res.json({ success: false, error: "Invalid session selected" });
    }

    const clientInfo = activeClients.get(sessionId);

    if (!clientInfo.isConnected) {
        return res.json({ success: false, error: "WhatsApp abhi connect nahi hua" });
    }

    try {
        const { client: waClient, number: senderNumber } = clientInfo;
        const groups = await waClient.groupFetchAllParticipating();

        const groupsList = Object.keys(groups).map((groupId, index) => {
            const group = groups[groupId];
            const participants = group.participants || [];
            return {
                index: index + 1,
                groupId: groupId.replace('@g.us', ''),
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
// SESSION STATUS
// ============================================
app.get("/session-status", (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || !activeClients.has(sessionId)) {
        return res.json({ success: false, error: "Invalid session" });
    }

    const s = activeClients.get(sessionId);

    res.json({
        success: true,
        isConnected: s.isConnected,
        number: s.number,
        createdAt: s.createdAt,
        createdAtFormatted: s.createdAt ? formatDate(s.createdAt) : null
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('uncaughtException', (e) => logError('UNCAUGHT: ' + e.message));
process.on('unhandledRejection', (e) => logError('UNHANDLED: ' + e));

app.listen(PORT, () => {
    logSuccess(`Server running on http://localhost:${PORT}`);
    logInfo('✅ POST /generate-pairing-code');
    logInfo('✅ GET  /pairing-code-status?sessionId=...');
    logInfo('✅ GET  /get-groups?sessionId=...');
    logInfo('✅ GET  /session-status?sessionId=...');
});
