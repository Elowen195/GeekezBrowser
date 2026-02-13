#!/usr/bin/env node
/**
 * GeekEZ Browser - Headless Server Mode (No Electron)
 *
 * For Alpine Linux / proot / VNC environments
 * All control via REST API, no GUI needed
 * Browser windows display normally (via VNC/X11)
 */

const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { spawn, exec } = require('child_process');
const getPort = require('get-port');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const yaml = require('js-yaml');
const { SocksProxyAgent } = require('socks-proxy-agent');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const { generateXrayConfig, parseProxyLink } = require('./utils');
const { generateFingerprint, getInjectScript } = require('./fingerprint');

// ============================================================================
// Configuration - Adjust paths for your environment
// ============================================================================
const DATA_PATH = process.env.GEEKEZ_DATA_PATH || path.join(os.homedir(), '.geekez-browser');
const TRASH_PATH = path.join(DATA_PATH, '_Trash_Bin');
const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');

// Xray binary path - adjust for Alpine
const BIN_DIR = process.env.GEEKEZ_BIN_DIR || path.join(__dirname, 'resources', 'bin', `${process.platform}-${process.arch}`);
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'xray.exe' : 'xray');

// Chrome binary path - set via env or auto-detect
const CHROME_PATH = process.env.CHROME_PATH || findChromePath();

// API Server port
const API_PORT = parseInt(process.env.API_PORT || '3000', 10);

// ============================================================================
// Initialize
// ============================================================================
fs.ensureDirSync(DATA_PATH);
fs.ensureDirSync(TRASH_PATH);

let activeProcesses = {};

console.log('============================================');
console.log('  GeekEZ Browser - Server Mode');
console.log('============================================');
console.log(`Data Path: ${DATA_PATH}`);
console.log(`Xray Path: ${BIN_PATH}`);
console.log(`Chrome Path: ${CHROME_PATH || 'Not found'}`);
console.log(`API Port: ${API_PORT}`);
console.log('============================================');

// ============================================================================
// Helper Functions
// ============================================================================
function findChromePath() {
    // Common Chrome/Chromium paths on Linux
    const paths = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        // Alpine specific
        '/usr/bin/chromium-browser',
        // Puppeteer downloaded Chrome
        path.join(__dirname, 'resources', 'puppeteer', 'chrome-linux', 'chrome'),
        path.join(__dirname, 'resources', 'puppeteer', 'chrome-linux64', 'chrome'),
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    // Try to find in puppeteer directory recursively
    const puppeteerDir = path.join(__dirname, 'resources', 'puppeteer');
    if (fs.existsSync(puppeteerDir)) {
        const found = findFileRecursive(puppeteerDir, 'chrome');
        if (found) return found;
    }

    return null;
}

function findFileRecursive(dir, filename) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                const res = findFileRecursive(fullPath, filename);
                if (res) return res;
            } else if (file === filename) {
                return fullPath;
            }
        }
    } catch (e) { }
    return null;
}

function forceKill(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        try {
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${pid} /T /F`, () => resolve());
            } else {
                process.kill(pid, 'SIGKILL');
                resolve();
            }
        } catch (e) { resolve(); }
    });
}

// Encryption helpers (same as main.js)
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC_HEADER = Buffer.from('GKEZ');

function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function encryptData(data, password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(password, salt);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const version = Buffer.alloc(4);
    version.writeUInt32LE(1, 0);
    return Buffer.concat([MAGIC_HEADER, version, salt, iv, authTag, encrypted]);
}

function decryptData(encryptedBuffer, password) {
    const magic = encryptedBuffer.slice(0, 4);
    if (!magic.equals(MAGIC_HEADER)) {
        throw new Error('Invalid backup file format');
    }
    let offset = 4;
    const version = encryptedBuffer.readUInt32LE(offset);
    offset += 4;
    if (version !== 1) {
        throw new Error(`Unsupported backup version: ${version}`);
    }
    const salt = encryptedBuffer.slice(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = encryptedBuffer.slice(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = encryptedBuffer.slice(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const encrypted = encryptedBuffer.slice(offset);
    const key = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function cleanFingerprint(fp) {
    if (!fp) return fp;
    const cleaned = { ...fp };
    delete cleaned.userAgent;
    delete cleaned.userAgentMetadata;
    delete cleaned.webgl;
    return cleaned;
}

// ============================================================================
// Extension Generator
// ============================================================================
async function generateExtension(profilePath, fingerprint, profileName, watermarkStyle) {
    const extDir = path.join(profilePath, 'extension');
    await fs.ensureDir(extDir);
    const manifest = {
        manifest_version: 3,
        name: "GeekEZ Guard",
        version: "1.0.0",
        description: "Privacy Protection",
        content_scripts: [{
            matches: ["<all_urls>"],
            js: ["content.js"],
            run_at: "document_start",
            all_frames: true,
            world: "MAIN"
        }]
    };
    const style = watermarkStyle || 'enhanced';
    const scriptContent = getInjectScript(fingerprint, profileName, style);
    await fs.writeJson(path.join(extDir, 'manifest.json'), manifest);
    await fs.writeFile(path.join(extDir, 'content.js'), scriptContent);
    return extDir;
}

// ============================================================================
// Profile Launcher (Core Logic)
// ============================================================================
async function launchProfile(profileId, options = {}) {
    const { watermarkStyle = 'enhanced', hidden = false } = options;

    if (activeProcesses[profileId]) {
        const proc = activeProcesses[profileId];
        if (proc.browser && proc.browser.isConnected()) {
            return { success: true, message: 'Already running', profileId };
        } else {
            await forceKill(proc.xrayPid);
            delete activeProcesses[profileId];
        }
    }

    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
        throw new Error('Profile not found');
    }

    if (!profile.fingerprint) {
        profile.fingerprint = generateFingerprint();
    }
    if (!profile.fingerprint.languages) {
        profile.fingerprint.languages = ['en-US', 'en'];
    }

    // Load settings
    const settings = fs.existsSync(SETTINGS_FILE)
        ? await fs.readJson(SETTINGS_FILE)
        : { preProxies: [], enablePreProxy: false };

    // Pre-proxy config
    const override = profile.preProxyOverride || 'default';
    const shouldUsePreProxy = override === 'on' || (override === 'default' && settings.enablePreProxy);
    let finalPreProxyConfig = null;

    if (shouldUsePreProxy && settings.preProxies && settings.preProxies.length > 0) {
        const active = settings.preProxies.filter(p => p.enable !== false);
        if (active.length > 0) {
            const target = active[0];
            finalPreProxyConfig = { preProxies: [target] };
        }
    }

    const localPort = await getPort();
    const profileDir = path.join(DATA_PATH, profileId);
    const userDataDir = path.join(profileDir, 'browser_data');
    const xrayConfigPath = path.join(profileDir, 'config.json');
    const xrayLogPath = path.join(profileDir, 'xray_run.log');

    fs.ensureDirSync(userDataDir);

    // Setup Chrome preferences
    try {
        const defaultProfileDir = path.join(userDataDir, 'Default');
        fs.ensureDirSync(defaultProfileDir);
        const preferencesPath = path.join(defaultProfileDir, 'Preferences');
        let preferences = {};
        if (fs.existsSync(preferencesPath)) {
            preferences = await fs.readJson(preferencesPath);
        }
        if (!preferences.bookmark_bar) preferences.bookmark_bar = {};
        preferences.bookmark_bar.show_on_all_tabs = true;
        if (!preferences.profile) preferences.profile = {};
        preferences.profile.name = profile.name;
        if (!preferences.webrtc) preferences.webrtc = {};
        preferences.webrtc.ip_handling_policy = 'disable_non_proxied_udp';
        await fs.writeJson(preferencesPath, preferences);
    } catch (e) {
        console.error('Failed to setup preferences:', e.message);
    }

    // Generate Xray config and start
    const config = generateXrayConfig(profile.proxyStr, localPort, finalPreProxyConfig);
    fs.writeJsonSync(xrayConfigPath, config);

    let xrayProcess = null;
    let logFd = null;

    if (fs.existsSync(BIN_PATH)) {
        logFd = fs.openSync(xrayLogPath, 'a');
        xrayProcess = spawn(BIN_PATH, ['-c', xrayConfigPath], {
            cwd: BIN_DIR,
            env: { ...process.env, 'XRAY_LOCATION_ASSET': path.dirname(BIN_PATH) },
            stdio: ['ignore', logFd, logFd],
            detached: false
        });
        console.log(`[${profile.name}] Xray started on port ${localPort}`);
        await new Promise(r => setTimeout(r, 300));
    } else {
        console.warn('Xray binary not found, running without proxy');
    }

    // Resolve language
    const targetLang = profile.fingerprint?.language && profile.fingerprint.language !== 'auto'
        ? profile.fingerprint.language
        : 'en-US';
    profile.fingerprint.language = targetLang;
    profile.fingerprint.languages = [targetLang, targetLang.split('-')[0]];

    // Generate extension
    const extPath = await generateExtension(profileDir, profile.fingerprint, profile.name, watermarkStyle);

    // Build launch args
    const launchArgs = [
        `--user-data-dir=${userDataDir}`,
        `--window-size=${profile.fingerprint?.window?.width || 1280},${profile.fingerprint?.window?.height || 800}`,
        '--restore-last-session',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        `--lang=${targetLang}`,
        `--accept-lang=${targetLang}`,
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disk-cache-size=52428800',
        '--media-cache-size=52428800'
    ];

    // Add proxy if xray is running
    if (xrayProcess) {
        launchArgs.unshift(`--proxy-server=socks5://127.0.0.1:${localPort}`);
    }

    // Hidden mode
    if (hidden) {
        launchArgs.push('--window-position=-32000,-32000');
    }

    // Remote debugging
    if (settings.enableRemoteDebugging && profile.debugPort) {
        launchArgs.push(`--remote-debugging-port=${profile.debugPort}`);
        console.log(`[${profile.name}] Remote debugging on port ${profile.debugPort}`);
    }

    // Check Chrome path
    if (!CHROME_PATH || !fs.existsSync(CHROME_PATH)) {
        if (xrayProcess) await forceKill(xrayProcess.pid);
        throw new Error(`Chrome not found. Set CHROME_PATH env variable. Tried: ${CHROME_PATH}`);
    }

    // Timezone env
    const env = { ...process.env };
    if (profile.fingerprint?.timezone && profile.fingerprint.timezone !== 'Auto') {
        env.TZ = profile.fingerprint.timezone;
    }

    // Ensure DISPLAY is set for X11/VNC
    if (!env.DISPLAY) {
        env.DISPLAY = ':0';
    }

    console.log(`[${profile.name}] Launching browser...`);

    const browser = await puppeteer.launch({
        headless: false, // NOT headless - show window via VNC
        executablePath: CHROME_PATH,
        userDataDir: userDataDir,
        args: launchArgs,
        defaultViewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
        pipe: false,
        dumpio: false,
        env: env
    });

    // Minimize if hidden
    if (hidden) {
        try {
            const pages = await browser.pages();
            if (pages.length > 0) {
                const client = await pages[0].target().createCDPSession();
                const { windowId } = await client.send('Browser.getWindowForTarget');
                await client.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { windowState: 'minimized' }
                });
            }
        } catch (e) {
            console.log('Failed to minimize:', e.message);
        }
    }

    activeProcesses[profileId] = {
        xrayPid: xrayProcess?.pid,
        browser,
        logFd,
        chromePid: browser.process()?.pid
    };

    console.log(`[${profile.name}] Browser launched successfully`);

    // Handle disconnect
    browser.on('disconnected', async () => {
        console.log(`[${profile.name}] Browser disconnected`);
        if (activeProcesses[profileId]) {
            const pid = activeProcesses[profileId].xrayPid;
            const fd = activeProcesses[profileId].logFd;
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch (e) { }
            }
            delete activeProcesses[profileId];
            await forceKill(pid);
        }
    });

    return {
        success: true,
        profileId,
        name: profile.name,
        xrayPort: localPort,
        debugPort: profile.debugPort
    };
}

// ============================================================================
// REST API Server
// ============================================================================
async function handleApiRequest(method, pathname, body, params) {
    let profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};

    const findProfile = (idOrName) => {
        return profiles.find(p => p.id === idOrName || p.name === idOrName);
    };

    const generateUniqueName = (baseName) => {
        if (!profiles.find(p => p.name === baseName)) return baseName;
        let suffix = 2;
        while (profiles.find(p => p.name === `${baseName}-${String(suffix).padStart(2, '0')}`)) {
            suffix++;
        }
        return `${baseName}-${String(suffix).padStart(2, '0')}`;
    };

    // GET /api/status
    if (method === 'GET' && pathname === '/api/status') {
        return {
            success: true,
            running: Object.keys(activeProcesses),
            count: Object.keys(activeProcesses).length,
            mode: 'server'
        };
    }

    // GET /api/profiles
    if (method === 'GET' && pathname === '/api/profiles') {
        return {
            success: true,
            profiles: profiles.map(p => ({
                id: p.id,
                name: p.name,
                tags: p.tags,
                running: !!activeProcesses[p.id]
            }))
        };
    }

    // GET /api/profiles/:idOrName
    const profileMatch = pathname.match(/^\/api\/profiles\/([^\/]+)$/);
    if (method === 'GET' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        return { success: true, profile: { ...profile, running: !!activeProcesses[profile.id] } };
    }

    // POST /api/profiles - Create
    if (method === 'POST' && pathname === '/api/profiles') {
        const data = JSON.parse(body);
        const id = uuidv4();
        const fingerprint = await generateFingerprint({});
        const baseName = data.name || `Profile-${Date.now()}`;
        const uniqueName = generateUniqueName(baseName);
        const newProfile = {
            id,
            name: uniqueName,
            proxyStr: data.proxyStr || '',
            tags: data.tags || [],
            fingerprint,
            createdAt: Date.now()
        };
        profiles.push(newProfile);
        await fs.writeJson(PROFILES_FILE, profiles);
        return { success: true, profile: newProfile };
    }

    // PUT /api/profiles/:idOrName - Update
    if (method === 'PUT' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const idx = profiles.findIndex(p => p.id === profile.id);
        const data = JSON.parse(body);
        if (data.name && data.name !== profile.name) {
            data.name = generateUniqueName(data.name);
        }
        profiles[idx] = { ...profiles[idx], ...data };
        await fs.writeJson(PROFILES_FILE, profiles);
        return { success: true, profile: profiles[idx] };
    }

    // DELETE /api/profiles/:idOrName
    if (method === 'DELETE' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };

        if (activeProcesses[profile.id]) {
            await forceKill(activeProcesses[profile.id].xrayPid);
            await forceKill(activeProcesses[profile.id].chromePid);
            try {
                await activeProcesses[profile.id].browser.close();
            } catch (e) { }
            if (activeProcesses[profile.id].logFd !== undefined) {
                try { fs.closeSync(activeProcesses[profile.id].logFd); } catch (e) { }
            }
            delete activeProcesses[profile.id];
            await new Promise(r => setTimeout(r, 1000));
        }

        profiles = profiles.filter(p => p.id !== profile.id);
        await fs.writeJson(PROFILES_FILE, profiles);

        const profileDir = path.join(DATA_PATH, profile.id);
        try {
            if (fs.existsSync(profileDir)) {
                await fs.remove(profileDir);
            }
        } catch (err) {
            console.error('Failed to delete profile dir:', err.message);
        }

        return { success: true, message: 'Profile deleted' };
    }

    // GET /api/open/:idOrName - Launch profile
    const openMatch = pathname.match(/^\/api\/open\/([^\/]+)$/);
    if (method === 'GET' && openMatch) {
        const profile = findProfile(decodeURIComponent(openMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };

        if (activeProcesses[profile.id]) {
            return { success: true, message: 'Already running', profileId: profile.id };
        }

        const hidden = params.get('hidden') === 'true';
        const watermarkStyle = params.get('watermark') || 'enhanced';

        try {
            const result = await launchProfile(profile.id, { hidden, watermarkStyle });
            return result;
        } catch (err) {
            return { status: 500, data: { success: false, error: err.message } };
        }
    }

    // POST /api/profiles/:idOrName/stop
    const stopMatch = pathname.match(/^\/api\/profiles\/([^\/]+)\/stop$/);
    if (method === 'POST' && stopMatch) {
        const profile = findProfile(decodeURIComponent(stopMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };

        const proc = activeProcesses[profile.id];
        if (!proc) return { status: 404, data: { success: false, error: 'Profile not running' } };

        await forceKill(proc.xrayPid);
        await forceKill(proc.chromePid);
        try {
            await proc.browser.close();
        } catch (e) { }
        delete activeProcesses[profile.id];

        return { success: true, message: 'Profile stopped' };
    }

    // POST /api/profiles/:idOrName/show
    const showMatch = pathname.match(/^\/api\/profiles\/([^\/]+)\/show$/);
    if (method === 'POST' && showMatch) {
        const profile = findProfile(decodeURIComponent(showMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };

        const proc = activeProcesses[profile.id];
        if (!proc || !proc.browser) return { status: 404, data: { success: false, error: 'Profile not running' } };

        try {
            const pages = await proc.browser.pages();
            if (pages.length > 0) {
                const page = pages[0];
                const session = await page.target().createCDPSession();
                const { windowId } = await session.send('Browser.getWindowForTarget');
                await session.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { windowState: 'normal' }
                });
                await session.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { left: 100, top: 100, width: 1280, height: 800, windowState: 'normal' }
                });
                await page.bringToFront();
                return { success: true, message: 'Window shown' };
            }
            return { status: 500, data: { success: false, error: 'No pages found' } };
        } catch (err) {
            return { status: 500, data: { success: false, error: err.message } };
        }
    }

    // GET /api/settings
    if (method === 'GET' && pathname === '/api/settings') {
        return { success: true, settings };
    }

    // PUT /api/settings
    if (method === 'PUT' && pathname === '/api/settings') {
        const data = JSON.parse(body);
        await fs.writeJson(SETTINGS_FILE, { ...settings, ...data });
        return { success: true, message: 'Settings saved' };
    }

    // GET /api/export/fingerprint
    if (method === 'GET' && pathname === '/api/export/fingerprint') {
        const exportData = profiles.map(p => ({
            id: p.id,
            name: p.name,
            proxyStr: p.proxyStr,
            tags: p.tags,
            fingerprint: cleanFingerprint(p.fingerprint)
        }));
        const yamlStr = yaml.dump(exportData, { lineWidth: -1, noRefs: true });
        return {
            success: true,
            data: yamlStr,
            filename: `GeekEZ_Profiles_${Date.now()}.yaml`,
            profileCount: profiles.length
        };
    }

    // POST /api/import
    if (method === 'POST' && pathname === '/api/import') {
        try {
            const data = JSON.parse(body);
            const content = data.content;
            if (!content) return { status: 400, data: { success: false, error: 'Content required' } };

            const yamlData = yaml.load(content);
            if (Array.isArray(yamlData)) {
                let imported = 0;
                for (const item of yamlData) {
                    const name = generateUniqueName(item.name || `Imported-${Date.now()}`);
                    const newProfile = {
                        id: uuidv4(),
                        name,
                        proxyStr: item.proxyStr || '',
                        tags: item.tags || [],
                        fingerprint: item.fingerprint || generateFingerprint({}),
                        createdAt: Date.now()
                    };
                    profiles.push(newProfile);
                    imported++;
                }
                await fs.writeJson(PROFILES_FILE, profiles);
                return { success: true, message: `Imported ${imported} profiles`, count: imported };
            }
            return { status: 400, data: { success: false, error: 'Invalid YAML format' } };
        } catch (err) {
            return { status: 400, data: { success: false, error: err.message } };
        }
    }

    return { status: 404, data: { success: false, error: 'Endpoint not found' } };
}

function createApiServer(port) {
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        const pathname = url.pathname;
        const method = req.method;

        let body = '';
        if (method === 'POST' || method === 'PUT') {
            body = await new Promise(resolve => {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => resolve(data));
            });
        }

        try {
            const result = await handleApiRequest(method, pathname, body, url.searchParams);
            res.writeHead(result.status || 200);
            res.end(JSON.stringify(result.data || result));
        } catch (err) {
            console.error('API Error:', err);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });

    return server;
}

// ============================================================================
// Main Entry
// ============================================================================
async function main() {
    const server = createApiServer(API_PORT);

    server.listen(API_PORT, '0.0.0.0', () => {
        console.log(`\nAPI Server running on http://0.0.0.0:${API_PORT}`);
        console.log('\nAvailable endpoints:');
        console.log('  GET  /api/status              - Server status');
        console.log('  GET  /api/profiles            - List profiles');
        console.log('  GET  /api/profiles/:id        - Get profile');
        console.log('  POST /api/profiles            - Create profile');
        console.log('  PUT  /api/profiles/:id        - Update profile');
        console.log('  DELETE /api/profiles/:id      - Delete profile');
        console.log('  GET  /api/open/:id            - Launch browser');
        console.log('  POST /api/profiles/:id/stop   - Stop browser');
        console.log('  POST /api/profiles/:id/show   - Show window');
        console.log('  GET  /api/settings            - Get settings');
        console.log('  PUT  /api/settings            - Save settings');
        console.log('  GET  /api/export/fingerprint  - Export YAML');
        console.log('  POST /api/import              - Import YAML');
        console.log('\nEnvironment variables:');
        console.log('  CHROME_PATH      - Path to Chrome/Chromium binary');
        console.log('  GEEKEZ_DATA_PATH - Data storage directory');
        console.log('  GEEKEZ_BIN_DIR   - Xray binary directory');
        console.log('  API_PORT         - API server port (default: 3000)');
        console.log('  DISPLAY          - X11 display (default: :0)');
        console.log('');
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        for (const [id, proc] of Object.entries(activeProcesses)) {
            console.log(`Stopping profile ${id}...`);
            await forceKill(proc.xrayPid);
            await forceKill(proc.chromePid);
            try { await proc.browser.close(); } catch (e) { }
        }
        server.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\nTerminating...');
        for (const [id, proc] of Object.entries(activeProcesses)) {
            await forceKill(proc.xrayPid);
            await forceKill(proc.chromePid);
        }
        server.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
