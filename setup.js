const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { exec } = require('child_process');
const readline = require('readline'); // 引入 readline 用于控制光标

// 配置
const RESOURCES_BIN = path.join(__dirname, 'resources', 'bin');
const PLATFORM_ARCH = `${os.platform()}-${os.arch()}`; // e.g., darwin-arm64, win32-x64
const BIN_DIR = path.join(RESOURCES_BIN, PLATFORM_ARCH);
const GH_PROXY = 'https://gh-proxy.com/';
const XRAY_API_URL = 'https://api.github.com/repos/XTLS/Xray-core/releases/latest';

// --- 辅助工具：格式化字节 ---
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- 核心：单行刷新进度条 ---
function showProgress(received, total, startTime, prefix = 'Downloading') {
    const percent = total > 0 ? ((received / total) * 100).toFixed(1) : 0;
    const elapsedTime = (Date.now() - startTime) / 1000; // seconds
    const speed = elapsedTime > 0 ? (received / elapsedTime) : 0; // bytes/sec

    // 进度条视觉效果 [==========----------]
    const barLength = 30; // 稍微加长一点
    const filledLength = total > 0 ? Math.round((barLength * received) / total) : 0;
    // 防止计算溢出
    const validFilledLength = filledLength > barLength ? barLength : filledLength;
    const bar = '█'.repeat(validFilledLength) + '░'.repeat(barLength - validFilledLength);

    const speedStr = formatBytes(speed) + '/s';
    const receivedStr = formatBytes(received);
    const totalStr = formatBytes(total);

    // 构造输出字符串，使用 \r 回到行首实现单行刷新
    const output = `\r${prefix} [${bar}] ${percent}% | ${receivedStr}/${totalStr} | ${speedStr}`;

    // 直接使用 \r 回车符，更兼容各种终端
    process.stdout.write(output);
}

// --- 核心逻辑 ---

function getPlatformInfo() {
    const platform = os.platform();
    const arch = os.arch();
    let xrayAsset = '';
    let exeName = 'xray';

    if (platform === 'win32') {
        xrayAsset = `Xray-windows-${arch === 'x64' ? '64' : '32'}.zip`;
        exeName = 'xray.exe';
    } else if (platform === 'darwin') {
        xrayAsset = `Xray-macos-${arch === 'arm64' ? 'arm64-v8a' : '64'}.zip`;
    } else if (platform === 'linux') {
        xrayAsset = `Xray-linux-${arch === 'x64' ? '64' : '32'}.zip`;
    } else {
        console.error('❌ Unsupported Platform:', platform);
        process.exit(1);
    }
    return { xrayAsset, exeName };
}

function checkNetwork() {
    return new Promise((resolve) => {
        console.log('🌐 Checking network connectivity...');
        const req = https.get('https://www.google.com', { timeout: 3000 }, (res) => {
            resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

// Fetch latest Xray version from GitHub API
function getLatestXrayVersion(useProxy = false) {
    return new Promise((resolve, reject) => {
        const url = useProxy ? (GH_PROXY + XRAY_API_URL) : XRAY_API_URL;
        const options = {
            headers: { 'User-Agent': 'GeekEZ-Browser-Setup' },
            timeout: 10000
        };

        const makeRequest = (requestUrl) => {
            const urlObj = new URL(requestUrl);
            const reqOptions = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: { 'User-Agent': 'GeekEZ-Browser-Setup' },
                timeout: 10000
            };

            https.get(reqOptions, (res) => {
                // Handle redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    makeRequest(res.headers.location);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`GitHub API returned ${res.statusCode}`));
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.tag_name); // e.g., "v24.12.31"
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
        };

        makeRequest(url);
    });
}

// 支持进度显示的下载函数
function downloadFile(url, dest, label = 'Downloading') {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (response) => {
            // 处理重定向
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadFile(response.headers.location, dest, label).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(dest);
            const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
            let receivedBytes = 0;
            const startTime = Date.now();

            response.on('data', (chunk) => {
                receivedBytes += chunk.length;
                showProgress(receivedBytes, totalBytes, startTime, label);
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close(() => {
                    process.stdout.write('\n'); // 下载完成换行
                    resolve();
                });
            });

            file.on('error', (err) => {
                fs.unlink(dest, () => { });
                reject(err);
            });
        });

        req.on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        console.log('📦 Extracting...');
        if (os.platform() === 'win32') {
            exec(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, (err) => {
                if (err) reject(err); else resolve();
            });
        } else {
            exec(`unzip -o "${zipPath}" -d "${destDir}"`, (err) => {
                if (err) reject(err); else resolve();
            });
        }
    });
}

async function main() {
    try {
        // 1. 准备 Xray
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

        const { xrayAsset, exeName } = getPlatformInfo();
        const zipPath = path.join(BIN_DIR, 'xray.zip');
        const isGlobal = await checkNetwork();

        console.log(`🌍 Network: ${isGlobal ? 'Global' : 'CN (Mirror)'}`);

        // Get latest Xray version from GitHub
        let xrayVersion;
        try {
            console.log('🔍 Fetching latest Xray version...');
            xrayVersion = await getLatestXrayVersion(!isGlobal);
            console.log(`📦 Latest version: ${xrayVersion}`);
        } catch (e) {
            console.log('⚠️  Failed to get latest version, using fallback: v24.11.30');
            xrayVersion = 'v24.11.30';
        }

        const baseUrl = `https://github.com/XTLS/Xray-core/releases/download/${xrayVersion}/${xrayAsset}`;
        const downloadUrl = isGlobal ? baseUrl : (GH_PROXY + baseUrl);

        process.stdout.write(`⬇️  Downloading Xray (${xrayVersion})...\n`);

        // 这里的 Label 用于进度条前缀
        await downloadFile(downloadUrl, zipPath, 'Xray Core');

        await extractZip(zipPath, BIN_DIR);
        fs.unlinkSync(zipPath);

        // Move shared resources (geoip.dat, geosite.dat) to common bin directory for asset loading
        const sharedFiles = ['geoip.dat', 'geosite.dat', 'LICENSE', 'README.md'];
        sharedFiles.forEach(file => {
            const srcPath = path.join(BIN_DIR, file);
            const destPath = path.join(RESOURCES_BIN, file);
            if (fs.existsSync(srcPath)) {
                // Only copy if not exists or source is newer
                if (!fs.existsSync(destPath)) {
                    fs.copyFileSync(srcPath, destPath);
                }
                // Remove from platform dir to save space
                fs.unlinkSync(srcPath);
            }
        });

        if (os.platform() !== 'win32') fs.chmodSync(path.join(BIN_DIR, exeName), '755');
        console.log(`✅ Xray Updated Successfully! (Platform: ${PLATFORM_ARCH})`);

        // 2. 准备 Chrome
        process.stdout.write('⬇️  Downloading Chrome...\n');
        const { install } = require('@puppeteer/browsers');
        const BUILD_ID = '129.0.6668.58';
        const DOWNLOAD_ROOT = path.join(__dirname, 'resources', 'puppeteer');
        const MIRROR_URL = 'https://npmmirror.com/mirrors/chrome-for-testing';

        if (fs.existsSync(DOWNLOAD_ROOT)) {
            console.log(`🧹 Cleaning existing Chrome directory...`);
            fs.rmSync(DOWNLOAD_ROOT, { recursive: true, force: true });
        }

        const baseUrlChrome = isGlobal ? undefined : MIRROR_URL;

        const chromeStartTime = Date.now();

        const result = await install({
            cacheDir: DOWNLOAD_ROOT,
            browser: 'chrome',
            buildId: BUILD_ID,
            unpack: true,
            baseUrl: baseUrlChrome,
            downloadProgressCallback: (downloadedBytes, totalBytes) => {
                showProgress(downloadedBytes, totalBytes, chromeStartTime, 'Chrome   ');
            }
        });

        process.stdout.write('\n'); // 换行，避免最后一行被吞
        console.log('✅ Chrome downloaded successfully!');
        console.log(`📂 Install Path: ${result.path}`);

        console.log('✨ All Setup Completed! Exiting...');
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Setup Failed:', error);
        process.exit(1);
    }
}

main();