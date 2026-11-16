const { app, BrowserWindow, BrowserView, ipcMain, nativeImage, shell, powerSaveBlocker, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const GITHUB_OWNER = "mdasaduzzamanbabu2001-glitch";
const GITHUB_REPO = "mydesigns-pro";
const DEFAULT_UPDATE_REPO_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main`;

process.on('unhandledRejection', (reason) => {
    if (reason && (reason.code === 'ERR_ABORTED' || String(reason).includes('(-3)'))) return;
    console.error("Unhandled Rejection:", reason);
});

const RAW_CHROME_VER = process.versions.chrome || '124.0.6367.243';
const CHROME_MAJOR = RAW_CHROME_VER.split('.')[0] || '124';
const CHROME_FULL_VERSION = RAW_CHROME_VER;

let nativeElectronUa = (app.userAgentFallback && app.userAgentFallback.includes('Electron/'))
    ? app.userAgentFallback
    : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${app.getName().replace(/\s+/g, '-')}/${app.getVersion()} Chrome/${RAW_CHROME_VER} Electron/${process.versions.electron} Safari/537.36`;

const CLEAN_CHROMIUM_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const FIREFOX_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0`;

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,FedCm,FedCmAuthz');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-ipc-flooding-protection');
app.commandLine.appendSwitch('disable-hang-monitor');
app.commandLine.appendSwitch('log-level', '3');

if (process.platform === 'win32') app.setAppUserModelId("com.mydesigns.pro");

let mainWindow, workerWindow = null, workerInitPromise = null, view = null;
let browserViewInitialized = false, sessionHeadersConfigured = false, stealthPreloadPrepared = false;
let pendingFileForChooser = null, isViewVisible = false, isAutomationRunning = false;
let isDebuggerReady = false, isViewInGoogleLoginMode = false;
let lastValidWindowSize = [1280, 800], lastBoundsKey = '', powerBlockerId = null;
let viewPreloadTimer = null;

const oauthPopupIds = new Set();
const firefoxFallbackPopupIds = new Set();
let autoUpdateTimer = null, isCheckingUpdate = false, lastCheckedSha = null, lastAutoPromptedVersion = null, cachedSubfolderPrefix = '';

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const stripEmojis = (str) => String(str || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s{2,}/g, ' ').trim();

const FINAL_DESIGNS_FOLDER = path.join(os.homedir(), 'Desktop', 'Final_Designs');
const WORK_TEMP_DIR = path.join(app.getPath('userData'), 'mydesigns_temp_work');
const WORKER_HTML_PATH = path.join(WORK_TEMP_DIR, 'mydesigns_worker.html');
const STEALTH_PRELOAD_PATH = path.join(WORK_TEMP_DIR, 'mydesigns_stealth_preload.js');

if (!fs.existsSync(FINAL_DESIGNS_FOLDER)) fs.mkdirSync(FINAL_DESIGNS_FOLDER, { recursive: true });
if (!fs.existsSync(WORK_TEMP_DIR)) fs.mkdirSync(WORK_TEMP_DIR, { recursive: true });

// ==========================================================
// ISOLATED BACKGROUND WORKER PROCESS (LAZY INITIALIZATION)
// ==========================================================
async function ensureWorkerWindow() {
    if (workerWindow && !workerWindow.isDestroyed()) {
        if (workerInitPromise) await workerInitPromise;
        return workerWindow;
    }
    if (workerInitPromise) {
        await workerInitPromise;
        if (workerWindow && !workerWindow.isDestroyed()) return workerWindow;
    }
    workerInitPromise = (async () => {
        if (!fs.existsSync(WORKER_HTML_PATH)) {
            fs.writeFileSync(WORKER_HTML_PATH, '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>', 'utf8');
        }
        const win = new BrowserWindow({
            width: 120, height: 120, show: false, skipTaskbar: true,
            webPreferences: { partition: 'mydesigns_worker_bg', contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, paintWhenInitiallyHidden: true }
        });
        workerWindow = win;
        win.on('closed', () => { if (workerWindow === win) workerWindow = null; });
        await new Promise((resolve) => {
            win.webContents.once('did-finish-load', resolve);
            win.loadFile(WORKER_HTML_PATH);
        });
    })();
    try { await workerInitPromise; } finally { workerInitPromise = null; }
    return workerWindow;
}

async function runInWorkerWindow(script) {
    try {
        const win = await ensureWorkerWindow();
        if (win && !win.isDestroyed()) return await win.webContents.executeJavaScript(script);
    } catch (err) {
        console.error("WorkerWindow fallback:", err);
    }
    if (mainWindow && !mainWindow.isDestroyed()) return await mainWindow.webContents.executeJavaScript(script);
    throw new Error("No renderer window available");
}

function cleanupResources() {
    if (viewPreloadTimer) { clearTimeout(viewPreloadTimer); viewPreloadTimer = null; }
    if (autoUpdateTimer) { clearInterval(autoUpdateTimer); autoUpdateTimer = null; }
    detachDebuggerSafely();
    try { if (workerWindow && !workerWindow.isDestroyed()) workerWindow.destroy(); } catch (e) {}
    workerWindow = null;
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
}

const FREE_OCR_KEYS = ['helloworld', 'K81899588988957', 'K89565132488957', 'K82798126788957', 'K85951423188957'];
let ocrKeyIndex = 0;

function matchHosts(urlStr, list) {
    try {
        const h = new URL(urlStr).hostname.toLowerCase();
        return list.some(d => h === d || h.endsWith('.' + d));
    } catch (e) { return false; }
}
const isGoogleAuthHost = (u) => matchHosts(u, ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com', 'gds.google.com']);
const isGoogleDomainHost = (u) => matchHosts(u, ['google.com', 'gstatic.com', 'googleusercontent.com', 'youtube.com']);

// ==========================================================
// SMART GITHUB AUTO-UPDATE ENGINE
// ==========================================================
function getLocalPackageJson() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')); }
    catch (e) { return { version: app.getVersion() || '1.0.0', updateRepoUrl: DEFAULT_UPDATE_REPO_URL }; }
}

function extractOwnerRepo() {
    try {
        const m = (getLocalPackageJson().updateRepoUrl || DEFAULT_UPDATE_REPO_URL).trim().match(/github(?:usercontent)?\.com\/([^\/]+)\/([^\/]+)/i);
        if (m && m[1] && m[2] && !m[1].includes('YOUR_GITHUB')) return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
    } catch (e) {}
    return { owner: GITHUB_OWNER, repo: GITHUB_REPO };
}

function isNewerVersion(localVer, remoteVer) {
    if (!localVer || !remoteVer) return false;
    const p1 = String(localVer).replace(/[^0-9.]/g, '').split('.').map(Number);
    const p2 = String(remoteVer).replace(/[^0-9.]/g, '').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        if ((p2[i] || 0) > (p1[i] || 0)) return true;
        if ((p2[i] || 0) < (p1[i] || 0)) return false;
    }
    return false;
}

function httpsGetBuffer(urlStr, extraHeaders = {}, timeoutMs = 12000, redirectLeft = 3) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs,
            headers: { 'User-Agent': CLEAN_CHROMIUM_UA, 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', ...extraHeaders }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
                res.resume();
                return httpsGetBuffer(new URL(res.headers.location, urlStr).toString(), extraHeaders, timeoutMs, redirectLeft - 1).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Update check timeout')); });
        req.end();
    });
}

async function getLatestCommitSha(owner, repo) {
    try {
        const buf = await httpsGetBuffer(`https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`, { 'User-Agent': 'git/2.43.0', 'Accept': '*/*' }, 10000);
        let i = 0, refs = {};
        while (i + 4 <= buf.length) {
            const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
            if (isNaN(len)) break;
            if (len === 0) { i += 4; continue; }
            if (len < 4 || i + len > buf.length) break;
            const line = buf.subarray(i + 4, i + len).toString('utf8');
            i += len;
            if (line.startsWith('#')) continue;
            const [sha, refName] = line.split('\0')[0].trim().split(/\s+/);
            if (/^[0-9a-f]{40}$/i.test(sha) && refName) refs[refName] = sha;
        }
        return refs['refs/heads/main'] || refs['refs/heads/master'] || refs['HEAD'] || null;
    } catch (e) { return null; }
}

async function fetchFileFromGitHub(fileName, commitSha = null) {
    const { owner, repo } = extractOwnerRepo();
    const tryRaw = async (ref, prefix = cachedSubfolderPrefix, q = '') =>
        (await httpsGetBuffer(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${prefix}${fileName}${q}`)).toString('utf8');

    if (commitSha) {
        try { return await tryRaw(commitSha); } catch (e) {}
        if (cachedSubfolderPrefix) {
            try { const s = await tryRaw(commitSha, ''); cachedSubfolderPrefix = ''; return s; } catch (e) {}
        }
    }
    for (const branch of ['main', 'master']) {
        try { return await tryRaw(branch, cachedSubfolderPrefix, `?cb=${Date.now()}`); } catch (e) {}
    }

    try {
        const apiHdr = { 'Accept': 'application/vnd.github.v3+json' };
        const items = JSON.parse((await httpsGetBuffer(`https://api.github.com/repos/${owner}/${repo}/contents${commitSha ? `?ref=${commitSha}` : ''}`, apiHdr)).toString('utf8'));
        if (Array.isArray(items)) {
            const direct = items.find(it => it.name?.toLowerCase() === fileName.toLowerCase() && it.download_url);
            if (direct) { cachedSubfolderPrefix = ''; return (await httpsGetBuffer(direct.download_url)).toString('utf8'); }
            for (const d of items.filter(it => it.type === 'dir' && it.url)) {
                const subItems = JSON.parse((await httpsGetBuffer(d.url, apiHdr)).toString('utf8'));
                const subMatch = Array.isArray(subItems) && subItems.find(it => it.name?.toLowerCase() === fileName.toLowerCase() && it.download_url);
                if (subMatch) {
                    cachedSubfolderPrefix = d.path ? `${d.path.replace(/^\/+|\/+$/g, '')}/` : '';
                    return (await httpsGetBuffer(subMatch.download_url)).toString('utf8');
                }
            }
        }
        throw new Error(`File '${fileName}' not found in GitHub repo '${repo}'!`);
    } catch (apiErr) {
        if (String(apiErr.message).includes('404')) throw new Error(`GitHub Repo '${owner}/${repo}' is Private or Not Found! Make it Public.`);
        throw apiErr;
    }
}

async function checkOnlineUpdate(isManual = false) {
    if (!mainWindow || mainWindow.isDestroyed() || (!isManual && isAutomationRunning) || isCheckingUpdate) return;
    isCheckingUpdate = true;
    try {
        const { owner, repo } = extractOwnerRepo();
        const localVersion = getLocalPackageJson().version || '1.0.0';
        const liveSha = await getLatestCommitSha(owner, repo);
        if (!isManual && liveSha && liveSha === lastCheckedSha) return;

        const remotePkg = JSON.parse(await fetchFileFromGitHub('package.json', liveSha));
        const remoteVersion = remotePkg.version || '1.0.0';
        if (liveSha) lastCheckedSha = liveSha;

        if (isNewerVersion(localVersion, remoteVersion)) {
            if (isManual || lastAutoPromptedVersion !== remoteVersion) {
                lastAutoPromptedVersion = remoteVersion;
                const cleanNotes = stripEmojis(remotePkg.updateNotes) || `Version ${remoteVersion} is now available with the latest improvements.`;
                mainWindow.webContents.send('update-available', {
                    currentVersion: localVersion,
                    newVersion: remoteVersion,
                    notes: cleanNotes
                });
            }
        } else if (isManual) {
            mainWindow.webContents.send('update-status', { type: 'toast', message: `Your app is up to date (v${localVersion}).` });
        }
    } catch (err) {
        if (isManual) mainWindow.webContents.send('update-status', { type: 'toast', message: `Update check failed: ${err.message}` });
    } finally {
        isCheckingUpdate = false;
    }
}

async function performLiveOtaUpdate() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const filesToSync = ['package.json', 'main.js', 'preload.js', 'renderer.js', 'index.html'];
    const downloadedFiles = {};
    try {
        const { owner, repo } = extractOwnerRepo();
        const liveSha = await getLatestCommitSha(owner, repo);
        for (let i = 0; i < filesToSync.length; i++) {
            const fileName = filesToSync[i];
            mainWindow.webContents.send('update-status', { type: 'progress', message: `Syncing ${fileName} (${Math.round(((i + 1) / filesToSync.length) * 100)}%)...` });
            const content = await fetchFileFromGitHub(fileName, liveSha);
            if (!content || content.trim().length < 20) throw new Error(`Invalid content received for ${fileName}`);
            if (fileName === 'package.json') {
                const parsedPkg = JSON.parse(content);
                parsedPkg.updateRepoUrl = DEFAULT_UPDATE_REPO_URL;
                downloadedFiles[fileName] = JSON.stringify(parsedPkg, null, 2);
            } else downloadedFiles[fileName] = content;
        }
        for (const fileName of filesToSync) fs.writeFileSync(path.join(__dirname, fileName), downloadedFiles[fileName], 'utf8');
        mainWindow.webContents.send('update-status', { type: 'progress', message: 'Update complete. Restarting application...' });
        cleanupResources();
        await wait(800);
        app.relaunch();
        app.exit(0);
    } catch (err) {
        mainWindow.webContents.send('update-status', { type: 'error', message: `Update failed: ${err.message}` });
    }
}

// ==========================================================
// PRELOAD & HELPER UTILITIES
// ==========================================================
const STEALTH_MAIN_WORLD_SCRIPT = `
(function() {
    const host = (window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : '';
    if (!host || host.includes('google.') || host.includes('gstatic.') || host.includes('googleapis.') || host.includes('firebaseapp.') || host.includes('youtube.') || window.__mydesignsCleanEnvApplied) return;
    window.__mydesignsCleanEnvApplied = true;
    try {
        const NavProto = window.Navigator && window.Navigator.prototype;
        if (NavProto && window.navigator.webdriver !== false) Object.defineProperty(NavProto, 'webdriver', { get: () => false, enumerable: true, configurable: true });
    } catch (e) {}
})();`;

const FIREFOX_AUTH_SHIM_SCRIPT = `
(function() {
    try {
        if (window.chrome) { try { delete window.chrome; } catch (e) {} try { Object.defineProperty(window, 'chrome', { get: () => undefined, configurable: true }); } catch (e) {} }
        const NavProto = window.Navigator && window.Navigator.prototype;
        if (NavProto) {
            Object.defineProperty(NavProto, 'vendor', { get: () => '', configurable: true });
            Object.defineProperty(NavProto, 'userAgentData', { get: () => undefined, configurable: true });
            Object.defineProperty(NavProto, 'webdriver', { get: () => false, configurable: true });
        }
    } catch (e) {}
})();`;

function ensureStealthPreloadFile() {
    if (stealthPreloadPrepared) return;
    const preloadContent = `const { webFrame } = require('electron'); try { webFrame.executeJavaScript(${JSON.stringify(STEALTH_MAIN_WORLD_SCRIPT)}); } catch (e) {}`;
    try {
        if (!fs.existsSync(STEALTH_PRELOAD_PATH) || fs.readFileSync(STEALTH_PRELOAD_PATH, 'utf8') !== preloadContent) {
            fs.writeFileSync(STEALTH_PRELOAD_PATH, preloadContent, 'utf8');
        }
        stealthPreloadPrepared = true;
    } catch (e) {}
}

function getUniqueSvgFileName() {
    const d = new Date();
    const p = (n, l = 2) => n.toString().padStart(l, '0');
    return `Vectorized_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}.svg`;
}

// ==========================================================
// 300 PPI PNG METADATA INJECTOR
// ==========================================================
function setPng300Ppi(pngBuffer, ppi = 300) {
    if (!pngBuffer || pngBuffer.length < 33 || pngBuffer.readUInt32BE(0) !== 0x89504e47) return pngBuffer;
    const physChunk = Buffer.alloc(21);
    physChunk.writeUInt32BE(9, 0);
    physChunk.write('pHYs', 4, 4, 'ascii');
    physChunk.writeUInt32BE(Math.round(ppi / 0.0254), 8);
    physChunk.writeUInt32BE(Math.round(ppi / 0.0254), 12);
    physChunk.writeUInt8(1, 16);

    let crc = 0xffffffff;
    for (let i = 4; i < 17; i++) {
        crc ^= physChunk[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    physChunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 17);

    const chunks = [pngBuffer.subarray(0, 8)];
    let offset = 8, physInserted = false;
    while (offset + 8 <= pngBuffer.length) {
        const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
        const total = 12 + pngBuffer.readUInt32BE(offset);
        if (offset + total > pngBuffer.length) { chunks.push(pngBuffer.subarray(offset)); break; }
        if (type === 'pHYs') { if (!physInserted) { chunks.push(physChunk); physInserted = true; } }
        else { chunks.push(pngBuffer.subarray(offset, offset + total)); if (type === 'IHDR') { chunks.push(physChunk); physInserted = true; } }
        offset += total;
    }
    return Buffer.concat(chunks);
}

// ==========================================================
// DUAL-CONTRAST VISION TITLE ENGINE
// ==========================================================
function httpsPostRequest(urlStr, headers, bodyStr, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: timeoutMs,
            headers: { 'User-Agent': CLEAN_CHROMIUM_UA, 'Accept': 'application/json, text/plain, */*', ...headers, 'Content-Length': Buffer.byteLength(bodyStr) }
        }, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`HTTP ${res.statusCode}`)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

async function prepareDualContrastImages(rawBase64DataUrl) {
    try {
        return await runInWorkerWindow(`(async () => {
            const img = new Image();
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(rawBase64DataUrl)}; });
            const box = 620, scale = Math.min((box - 36) / (img.width || box), (box - 36) / (img.height || box));
            const w = Math.max(1, Math.round((img.width || box) * scale)), h = Math.max(1, Math.round((img.height || box) * scale));
            const ox = Math.round((box - w) / 2), oy = Math.round((box - h) / 2);
            const mk = (bg) => { const c = document.createElement('canvas'); c.width = box; c.height = box; const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, box, box); x.drawImage(img, ox, oy, w, h); return c; };
            const cWhite = mk('#FFFFFF'), cBlack = mk('#111111');
            const cStacked = document.createElement('canvas'); cStacked.width = box; cStacked.height = box * 2;
            const ctxS = cStacked.getContext('2d'); ctxS.drawImage(cWhite, 0, 0); ctxS.drawImage(cBlack, 0, box);
            const out = { whiteDataUrl: cWhite.toDataURL('image/jpeg', 0.85), blackDataUrl: cBlack.toDataURL('image/jpeg', 0.85), stackedDataUrl: cStacked.toDataURL('image/jpeg', 0.82), boxSize: box };
            cWhite.width = cWhite.height = cBlack.width = cBlack.height = cStacked.width = cStacked.height = 0; img.src = '';
            return out;
        })();`);
    } catch (e) {
        let fb = rawBase64DataUrl;
        try {
            const nImg = nativeImage.createFromBuffer(Buffer.from(rawBase64DataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64'));
            if (!nImg.isEmpty()) fb = `data:image/jpeg;base64,${nImg.resize({ width: 620 }).toJPEG(85).toString('base64')}`;
        } catch (err) {}
        return { whiteDataUrl: fb, blackDataUrl: fb, stackedDataUrl: fb, boxSize: 620 };
    }
}

const CONTRACTION_FIXES = [
    [/\r?\n/g, ' '], [/\bWR\s*[0O]?\s*NG\b/gi, 'Wrong'], [/\bL\s*[0O]?\s*VE\b/gi, 'Love'], [/\bH\s*[0O]?\s*PE\b/gi, 'Hope'],
    [/\bFA\s*[I1L]?\s*TH\b/gi, 'Faith'], [/\bSTR\s*[0O]?\s*NG\b/gi, 'Strong'], [/\bI\s*['’`]\s*m\b/gi, 'I Am'],
    [/\bI\s+m\b/gi, 'I Am'], [/\bI\s*['’`]\s*d\b/gi, 'I Would'], [/\bdon\s*['’`]\s*t\b/gi, 'Do Not'],
    [/\bcan\s*['’`]\s*t\b/gi, 'Can Not'], [/\bwon\s*['’`]\s*t\b/gi, 'Will Not'], [/\bit\s*['’`]\s*s\b/gi, 'It Is'],
    [/\bthat\s*['’`]\s*s\b/gi, 'That Is'], [/\bwhat\s*['’`]\s*s\b/gi, 'What Is'], [/\bshe\s*['’`]\s*s\b/gi, 'She Is'],
    [/\bhe\s*['’`]\s*s\b/gi, 'He Is'], [/\byou\s*['’`]\s*re\b/gi, 'You Are'], [/\bwe\s*['’`]\s*re\b/gi, 'We Are'],
    [/\bthey\s*['’`]\s*re\b/gi, 'They Are'], [/\bisn\s*['’`]\s*t\b/gi, 'Is Not'], [/\baren\s*['’`]\s*t\b/gi, 'Are Not'],
    [/\bdidn\s*['’`]\s*t\b/gi, 'Did Not'], [/\bdoesn\s*['’`]\s*t\b/gi, 'Does Not'], [/\blet\s*['’`]\s*s\b/gi, 'Let Us']
];
const DANGLING_ENDINGS = new Set(['and', 'or', 'but', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'about', 'that', 'because', 'as', 'is', 'are']);

function formatStoreReadyTitleFromText(rawText) {
    if (!rawText) return "";
    let text = rawText;
    for (const [re, rep] of CONTRACTION_FIXES) text = text.replace(re, rep);

    const clauseParts = text.split(/\.\.\.|\bAS LONG AS\b|\bBECAUSE\b|\bTHEN ALWAYS\b|[?!;]/i);
    if (clauseParts.length > 1 && clauseParts[0].trim()) {
        if (clauseParts[0].replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).length >= 4) text = clauseParts[0];
    }
    if (text.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).length >= 6) {
        text = text.replace(/\b(T1D|TYPE\s*1|TYPE\s*2)?\s*AWARENESS\s*$/i, '').trim();
    }

    let words = text.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 1 || /^[ia]$/i.test(w));
    if (words.length === 0) return "";
    if (words.length >= 8 && /^anymore$/i.test(words[words.length - 1])) words.pop();
    if (words.length > 9) words = words.slice(0, 9);
    while (words.length > 3 && DANGLING_ENDINGS.has(words[words.length - 1].toLowerCase())) words.pop();

    const finalTitle = words.join(' ').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substring(1).toLowerCase());
    return finalTitle.length >= 2 ? finalTitle : "";
}

async function scanWithFreeNeuralOcr(stackedDataUrl, boxSize) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const activeOcrKey = FREE_OCR_KEYS[ocrKeyIndex++ % FREE_OCR_KEYS.length];
        try {
            const postBody = new URLSearchParams({ apikey: activeOcrKey, base64Image: stackedDataUrl, language: 'eng', OCREngine: '2', isOverlayRequired: 'true', scale: 'true' }).toString();
            const parsedRes = JSON.parse(await httpsPostRequest('https://api.ocr.space/parse/image', { 'Content-Type': 'application/x-www-form-urlencoded' }, postBody, 9500))?.ParsedResults?.[0];
            if (!parsedRes) continue;

            const lines = parsedRes?.TextOverlay?.Lines || [];
            if (lines.length > 0) {
                const top = [], bot = [];
                for (const ln of lines) {
                    const txt = (ln.LineText || '').trim();
                    if (!txt) continue;
                    const y = Number(ln.MinTop) || 0;
                    if (y < boxSize - 10) top.push({ y, text: txt });
                    else bot.push({ y: y - boxSize, text: txt });
                }
                top.sort((a, b) => a.y - b.y);
                bot.sort((a, b) => a.y - b.y);
                const merged = [...top];
                for (const b of bot) {
                    const idx = merged.findIndex(t => Math.abs(t.y - b.y) < 28);
                    if (idx === -1) merged.push(b);
                    else if (b.text.replace(/[^a-zA-Z0-9]/g, '').length > merged[idx].text.replace(/[^a-zA-Z0-9]/g, '').length) merged[idx] = b;
                }
                merged.sort((a, b) => a.y - b.y);
                const cands = [merged, top, bot].map(arr => formatStoreReadyTitleFromText(arr.map(l => l.text).join(' '))).filter(Boolean);
                if (cands.length > 0) return cands[0];
            }
            const title = formatStoreReadyTitleFromText((parsedRes.ParsedText || '').trim());
            if (title) return title;
        } catch (e) {}
    }
    return "";
}

async function scanWithLocalTesseractInWindow(whiteDataUrl, blackDataUrl) {
    try {
        const raw = await runInWorkerWindow(`(async () => {
            if (!window.Tesseract) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
            if (!window.__ocrWorker) window.__ocrWorker = await window.Tesseract.createWorker('eng');
            const t1 = ((await window.__ocrWorker.recognize(${JSON.stringify(whiteDataUrl)}))?.data?.text || '').trim();
            if (t1.replace(/[^a-zA-Z]/g, '').length >= 6) return t1;
            const t2 = ((await window.__ocrWorker.recognize(${JSON.stringify(blackDataUrl)}))?.data?.text || '').trim();
            return t2.length > t1.length ? t2 : t1;
        })();`);
        return formatStoreReadyTitleFromText(raw);
    } catch (e) { return ""; }
}

async function generateAiTitleNode(rawBase64DataUrl, customApiKey) {
    const { whiteDataUrl, blackDataUrl, stackedDataUrl, boxSize } = await prepareDualContrastImages(rawBase64DataUrl);
    const userKey = (customApiKey || '').trim();
    if (userKey && (userKey.startsWith('sk-') || userKey.startsWith('ghp_') || userKey.startsWith('github_pat_'))) {
        try {
            const endpoint = userKey.startsWith('sk-') ? 'https://api.openai.com/v1/chat/completions' : 'https://models.inference.ai.azure.com/chat/completions';
            const payload = JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.1, max_tokens: 40, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this T-shirt design carefully and output ONLY one catchy, store-upload-friendly title (3 to 8 words, Title Case, no quotes or punctuation).' }, { type: 'image_url', image_url: { url: stackedDataUrl } }] }] });
            const clean = formatStoreReadyTitleFromText((JSON.parse(await httpsPostRequest(endpoint, { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userKey}` }, payload, 9000))?.choices?.[0]?.message?.content || '').trim());
            if (clean) return clean;
        } catch (e) {}
    }
    return (await scanWithFreeNeuralOcr(stackedDataUrl, boxSize)) || (await scanWithLocalTesseractInWindow(whiteDataUrl, blackDataUrl)) || "Vintage Graphic Art Print";
}

// ==========================================================
// PATHFINDER DIVIDE + MAGIC WAND + 5000px FIT & TRIM ENGINE
// ==========================================================
function detectImageBgRgbFromBase64(rawBase64DataUrl) {
    try {
        const nImg = nativeImage.createFromBuffer(Buffer.from(rawBase64DataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64'));
        if (!nImg.isEmpty()) {
            const bmp = nImg.resize({ width: 40, height: 40 }).toBitmap();
            const pts = [[1,1],[38,1],[1,38],[38,38],[10,1],[29,1],[10,38],[29,38],[1,10],[1,29],[38,10],[38,29]];
            const samples = pts.map(([x, y]) => { const i = (y * 40 + x) * 4; return { r: bmp[i+2], g: bmp[i+1], b: bmp[i], a: bmp[i+3] }; }).filter(p => p.a > 200);
            if (samples.length >= 2) {
                let best = { count: 0, r: samples[0].r, g: samples[0].g, b: samples[0].b };
                for (const s of samples) {
                    const near = samples.filter(o => Math.abs(s.r - o.r) <= 10 && Math.abs(s.g - o.g) <= 10 && Math.abs(s.b - o.b) <= 10);
                    if (near.length > best.count) {
                        const n = near.length;
                        best = { count: n, r: Math.round(near.reduce((a, b) => a + b.r, 0) / n), g: Math.round(near.reduce((a, b) => a + b.g, 0) / n), b: Math.round(near.reduce((a, b) => a + b.b, 0) / n) };
                    }
                }
                return { r: best.r, g: best.g, b: best.b, hasOpaqueBg: true };
            }
        }
    } catch (e) {}
    return { r: 0, g: 0, b: 0, hasOpaqueBg: false };
}

async function processSvgStandaloneInApp(svgPath, origBase64, readyTitle, toleranceVal) {
    const bgRgb = detectImageBgRgbFromBase64(origBase64);
    const svgRawText = fs.readFileSync(svgPath, 'utf8');
    const tol = Number(toleranceVal) || 10;

    const trimmedPngDataUrl = await runInWorkerWindow(`(async () => {
        const rawSvg = ${JSON.stringify(svgRawText)}, origBg = ${JSON.stringify(bgRgb)}, userTol = ${tol};
        const svgEl = new DOMParser().parseFromString(rawSvg, "image/svg+xml").querySelector("svg");
        if (!svgEl || svgEl.querySelector("parsererror")) throw new Error("Invalid SVG file");
        if (!svgEl.getAttribute("xmlns")) svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        svgEl.style.setProperty("background", "none", "important");
        svgEl.style.setProperty("background-color", "transparent", "important");

        const tempContainer = document.createElement("div");
        tempContainer.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:1024px;height:1024px;opacity:0;pointer-events:none;";
        tempContainer.appendChild(svgEl);
        document.body.appendChild(tempContainer);

        try {
            let origVbW = 1024, origVbH = 1024, vbMinX = 0, vbMinY = 0;
            const vb = svgEl.getAttribute("viewBox");
            if (vb) {
                const p = vb.trim().split(/[\\s,]+/).map(Number);
                if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) [vbMinX, vbMinY, origVbW, origVbH] = p;
            } else {
                const wR = svgEl.getAttribute("width") || "", hR = svgEl.getAttribute("height") || "";
                const wA = !wR.includes("%") ? parseFloat(wR) : NaN, hA = !hR.includes("%") ? parseFloat(hR) : NaN;
                if (Number.isFinite(wA) && Number.isFinite(hA) && wA > 0 && hA > 0) { origVbW = wA; origVbH = hA; }
                else { try { const bb = svgEl.getBBox(); if (bb?.width > 0 && bb?.height > 0) { vbMinX = bb.x; vbMinY = bb.y; origVbW = bb.width; origVbH = bb.height; } } catch (e) {} }
                svgEl.setAttribute("viewBox", vbMinX + " " + vbMinY + " " + origVbW + " " + origVbH);
            }

            async function renderSvgToCanvas(targetSvg, w, h) {
                const clone = targetSvg.cloneNode(true);
                clone.setAttribute("width", w + "px"); clone.setAttribute("height", h + "px");
                clone.style.width = w + "px"; clone.style.height = h + "px";
                const domUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
                const img = new Image();
                try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = domUrl; }); }
                finally { URL.revokeObjectURL(domUrl); }
                const canvas = document.createElement("canvas");
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
                ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); img.src = '';
                return { canvas, ctx };
            }

            function parseRgbString(str) {
                if (!str || str === "none" || str === "transparent") return null;
                const m = str.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/i);
                return (m && !(m[4] !== undefined && parseFloat(m[4]) < 0.05)) ? [+m[1], +m[2], +m[3]] : null;
            }

            const probeScale = 256 / Math.max(origVbW, origVbH);
            const probeW = Math.max(24, Math.round(origVbW * probeScale)), probeH = Math.max(24, Math.round(origVbH * probeScale));
            const { canvas: probeCanvas, ctx: probeCtx } = await renderSvgToCanvas(svgEl, probeW, probeH);
            const probeData = probeCtx.getImageData(0, 0, probeW, probeH).data;
            probeCanvas.width = probeCanvas.height = 0;

            const opaquePerim = [];
            const samplePt = (px, py) => {
                if (px < 0 || px >= probeW || py < 0 || py >= probeH) return;
                const i = (py * probeW + px) * 4;
                if (probeData[i + 3] >= 180) opaquePerim.push([probeData[i], probeData[i + 1], probeData[i + 2]]);
            };
            const stepX = Math.max(2, Math.floor(probeW / 24)), stepY = Math.max(2, Math.floor(probeH / 24));
            for (const ins of [1, 3]) {
                for (let x = ins; x < probeW - ins; x += stepX) { samplePt(x, ins); samplePt(x, probeH - 1 - ins); }
                for (let y = ins; y < probeH - ins; y += stepY) { samplePt(ins, y); samplePt(probeW - 1 - ins, y); }
            }
            [[0,0],[probeW-1,0],[0,probeH-1],[probeW-1,probeH-1]].forEach(([x,y]) => samplePt(x,y));

            let hasBgToRemove = false, targetR = origBg.r, targetG = origBg.g, targetB = origBg.b;
            if (opaquePerim.length >= 10) {
                const clusters = [];
                for (const px of opaquePerim) {
                    const c = clusters.find(k => Math.abs(k.r - px[0]) <= 8 && Math.abs(k.g - px[1]) <= 8 && Math.abs(k.b - px[2]) <= 8);
                    if (c) {
                        c.sumR += px[0]; c.sumG += px[1]; c.sumB += px[2]; c.count++;
                        c.r = Math.round(c.sumR / c.count); c.g = Math.round(c.sumG / c.count); c.b = Math.round(c.sumB / c.count);
                    } else clusters.push({ r: px[0], g: px[1], b: px[2], sumR: px[0], sumG: px[1], sumB: px[2], count: 1 });
                }
                clusters.sort((a, b) => b.count - a.count);
                let chosen = origBg.hasOpaqueBg
                    ? clusters.find(c => c.count >= Math.max(3, Math.floor(clusters[0].count * 0.2)) && Math.max(Math.abs(c.r - origBg.r), Math.abs(c.g - origBg.g), Math.abs(c.b - origBg.b)) <= 25)
                    : null;
                if (!chosen && (origBg.hasOpaqueBg || clusters[0].count >= opaquePerim.length * 0.4)) chosen = clusters[0];
                if (chosen) { targetR = chosen.r; targetG = chosen.g; targetB = chosen.b; hasBgToRemove = true; }
            }

            const tolRgb = Math.max(1, Math.round(userTol * 1.15));
            const isBgMatch = (rgb) => Boolean(rgb && hasBgToRemove && Math.max(Math.abs(rgb[0] - targetR), Math.abs(rgb[1] - targetG), Math.abs(rgb[2] - targetB)) <= tolRgb);
            const allShapes = Array.from(svgEl.querySelectorAll("path, rect, polygon, circle, ellipse, polyline, line")).filter(el => !el.closest("defs, clipPath, mask, symbol, pattern"));
            const records = [];
            for (const el of allShapes) {
                const comp = getComputedStyle(el);
                if (comp.display === "none" || comp.visibility === "hidden" || parseFloat(comp.opacity) < 0.02) continue;

                const fOp = parseFloat(comp.fillOpacity);
                let fillType = "none", fillRgb = null, rawFill = "none";
                if (comp.fill && comp.fill !== "none" && comp.fill !== "transparent" && (isNaN(fOp) || fOp >= 0.05)) {
                    if (comp.fill.trim().toLowerCase().startsWith("url(")) { fillType = "url"; rawFill = comp.fill; }
                    else { fillRgb = parseRgbString(comp.fill); if (fillRgb) fillType = "rgb"; }
                }

                const sOp = parseFloat(comp.strokeOpacity), sW = parseFloat(comp.strokeWidth);
                let strokeType = "none", strokeRgb = null, rawStroke = "none";
                if (comp.stroke && comp.stroke !== "none" && comp.stroke !== "transparent" && (isNaN(sOp) || sOp >= 0.05) && (isNaN(sW) || sW > 0)) {
                    if (comp.stroke.trim().toLowerCase().startsWith("url(")) { strokeType = "url"; rawStroke = comp.stroke; }
                    else { strokeRgb = parseRgbString(comp.stroke); if (strokeRgb) strokeType = "rgb"; }
                }
                if (fillType === "none" && strokeType === "none") continue;

                const isBgFill = fillType === "rgb" && isBgMatch(fillRgb);
                const isBgStroke = strokeType === "rgb" && isBgMatch(strokeRgb);
                records.push({
                    el, fillType, fillRgb, rawFill, fillRule: comp.fillRule || el.getAttribute("fill-rule") || "nonzero",
                    strokeType, strokeRgb, rawStroke, strokeWidth: comp.strokeWidth || el.getAttribute("stroke-width") || "1",
                    isBgFill, isBgStroke, isPureBgElement: (isBgFill && (strokeType === "none" || isBgStroke)) || (fillType === "none" && isBgStroke)
                });
            }

            const firstFgIdx = records.findIndex(r => !r.isPureBgElement);
            const needsMask = hasBgToRemove && firstFgIdx !== -1 && records.some((r, idx) => idx > firstFgIdx && (r.isBgFill || r.isBgStroke));
            const svgNs = "http://www.w3.org/2000/svg";
            let defsEl = svgEl.querySelector("defs");

            if (needsMask) {
                if (!defsEl) { defsEl = document.createElementNS(svgNs, "defs"); svgEl.insertBefore(defsEl, svgEl.firstChild); }
                records.forEach((r, idx) => r.el.setAttribute("data-ai-idx", String(idx)));
                const maskEl = document.createElementNS(svgNs, "mask");
                maskEl.setAttribute("id", "ai-pure-vector-divide-mask"); maskEl.setAttribute("maskUnits", "userSpaceOnUse");
                maskEl.setAttribute("x", String(vbMinX - origVbW)); maskEl.setAttribute("y", String(vbMinY - origVbH));
                maskEl.setAttribute("width", String(origVbW * 3)); maskEl.setAttribute("height", String(origVbH * 3));

                const baseMaskRect = document.createElementNS(svgNs, "rect");
                baseMaskRect.setAttribute("x", String(vbMinX - origVbW)); baseMaskRect.setAttribute("y", String(vbMinY - origVbH));
                baseMaskRect.setAttribute("width", String(origVbW * 3)); baseMaskRect.setAttribute("height", String(origVbH * 3));
                baseMaskRect.setAttribute("fill", "#ffffff"); baseMaskRect.setAttribute("stroke", "none");
                maskEl.appendChild(baseMaskRect);

                Array.from(svgEl.childNodes).filter(n => n !== defsEl && n.nodeName.toLowerCase() !== "style").forEach(n => maskEl.appendChild(n.cloneNode(true)));
                maskEl.querySelectorAll("g").forEach(g => { const gOp = parseFloat(g.getAttribute("opacity") || g.style.opacity || "1"); if (!isNaN(gOp) && gOp >= 0.02 && gOp < 1) g.style.setProperty("opacity", "1", "important"); });

                for (const mEl of Array.from(maskEl.querySelectorAll("[data-ai-idx]"))) {
                    const idx = parseInt(mEl.getAttribute("data-ai-idx"), 10);
                    mEl.removeAttribute("data-ai-idx");
                    const rec = records[idx];
                    if (!rec) continue;
                    if (idx < firstFgIdx) { mEl.remove(); continue; }
                    if (rec.fillType !== "none") {
                        mEl.style.setProperty("fill", rec.isBgFill ? "#000000" : "#ffffff", "important");
                        mEl.style.setProperty("fill-opacity", "1", "important");
                        mEl.style.setProperty("fill-rule", rec.fillRule, "important");
                    } else mEl.style.setProperty("fill", "none", "important");
                    if (rec.strokeType !== "none") {
                        mEl.style.setProperty("stroke", rec.isBgStroke ? "#000000" : "#ffffff", "important");
                        mEl.style.setProperty("stroke-opacity", "1", "important");
                        mEl.style.setProperty("stroke-width", rec.strokeWidth, "important");
                    } else mEl.style.setProperty("stroke", "none", "important");
                }
                defsEl.appendChild(maskEl);
            }

            for (const rec of records) {
                rec.el.removeAttribute("data-ai-idx");
                if (rec.isPureBgElement) { rec.el.remove(); continue; }
                rec.el.style.setProperty("fill", rec.isBgFill ? "none" : (rec.fillType === "rgb" ? ("rgb(" + rec.fillRgb.join(",") + ")") : (rec.fillType === "url" ? rec.rawFill : "none")), "important");
                rec.el.style.setProperty("fill-rule", rec.fillRule, "important");
                rec.el.style.setProperty("stroke", rec.isBgStroke ? "none" : (rec.strokeType === "rgb" ? ("rgb(" + rec.strokeRgb.join(",") + ")") : (rec.strokeType === "url" ? rec.rawStroke : "none")), "important");
            }

            if (needsMask) {
                const maskGroup = document.createElementNS(svgNs, "g");
                maskGroup.setAttribute("mask", "url(#ai-pure-vector-divide-mask)");
                Array.from(svgEl.childNodes).filter(n => n !== defsEl && n.nodeName.toLowerCase() !== "style").forEach(n => maskGroup.appendChild(n));
                svgEl.appendChild(maskGroup);
            }

            const ARTBOARD_SIZE = 5000, mScale = 2000 / Math.max(origVbW, origVbH);
            const mW = Math.max(1, Math.round(origVbW * mScale)), mH = Math.max(1, Math.round(origVbH * mScale));
            const { canvas: mCanvas, ctx: mCtx } = await renderSvgToCanvas(svgEl, mW, mH);
            const mData = mCtx.getImageData(0, 0, mW, mH).data;
            mCanvas.width = mCanvas.height = 0;

            const getAlphaBox = (buf, w, h, thresh) => {
                let minX = w, minY = h, maxX = -1, maxY = -1;
                for (let y = 0; y < h; y++) for (let x = 0, r = y * w * 4; x < w; x++) {
                    if (buf[r + x * 4 + 3] > thresh) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
                }
                return { minX, minY, maxX, maxY };
            };

            const mb = getAlphaBox(mData, mW, mH, 2);
            if (mb.maxX >= mb.minX && mb.maxY >= mb.minY) {
                const sx = mW / origVbW, sy = mH / origVbH;
                const tw = (mb.maxX - mb.minX + 1) / sx, th = (mb.maxY - mb.minY + 1) / sy;
                const padVb = 4 / (ARTBOARD_SIZE / Math.max(tw, th));
                origVbW = tw + padVb * 2; origVbH = th + padVb * 2;
                svgEl.setAttribute("viewBox", (vbMinX + mb.minX / sx - padVb) + " " + (vbMinY + mb.minY / sy - padVb) + " " + origVbW + " " + origVbH);
            }

            const dScale = ARTBOARD_SIZE / Math.max(origVbW, origVbH);
            const rW = Math.max(1, Math.round(origVbW * dScale)), rH = Math.max(1, Math.round(origVbH * dScale));
            const { canvas: c1, ctx: ctx1 } = await renderSvgToCanvas(svgEl, rW, rH);
            let fb = getAlphaBox(ctx1.getImageData(0, 0, rW, rH).data, rW, rH, 3);
            if (fb.maxX < fb.minX || fb.maxY < fb.minY) fb = { minX: 0, minY: 0, maxX: rW - 1, maxY: rH - 1 };

            const trimW = fb.maxX - fb.minX + 1, trimH = fb.maxY - fb.minY + 1;
            const fScale = ARTBOARD_SIZE / Math.max(trimW, trimH);
            const c2 = document.createElement("canvas");
            c2.width = Math.max(1, Math.round(trimW * fScale));
            c2.height = Math.max(1, Math.round(trimH * fScale));
            const ctx2 = c2.getContext("2d");
            ctx2.imageSmoothingEnabled = true; ctx2.imageSmoothingQuality = "high";
            ctx2.drawImage(c1, fb.minX, fb.minY, trimW, trimH, 0, 0, c2.width, c2.height);

            const resultDataUrl = c2.toDataURL("image/png");
            c1.width = c1.height = c2.width = c2.height = 0;
            return resultDataUrl;
        } finally { tempContainer.remove(); }
    })();`);

    const safeTitle = (readyTitle || 'Vintage Graphic Art Print').replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Vintage Graphic Art Print';
    let finalSavePath = path.join(FINAL_DESIGNS_FOLDER, `${safeTitle}.png`), counter = 1;
    while (fs.existsSync(finalSavePath)) finalSavePath = path.join(FINAL_DESIGNS_FOLDER, `${safeTitle} ${counter++}.png`);

    fs.writeFileSync(finalSavePath, setPng300Ppi(Buffer.from(trimmedPngDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'), 300));
    return path.basename(finalSavePath);
}

// ==========================================================
// CDP + CURSOR ENGINE
// ==========================================================
async function ensureDebugger(forceSetup = false) {
    if (!view || !view.webContents || view.webContents.isDestroyed()) return null;
    const dbg = view.webContents.debugger;
    let justAttached = false;
    if (!dbg.isAttached()) {
        try {
            dbg.attach('1.3');
            justAttached = true; isDebuggerReady = false;
            if (!dbg.__detachListenerAdded) { dbg.__detachListenerAdded = true; dbg.on('detach', () => { isDebuggerReady = false; }); }
        } catch (err) {}
        if (!dbg.__fileChooserHooked) {
            dbg.__fileChooserHooked = true;
            dbg.on('message', async (_e, method, params) => {
                if (method === 'Page.fileChooserOpened' && pendingFileForChooser) {
                    const file = pendingFileForChooser; pendingFileForChooser = null;
                    try { await dbg.sendCommand('DOM.enable').catch(() => {}); await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], backendNodeId: params.backendNodeId }); }
                    catch (e) {} finally { await dbg.sendCommand('DOM.disable').catch(() => {}); }
                }
            });
        }
    }
    if (justAttached || forceSetup || !isDebuggerReady) {
        try {
            if (justAttached || !isDebuggerReady) { await dbg.sendCommand('Page.enable'); await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); }
            await dbg.sendCommand('Page.setWebLifecycleState', { state: 'active' });
            isDebuggerReady = true;
        } catch (e) {}
    }
    return dbg;
}

function detachDebuggerSafely() {
    isDebuggerReady = false;
    try { if (view && view.webContents && !view.webContents.isDestroyed() && view.webContents.debugger.isAttached()) view.webContents.debugger.detach(); } catch (e) {}
}

async function animateSimpleCursor(x, y, fast = false) {
    const glideMs = fast ? 55 : 145;
    try {
        await view.webContents.executeJavaScript(`(() => {
            if (!document.getElementById('simple-cur-css')) {
                const s = document.createElement('style'); s.id = 'simple-cur-css';
                s.textContent = '#simple-cur{position:fixed;top:0;left:0;width:24px;height:24px;pointer-events:none!important;z-index:2147483647!important;will-change:transform;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}#simple-cur .arr{width:100%;height:100%;transform-origin:2px 2px;transition:transform 65ms ease}#simple-cur.clk .arr{transform:scale(.84)}.simple-dot{position:fixed;width:18px;height:18px;border-radius:50%;border:2px solid rgba(56,189,248,.7);pointer-events:none!important;z-index:2147483646!important;animation:sDot .18s ease-out forwards}@keyframes sDot{0%{transform:translate(-50%,-50%) scale(.4);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}';
                document.head.appendChild(s);
            }
            let c = document.getElementById('simple-cur');
            if (!c) {
                c = document.createElement('div'); c.id = 'simple-cur';
                window.__sCur = { x: innerWidth / 2, y: innerHeight / 2 };
                c.style.transform = 'translate3d(' + window.__sCur.x + 'px,' + window.__sCur.y + 'px,0)';
                c.innerHTML = '<div class="arr"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3 2L20 11.5L12.5 13.8L9 21L3 2Z" fill="#fff" stroke="#111827" stroke-width="1.8" stroke-linejoin="round"/></svg></div>';
                document.body.appendChild(c);
            }
            const p = window.__sCur || { x: innerWidth / 2, y: innerHeight / 2 }, ex = ${x}, ey = ${y}, dur = ${glideMs};
            window.__sCur = { x: ex, y: ey };
            if (c.getAnimations) c.getAnimations().forEach(a => a.cancel());
            if (c.animate) {
                c.animate([{ transform: 'translate3d(' + p.x + 'px,' + p.y + 'px,0)' }, { transform: 'translate3d(' + ex + 'px,' + ey + 'px,0)' }], { duration: dur, easing: 'cubic-bezier(.22,1,.36,1)' })
                 .onfinish = () => { c.style.transform = 'translate3d(' + ex + 'px,' + ey + 'px,0)'; };
            } else c.style.transform = 'translate3d(' + ex + 'px,' + ey + 'px,0)';
            setTimeout(() => {
                if (!c) return;
                c.style.transform = 'translate3d(' + ex + 'px,' + ey + 'px,0)'; c.classList.add('clk');
                const d = document.createElement('div'); d.className = 'simple-dot'; d.style.left = ex + 'px'; d.style.top = ey + 'px';
                document.body.appendChild(d);
                setTimeout(() => c.classList.remove('clk'), 85);
                setTimeout(() => d.remove(), 200);
            }, dur);
        })();`);
    } catch (e) {}
}

async function removeSimpleCursor() {
    try { if (view && view.webContents && !view.webContents.isDestroyed()) await view.webContents.executeJavaScript(`document.getElementById('simple-cur')?.remove();`); } catch (e) {}
}

async function cdpClick(x, y, fast = false) {
    const dbg = await ensureDebugger(false);
    if (!dbg) return;
    const rx = Math.round(x), ry = Math.round(y);
    await animateSimpleCursor(rx, ry, fast);
    await wait(fast ? 60 : 155);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rx, y: ry, button: 'none' });
    await wait(fast ? 10 : 35);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: rx, y: ry, button: 'left', buttons: 1, clickCount: 1 });
    await wait(fast ? 12 : 35);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rx, y: ry, button: 'left', buttons: 1, clickCount: 1 });
    await wait(fast ? 15 : 60);
}

function updateViewBounds() {
    if (!mainWindow || !view || mainWindow.isDestroyed() || !view.webContents || view.webContents.isDestroyed()) return;
    if (!mainWindow.isMinimized()) {
        const [w, h] = mainWindow.getContentSize();
        if (w > 200 && h > 200) lastValidWindowSize = [w, h];
    }
    const [w, h] = lastValidWindowSize;
    const b = isViewVisible
        ? { x: 0, y: 216, width: w, height: Math.max(300, h - 216) }
        : { x: 0, y: Math.max(4000, h + 500), width: Math.max(1000, w), height: Math.max(530, h - 216) };
    const k = `${b.x},${b.y},${b.width},${b.height}`;
    if (k !== lastBoundsKey) { lastBoundsKey = k; view.setBounds(b); }
}

// ==========================================================
// UNIVERSAL GOOGLE LOGIN SHIELD
// ==========================================================
async function clearGoogleRejectionCookies(ses) {
    try {
        for (const dom of ['google.com', 'accounts.google.com', 'youtube.com']) {
            for (const c of await ses.cookies.get({ domain: dom })) {
                await ses.cookies.remove(`https://${c.domain.startsWith('.') ? c.domain.slice(1) : c.domain}${c.path || '/'}`, c.name).catch(() => {});
            }
        }
    } catch (e) {}
}

function stripUaHeaders(headers, onlyUaAndCh) {
    for (const k of Object.keys(headers)) {
        const lk = k.toLowerCase();
        if (onlyUaAndCh ? (lk === 'user-agent' || lk.startsWith('sec-ch-ua')) : ['user-agent', 'sec-ch-ua', 'sec-ch-ua-full-version-list', 'sec-ch-ua-full-version', 'sec-ch-ua-platform', 'sec-ch-ua-mobile'].includes(lk)) {
            delete headers[k];
        }
    }
}

function configurePersistSessionHeaders() {
    if (sessionHeadersConfigured) return;
    sessionHeadersConfigured = true;
    ensureStealthPreloadFile();
    const ses = session.fromPartition('persist:mydesigns_pro');
    const CH_UA = `"Not-A.Brand";v="99", "Chromium";v="${CHROME_MAJOR}"`;
    const CH_UA_FULL = `"Not-A.Brand";v="99.0.0.0", "Chromium";v="${CHROME_FULL_VERSION}"`;

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders || {}, wcId = details.webContentsId;
        const isViewValid = Boolean(view && view.webContents && !view.webContents.isDestroyed());
        const viewId = isViewValid ? view.webContents.id : -1;

        if (typeof wcId === 'number' && firefoxFallbackPopupIds.has(wcId)) {
            stripUaHeaders(headers, true); headers['User-Agent'] = FIREFOX_UA;
            return callback({ cancel: false, requestHeaders: headers });
        }
        if ((typeof wcId === 'number' && oauthPopupIds.has(wcId)) || (isViewValid && wcId === viewId && isViewInGoogleLoginMode)) {
            return callback({ cancel: false, requestHeaders: headers });
        }
        if (isViewValid && wcId === viewId) {
            stripUaHeaders(headers, false);
            headers['User-Agent'] = CLEAN_CHROMIUM_UA; headers['sec-ch-ua'] = CH_UA;
            headers['sec-ch-ua-mobile'] = '?0'; headers['sec-ch-ua-platform'] = '"Windows"';
            headers['sec-ch-ua-full-version'] = `"${CHROME_FULL_VERSION}"`; headers['sec-ch-ua-full-version-list'] = CH_UA_FULL;
        }
        callback({ cancel: false, requestHeaders: headers });
    });
}

const getCleanOAuthPopupOptions = () => ({
    width: 540, height: 700, center: true, autoHideMenuBar: true, title: "Google Sign-In",
    webPreferences: { partition: 'persist:mydesigns_pro', contextIsolation: true, nodeIntegration: false, sandbox: true, nativeWindowOpen: true }
});

function attachGoogleLoginShieldToPopup(childWin) {
    if (!childWin || childWin.isDestroyed()) return;
    const wcId = childWin.webContents.id;
    oauthPopupIds.add(wcId);
    childWin.webContents.setUserAgent(nativeElectronUa);
    let lastUrl = '', stage = 0;

    childWin.on('closed', () => { oauthPopupIds.delete(wcId); firefoxFallbackPopupIds.delete(wcId); });
    childWin.webContents.setWindowOpenHandler(() => {
        if (!isAutomationRunning) detachDebuggerSafely();
        return { action: 'allow', overrideBrowserWindowOptions: getCleanOAuthPopupOptions() };
    });
    childWin.webContents.on('did-create-window', attachGoogleLoginShieldToPopup);
    childWin.webContents.on('dom-ready', () => {
        if (!childWin.isDestroyed() && firefoxFallbackPopupIds.has(wcId)) childWin.webContents.executeJavaScript(FIREFOX_AUTH_SHIM_SCRIPT).catch(() => {});
    });
    childWin.webContents.on('did-navigate', async (_e, navUrl) => {
        if (!navUrl || childWin.isDestroyed()) return;
        if (isGoogleAuthHost(navUrl) && !navUrl.includes('/signin/rejected') && !navUrl.includes('/CookieMismatch')) lastUrl = navUrl;
        if ((navUrl.includes('/signin/rejected') || navUrl.includes('/v3/signin/rejected')) && stage === 0) {
            stage = 1;
            await clearGoogleRejectionCookies(session.fromPartition('persist:mydesigns_pro'));
            if (!childWin.isDestroyed()) {
                firefoxFallbackPopupIds.add(wcId); childWin.webContents.setUserAgent(FIREFOX_UA);
                if (lastUrl) childWin.loadURL(lastUrl);
                else if (childWin.webContents.navigationHistory?.canGoBack()) childWin.webContents.navigationHistory.goBack();
                else childWin.webContents.goBack();
            }
        }
    });
}

// ==========================================================
// DEFERRED BROWSERVIEW & FAST-BOOT MAXIMIZED WINDOW
// ==========================================================
function initBrowserView() {
    if (browserViewInitialized && view && view.webContents && !view.webContents.isDestroyed()) return view;
    if (!mainWindow || mainWindow.isDestroyed()) return null;

    if (viewPreloadTimer) { clearTimeout(viewPreloadTimer); viewPreloadTimer = null; }
    browserViewInitialized = true;
    configurePersistSessionHeaders();

    view = new BrowserView({
        webPreferences: {
            preload: STEALTH_PRELOAD_PATH, backgroundThrottling: false, paintWhenInitiallyHidden: true,
            partition: 'persist:mydesigns_pro', contextIsolation: true, nodeIntegration: false, sandbox: false, nativeWindowOpen: true
        }
    });

    const actualNativeUa = view.webContents.getUserAgent();
    if (actualNativeUa && actualNativeUa.includes('Electron/')) nativeElectronUa = actualNativeUa;
    view.webContents.setUserAgent(CLEAN_CHROMIUM_UA);

    let viewLastUrl = '', viewStage = 0;
    view.webContents.on('will-navigate', (event, navUrl) => {
        if (!isAutomationRunning && isGoogleAuthHost(navUrl) && !isViewInGoogleLoginMode) {
            event.preventDefault(); isViewInGoogleLoginMode = true; viewStage = 0; viewLastUrl = navUrl;
            detachDebuggerSafely(); view.webContents.setUserAgent(nativeElectronUa); view.webContents.loadURL(navUrl);
        }
    });
    view.webContents.on('did-navigate', async (_e, navUrl) => {
        if (!navUrl) return;
        if (isGoogleAuthHost(navUrl) && !navUrl.includes('/signin/rejected')) viewLastUrl = navUrl;
        if ((navUrl.includes('/signin/rejected') || navUrl.includes('/v3/signin/rejected')) && viewStage === 0) {
            viewStage = 1; isViewInGoogleLoginMode = true;
            await clearGoogleRejectionCookies(session.fromPartition('persist:mydesigns_pro'));
            firefoxFallbackPopupIds.add(view.webContents.id); view.webContents.setUserAgent(FIREFOX_UA);
            if (viewLastUrl) view.webContents.loadURL(viewLastUrl);
            return;
        }
        if (!isGoogleDomainHost(navUrl) && isViewInGoogleLoginMode) {
            isViewInGoogleLoginMode = false; viewStage = 0;
            firefoxFallbackPopupIds.delete(view.webContents.id); view.webContents.setUserAgent(CLEAN_CHROMIUM_UA);
        }
    });
    view.webContents.setWindowOpenHandler(() => {
        if (!isAutomationRunning) detachDebuggerSafely();
        return { action: 'allow', overrideBrowserWindowOptions: getCleanOAuthPopupOptions() };
    });
    view.webContents.on('did-create-window', attachGoogleLoginShieldToPopup);

    mainWindow.setBrowserView(view);
    updateViewBounds();

    const onLoad = (isDomReady) => {
        if (isAutomationRunning) ensureDebugger(true).catch(() => {});
        else {
            detachDebuggerSafely();
            if (isDomReady && firefoxFallbackPopupIds.has(view.webContents.id)) view.webContents.executeJavaScript(FIREFOX_AUTH_SHIM_SCRIPT).catch(() => {});
        }
    };
    view.webContents.on('dom-ready', () => onLoad(true));
    view.webContents.on('did-finish-load', () => onLoad(false));
    view.webContents.loadURL('https://mydesigns.io/app/designs');

    view.webContents.session.on('will-download', (_e, item) => {
        const name = getUniqueSvgFileName();
        item.setSavePath(path.join(app.getPath('downloads'), name));
        item.once('done', (_ev, state) => { if (state === 'completed') console.log(`File downloaded: ${name}`); });
    });
    return view;
}

function createWindow() {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    const icoPath = path.join(__dirname, 'icon.ico'), pngPath = path.join(__dirname, 'icon.png');

    mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 820, minHeight: 620, show: false,
        backgroundColor: '#dff2fe',
        title: "MyDesigns Pro Tool",
        icon: (process.platform === 'win32' && fs.existsSync(icoPath)) ? icoPath : pngPath,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            paintWhenInitiallyHidden: true
        },
        autoHideMenuBar: true
    });

    let windowShown = false;
    const showMaximizedAndDeferBg = () => {
        if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
        windowShown = true;
        if (!mainWindow.isMaximized()) mainWindow.maximize();
        if (!mainWindow.isVisible()) mainWindow.show();
        updateViewBounds();
        if (!viewPreloadTimer) {
            viewPreloadTimer = setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) initBrowserView();
            }, 800);
        }
    };

    mainWindow.once('ready-to-show', showMaximizedAndDeferBg);
    setTimeout(showMaximizedAndDeferBg, 400);
    mainWindow.loadFile('index.html');

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('app-version', getLocalPackageJson().version || '1.0.0');
        setTimeout(() => checkOnlineUpdate(false), 4000);
        if (autoUpdateTimer) clearInterval(autoUpdateTimer);
        autoUpdateTimer = setInterval(() => checkOnlineUpdate(false), 300000);
    });

    mainWindow.on('closed', cleanupResources);
    mainWindow.on('resize', () => { if (!mainWindow.isMinimized()) updateViewBounds(); });
    mainWindow.on('maximize', updateViewBounds);
    mainWindow.on('unmaximize', updateViewBounds);
    mainWindow.on('minimize', () => { if (isAutomationRunning) ensureDebugger(true).catch(() => {}); });
    mainWindow.on('restore', updateViewBounds);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { cleanupResources(); if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('check-for-update', (_e, isManual) => checkOnlineUpdate(Boolean(isManual)));
ipcMain.on('start-live-update', performLiveOtaUpdate);
ipcMain.on('toggle-view', (_e, show) => {
    initBrowserView();
    isViewVisible = Boolean(show);
    if (!isAutomationRunning) detachDebuggerSafely();
    updateViewBounds();
});

ipcMain.on('refresh-gallery', async (event) => {
    initBrowserView();
    try {
        const urls = await view.webContents.executeJavaScript(`(async () => {
            try {
                return Array.from(document.querySelectorAll('img')).filter(img => {
                    const src = img.src.toLowerCase(), alt = (img.alt || '').toLowerCase();
                    return !src.includes('logo') && !alt.includes('logo') && !src.includes('avatar') && !img.closest('header,nav') && img.width > 60 && img.height > 60 && img.width < img.height * 2.5 && src.startsWith('http');
                }).map(imgEl => {
                    try {
                        const nw = imgEl.naturalWidth || imgEl.width || 120, nh = imgEl.naturalHeight || imgEl.height || 120, sc = Math.min(200 / nw, 200 / nh, 1);
                        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(nw * sc)); c.height = Math.max(1, Math.round(nh * sc));
                        c.getContext('2d').drawImage(imgEl, 0, 0, c.width, c.height);
                        const out = c.toDataURL('image/jpeg', 0.7); c.width = c.height = 0; return out;
                    } catch (e) { return imgEl.src; }
                });
            } catch (e) { return []; }
        })();`);
        event.sender.send('gallery-data', urls);
    } catch (err) { event.sender.send('gallery-data', []); }
});

// ==========================================================
// DOM HELPERS & AUTOMATION WORKFLOW
// ==========================================================
async function getPageInfo(type) {
    return await view.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const byXPath = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return null; } };
        const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return (r.width === 0 && r.height === 0) ? null : { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }; };
        async function scrollInto(btn) {
            if (!btn) return;
            let scrolled = false;
            for (let p = btn.parentElement; p && p !== document.body && p.tagName !== 'MAIN'; p = p.parentElement) {
                if (p.scrollHeight > p.clientHeight) {
                    const pr = p.getBoundingClientRect(), br = btn.getBoundingClientRect();
                    if (br.top < pr.top || br.bottom > pr.bottom) {
                        p.scrollTop += (br.top - pr.top) - p.clientHeight / 2 + br.height / 2;
                        scrolled = true;
                    }
                }
            }
            if (scrolled) await wait(25);
            const r = btn.getBoundingClientRect();
            if (r.bottom > window.innerHeight - 15) {
                const m = btn.closest('div.bg-base-elevated, div.text-base-text');
                if (m) { m.style.maxHeight = (window.innerHeight - 30) + 'px'; m.style.overflowY = 'auto'; m.scrollTop += (r.bottom - window.innerHeight) + 50; await wait(25); }
            }
        }

        const cSign = document.querySelector("[data-testid='designs-select-toggle'] svg g[id='correct sign'], div[tabindex='0'] svg g[id='correct sign'], svg g[id='correct sign']");
        const toggleBox = cSign?.closest("div[tabindex='0']") || document.querySelector("[data-testid='designs-select-toggle'] > div") || byXPath('//*[@data-testid="designs-select-toggle"]/div');
        const toggleCont = document.querySelector("[data-testid='designs-select-toggle']") || toggleBox?.parentElement;
        const m = (toggleCont ? (toggleCont.innerText || toggleCont.textContent || '').trim() : '').match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        const selectedCount = m ? +m[1] : 0, totalCount = m ? +m[2] : (toggleBox ? 1 : 0);
        const svg = toggleBox?.querySelector('svg');
        const isChecked = Boolean(svg && !svg.classList.contains('invisible')) || Boolean(toggleBox?.classList.contains('bg-brand-primary')) || selectedCount > 0;

        if ("${type}" === "status") {
            const bt = (document.body.innerText || '').toLowerCase();
            return { hasToggle: Boolean(toggleBox), selectedCount, totalCount, isChecked, isPageReady: document.readyState === 'complete', isEmptyCanvas: bt.includes('generate with dream ai') || bt.includes('no designs found') || !toggleBox, isUploading: bt.includes('uploading 1 file') || bt.includes('uploading...') };
        }
        if ("${type}" === "dropZoneArea") return rectOf(document.querySelector('.dropzone, [data-testid*="drop"], .border-dashed, main, #init-app') || document.body) || { x: 500, y: 300, width: 500, height: 300 };
        if ("${type}" === "uploadBtn") return rectOf(byXPath('//*[@id="init-app"]/div[2]/div[2]/main/div/div[2]/div[1]/div/div/div/button') || [...document.querySelectorAll('main button, button')].find(b => ['upload'].includes((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase())) || document.querySelector('div.pt-6 > div > div > div > button'));
        if ("${type}" === "selectToggle") return rectOf(toggleBox);
        if ("${type}" === "actionsBtn") return rectOf([...document.querySelectorAll('button')].find(b => b.querySelector('g[id="down arrow"]') && (b.innerText || b.textContent || '').trim() === 'Actions') || document.querySelector("div.bg-base-subtle div.min-w-0 > div:nth-of-type(1) > div button") || [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === 'Actions'));
        if ("${type}" === "vectorizeBtn") {
            const btn = document.querySelector('button svg g[id="vectorize image"]')?.closest('button') || [...document.querySelectorAll('button')].find(b => b.querySelector('span.truncate')?.textContent.trim().toLowerCase() === 'vectorize image');
            if (!btn) return null; await scrollInto(btn); return rectOf(btn.querySelector('span.truncate') || btn);
        }
        if ("${type}" === "generatePreviewBtn") {
            const btn = [...document.querySelectorAll('button')].find(b => b.querySelector('g[id="right arrow"]') && (b.innerText || b.textContent || '').includes('Generate Preview')) || document.querySelector('button svg g[id="right arrow"]')?.closest('button') || [...document.querySelectorAll('button')].find(b => (b.innerText || b.textContent || '').trim().toLowerCase() === 'generate preview') || byXPath('/html/body/div[5]/div/div[2]/div[3]/div[2]/button') || document.querySelector("div.mt-4 button");
            if (!btn) return null;
            await scrollInto(btn);
            const r = btn.getBoundingClientRect();
            if (r.top < 20 || r.bottom > window.innerHeight - 20) { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(25); }
            return rectOf(btn);
        }
        if ("${type}" === "closeModalBtn") {
            const btn = (document.querySelector("div.text-base-text div.border-base-border button svg g[id='close']") || Array.from(document.querySelectorAll("button.ml-auto svg g[id='close']")).pop())?.closest('button') || document.querySelector("div.text-base-text div.border-base-border > button") || byXPath('/html/body/div[5]/div/div[1]/button');
            if (!btn) return null; btn.scrollIntoView({ behavior: 'instant', block: 'center' }); await wait(50); return rectOf(btn);
        }
        if ("${type}" === "deleteOption") {
            const btn = document.querySelector('button svg g[id="Delete"]')?.closest('button') || [...document.querySelectorAll('button')].find(b => b.querySelector('span.truncate')?.textContent.trim() === 'Delete');
            if (!btn) return null; await scrollInto(btn); return rectOf(btn.querySelector('span.truncate') || btn);
        }
        if ("${type}" === "confirmDeleteBtn") return rectOf([...document.querySelectorAll('button.bg-error-solid, button')].find(b => (b.innerText || b.textContent || '').trim().toLowerCase() === 'yes, delete designs') || document.querySelector("button.bg-error-solid"));
        return null;
    })();`);
}

async function waitForPageInfo(type, maxMs = 450, stepMs = 50) {
    const tries = Math.max(1, Math.ceil(maxMs / stepMs));
    for (let k = 0; k < tries; k++) {
        const res = await getPageInfo(type);
        if (res) return res;
        await wait(stepMs);
    }
    return null;
}

async function throwFileViaDragAndDrop(fileObj) {
    const dbg = await ensureDebugger(false);
    const ext = path.extname(fileObj.name || '') || '.png';
    const tempFilePath = path.join(app.getPath('temp'), `${path.basename(fileObj.name || 'design', ext).replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}${ext}`);
    fs.writeFileSync(tempFilePath, Buffer.from(fileObj.data.replace(/^data:[^;]+;base64,/, ''), 'base64'));

    try {
        let dz = null;
        for (let i = 0; i < 20; i++) {
            const [st, up, zone] = await Promise.all([getPageInfo('status'), getPageInfo('uploadBtn'), getPageInfo('dropZoneArea')]);
            dz = zone;
            if (st.isPageReady && up && dz) break;
            await wait(400);
        }
        await wait(800);

        const sx = Math.round(dz?.x || 500), sy = Math.round(dz?.y || 300);
        const dragData = { items: [], files: [tempFilePath], dragOperationsMask: 1 };
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: sx, y: sy, data: dragData }); await wait(350);
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: sx, y: sy, data: dragData }); await wait(350);
        const activeDz = await getPageInfo('dropZoneArea');
        const dx = Math.round(activeDz?.x || sx), dy = Math.round(activeDz?.y || sy);
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: dx, y: dy, data: dragData }); await wait(250);
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: dx, y: dy, data: dragData }); await wait(1200);

        let st = await getPageInfo('status');
        if (!st.isUploading && !st.hasToggle) {
            await view.webContents.executeJavaScript(`(async () => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                const blob = await (await fetch(${JSON.stringify(fileObj.data)})).blob();
                const dt = new DataTransfer(); dt.items.add(new File([blob], ${JSON.stringify(fileObj.name || 'design.png')}, { type: ${JSON.stringify(fileObj.type || 'image/png')}, lastModified: Date.now() }));
                const targets = [document.elementFromPoint(500, 300), document.querySelector('.dropzone'), document.querySelector('main'), document.body].filter(Boolean);
                for (const ev of ['dragenter', 'dragover', 'drop']) { targets.forEach(t => t.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, dataTransfer: dt }))); await wait(300); }
                for (const input of document.querySelectorAll('input[type="file"]')) {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
                    if (setter) setter.call(input, dt.files); else input.files = dt.files;
                    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            })();`);
            await wait(1200);
            st = await getPageInfo('status');
        }

        if (!st.isUploading && !st.hasToggle) {
            try {
                await dbg.sendCommand('DOM.enable');
                const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
                const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
                if (nodeIds?.length) await dbg.sendCommand('DOM.setFileInputFiles', { files: [tempFilePath], nodeId: nodeIds[nodeIds.length - 1] });
                else {
                    pendingFileForChooser = tempFilePath;
                    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
                    const upRect = await getPageInfo('uploadBtn');
                    if (upRect) { await cdpClick(upRect.x, upRect.y); await wait(800); }
                    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false });
                }
            } catch (e) {} finally { await dbg.sendCommand('DOM.disable').catch(() => {}); }
        }
    } finally {
        pendingFileForChooser = null;
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) {}
        setTimeout(() => { try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {} }, 15000);
    }
}

async function checkAndDeleteIfPresent() {
    try {
        let status = await getPageInfo('status');
        if (!status.hasToggle) return "No existing file";
        for (let a = 1; a <= 5; a++) {
            status = await getPageInfo('status');
            if (!status.hasToggle) return "No existing file";
            if (status.isChecked) break;
            const t = await getPageInfo('selectToggle');
            if (t) await cdpClick(t.x, t.y);
            await wait(450);
        }
        await wait(250);

        let confirmRect = null;
        for (let a = 1; a <= 4; a++) {
            if ((confirmRect = await getPageInfo('confirmDeleteBtn'))) break;
            let delRect = await getPageInfo('deleteOption');
            if (!delRect) {
                const act = await getPageInfo('actionsBtn');
                if (!act) throw new Error("Actions button not found");
                await cdpClick(act.x, act.y, true);
                delRect = await waitForPageInfo('deleteOption', 450, 50);
            }
            if (delRect) {
                await cdpClick(delRect.x, delRect.y, true);
                confirmRect = await waitForPageInfo('confirmDeleteBtn', 500, 55);
            }
            if (confirmRect) break;
            await view.webContents.executeJavaScript(`document.querySelector('button svg g[id="Delete"]')?.closest('button')?.click();`);
            confirmRect = await waitForPageInfo('confirmDeleteBtn', 450, 55);
            if (confirmRect) break;
        }
        if (!confirmRect) throw new Error("Yes, delete designs button not found");

        for (let c = 1; c <= 4; c++) {
            confirmRect = await getPageInfo('confirmDeleteBtn');
            if (!confirmRect) break;
            await cdpClick(confirmRect.x, confirmRect.y, true);
            let closed = false;
            for (let k = 0; k < 6; k++) {
                await wait(70);
                if (!(await getPageInfo('confirmDeleteBtn'))) { closed = true; break; }
            }
            if (closed) break;
            await view.webContents.executeJavaScript(`(document.querySelector("button.bg-error-solid") || [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().toLowerCase() === 'yes, delete designs'))?.click();`);
            await wait(200);
        }
        for (let w = 0; w < 25; w++) {
            await wait(250);
            const cur = await getPageInfo('status');
            if (!cur.hasToggle || cur.totalCount === 0 || cur.isEmptyCanvas) break;
        }
        await wait(450);
        return "Success";
    } catch (err) { return "Error: " + err.message; }
}

ipcMain.on('start-reset', async (event) => {
    initBrowserView(); isAutomationRunning = true; isViewVisible = true; updateViewBounds();
    try { const res = await checkAndDeleteIfPresent(); event.sender.send('status-update', res === "Success" ? "Canvas cleaned successfully." : `${res}`); }
    catch (e) { event.sender.send('status-update', "Reset failed: " + e.message); }
    finally { isAutomationRunning = false; await removeSimpleCursor(); detachDebuggerSafely(); }
});

// ==========================================================
// STANDALONE BATCH WORKFLOW
// ==========================================================
async function runBatchAutomation(event, incomingData) {
    if (incomingData && !Array.isArray(incomingData) && incomingData.action === 'open-output-folder') {
        shell.openPath(FINAL_DESIGNS_FOLDER);
        return;
    }

    initBrowserView();
    const filesArray = Array.isArray(incomingData) ? incomingData : (incomingData.files || [incomingData]);
    const customApiKey = (!Array.isArray(incomingData) && incomingData.apiKey) ? incomingData.apiKey : '';
    const toleranceVal = (!Array.isArray(incomingData) && incomingData.tolerance) ? Number(incomingData.tolerance) : 10;

    const sendStatus = (msg) => event.sender.send('status-update', msg);
    const sendProgress = (percent, text, activeIndex = -1, isCompleted = false, aiTitle = '') =>
        event.sender.send('progress-update', { percent, text, activeIndex, isCompleted, aiTitle });

    isAutomationRunning = true;
    let isBatchStillActive = true, currentBatchIndex = 0;

    isViewInGoogleLoginMode = false;
    firefoxFallbackPopupIds.delete(view.webContents.id);
    view.webContents.setUserAgent(CLEAN_CHROMIUM_UA);

    isViewVisible = true; updateViewBounds();
    await ensureDebugger(true);
    await ensureWorkerWindow().catch(() => {});

    if (!view.webContents.getURL().includes('mydesigns.io/app/designs')) {
        await view.webContents.loadURL('https://mydesigns.io/app/designs');
        await wait(1000);
    }

    const aiTitlesMap = new Map();
    (async () => {
        for (let idx = 0; idx < filesArray.length; idx++) {
            while (isBatchStillActive && idx > currentBatchIndex + 2) await wait(500);
            if (!isBatchStillActive) break;
            try {
                const t = await generateAiTitleNode(filesArray[idx].data, customApiKey);
                aiTitlesMap.set(idx, t);
                sendProgress(undefined, undefined, idx === currentBatchIndex ? idx : -1, false, `[${idx + 1}/${filesArray.length}] ${t}`);
            } catch (e) {}
            await wait(250);
        }
    })();

    try {
        for (let i = 0; i < filesArray.length; i++) {
            currentBatchIndex = i;
            const fileObj = filesArray[i], fileLabel = `[File ${i + 1}/${filesArray.length}]`;

            try {
                sendProgress(5, `${fileLabel} Scanning design & preparing canvas...`, i, false);
                if (i > 0) {
                    const cur = view.webContents.getURL();
                    try { await view.webContents.loadURL(cur.includes('mydesigns.io/app/designs') ? cur : 'https://mydesigns.io/app/designs'); } catch (e) {}
                    await wait(1200);
                    await ensureDebugger(true);
                }
                for (let w = 0; w < 25; w++) {
                    if ((await getPageInfo('uploadBtn')) && (await getPageInfo('status')).isPageReady) break;
                    await wait(350);
                }
                await wait(1200);

                sendProgress(20, `${fileLabel} Uploading image via Drag & Drop...`, i, false);
                await throwFileViaDragAndDrop(fileObj);

                sendProgress(35, `${fileLabel} Waiting for upload to finish...`, i, false);
                let uploadDone = false;
                for (let loop = 1; loop <= 45; loop++) {
                    await wait(700);
                    const st = await getPageInfo('status');
                    if (st.hasToggle && !st.isUploading) { uploadDone = true; break; }
                    if (loop === 5 && !st.hasToggle && !st.isUploading) {
                        sendProgress(38, `${fileLabel} Re-dropping file onto canvas...`, i, false);
                        await throwFileViaDragAndDrop(fileObj);
                    }
                    sendProgress(40, `${fileLabel} Uploading dropped file... (${loop})`, i, false);
                }
                if (!uploadDone) throw new Error("Drag & Drop upload timed out");

                sendProgress(50, `${fileLabel} Waiting for design preview to load...`, i, false);
                await wait(2500);

                sendProgress(60, `${fileLabel} Selecting design checkbox...`, i, false);
                let selected = false;
                for (let a = 1; a <= 6; a++) {
                    if ((await getPageInfo('status')).isChecked) { selected = true; break; }
                    const t = await getPageInfo('selectToggle');
                    if (t) await cdpClick(t.x, t.y);
                    await wait(100);
                }
                if (!selected && !(await getPageInfo('status')).isChecked) throw new Error("Failed to select checkbox");
                await wait(300);

                sendProgress(70, `${fileLabel} Clicking Actions & Vectorize image...`, i, false);
                let genRect = null;
                for (let a = 1; a <= 4; a++) {
                    if ((genRect = await getPageInfo('generatePreviewBtn'))) break;
                    let vec = await getPageInfo('vectorizeBtn');
                    if (!vec) {
                        const act = await getPageInfo('actionsBtn');
                        if (!act) throw new Error("Actions button not found");
                        await cdpClick(act.x, act.y, true);
                        vec = await waitForPageInfo('vectorizeBtn', 500, 50);
                    }
                    if (vec) {
                        sendProgress(75, `${fileLabel} Clicking Vectorize image...`, i, false);
                        await cdpClick(vec.x, vec.y, true);
                        await wait(40);
                    }
                    if ((genRect = await getPageInfo('generatePreviewBtn'))) break;
                    await view.webContents.executeJavaScript(`document.querySelector('button svg g[id="vectorize image"]')?.closest('button')?.click();`);
                    genRect = await waitForPageInfo('generatePreviewBtn', 600, 60);
                    if (genRect) break;
                }

                sendProgress(80, `${fileLabel} Clicking Generate Preview...`, i, false);
                if (!genRect) genRect = await waitForPageInfo('generatePreviewBtn', 2500, 60);
                if (!genRect) throw new Error("Generate Preview button not found");
                await wait(120);

                for (let ga = 1; ga <= 4; ga++) {
                    if (!(genRect = await getPageInfo('generatePreviewBtn'))) break;
                    await cdpClick(genRect.x, genRect.y, true);
                    let isGen = false;
                    for (let k = 0; k < 6; k++) {
                        await wait(80);
                        isGen = await view.webContents.executeJavaScript(`(() => {
                            const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().toLowerCase() === 'generate preview');
                            return Boolean(document.querySelector('svg.animate-spin') || !btn || btn.disabled || document.querySelector("div.mt-4 > div:nth-of-type(2) > img, div:nth-of-type(2) > img[src^='blob:']"));
                        })();`);
                        if (isGen) break;
                    }
                    if (isGen) break;
                    await view.webContents.executeJavaScript(`(document.querySelector('button svg g[id="right arrow"]')?.closest('button') || document.querySelector("div.mt-4 button"))?.click();`);
                    await wait(250);
                }

                sendProgress(85, `${fileLabel} Vectorizing image... Please wait.`, i, false);
                let svgOut = null;
                for (let g = 0; g < 150; g++) {
                    await wait(500);
                    svgOut = await view.webContents.executeJavaScript(`(async () => {
                        if (document.querySelector('svg.animate-spin')) return null;
                        const byXp = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return null; } };
                        const img = byXp('/html/body/div[5]/div/div[2]/div[3]/div[2]/img') || document.querySelector("div.mt-4 > div:nth-of-type(2) > img, div:nth-of-type(2) > img[src^='blob:'], div:nth-of-type(2) > img");
                        if (img && img.src && img.complete && img.naturalWidth > 0) {
                            try { return { type: 'svg_text', data: await (await fetch(img.src)).text() }; }
                            catch (e) { return { type: 'url', data: img.src }; }
                        }
                        return null;
                    })();`);
                    if (svgOut) break;
                }
                if (!svgOut) throw new Error("Generated vector image did not appear in time");

                const svgSavePath = path.join(app.getPath('downloads'), getUniqueSvgFileName());
                sendProgress(88, `${fileLabel} Saving Vector SVG...`, i, false);
                if (svgOut.type === 'svg_text' && svgOut.data) fs.writeFileSync(svgSavePath, svgOut.data, 'utf8');
                else if (svgOut.data) { view.webContents.downloadURL(svgOut.data); await wait(1200); }

                sendProgress(91, `${fileLabel} Cleaning up MyDesigns canvas...`, i, false);
                for (let c = 1; c <= 4; c++) {
                    const closeRect = await getPageInfo('closeModalBtn');
                    if (!closeRect) break;
                    await cdpClick(closeRect.x, closeRect.y); await wait(450);
                    if (!(await getPageInfo('closeModalBtn'))) break;
                    await view.webContents.executeJavaScript(`(document.querySelector("div.text-base-text div.border-base-border button svg g[id='close']") || Array.from(document.querySelectorAll("button.ml-auto svg g[id='close']")).pop())?.closest('button')?.click();`);
                    await wait(450);
                }
                await checkAndDeleteIfPresent();

                let readyTitle = aiTitlesMap.get(i);
                if (!readyTitle) { readyTitle = await generateAiTitleNode(fileObj.data, customApiKey); aiTitlesMap.set(i, readyTitle); }

                sendProgress(96, `${fileLabel} Removing BG (Tol: ${toleranceVal}) & Saving 300 PPI -> "${readyTitle}.png"...`, i, false, `[${i + 1}/${filesArray.length}] ${readyTitle}`);
                const savedPngName = await processSvgStandaloneInApp(svgSavePath, fileObj.data, readyTitle, toleranceVal);

                sendProgress(100, `${fileLabel} Saved: ${savedPngName}`, i, true, `Saved: ${savedPngName}`);
                await wait(200);
            } catch (err) {
                console.error(`Failed at ${fileLabel}:`, err.message);
                sendProgress(100, `${fileLabel} Error: ${err.message}`, i, false);
                await wait(500);
            }
        }
    } finally {
        isBatchStillActive = false;
        isAutomationRunning = false;
        await removeSimpleCursor();
        detachDebuggerSafely();
    }

    sendStatus("Completed: All batch designs vectorized, background removed, trimmed (300 PPI), and saved to Desktop > Final_Designs.");
}

ipcMain.on('start-automation', (event, incomingData) => runBatchAutomation(event, incomingData));
