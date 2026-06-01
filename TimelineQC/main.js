const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PLUGIN_ID = "com.moteline.shortdrama";
const APP_DISPLAY_NAME = "鸡腿快助手";
const BACKEND_SCRIPT = path.join(__dirname, "bridge.py");
const RUNTIME_DIR = selectRuntimeRoot();
const ALL_TIMELINES_FOLDER_ID = "__all_timelines";
const APP_VERSION = readPackageVersion();

let workflowIntegration = null;
let resolveObj = null;
let projectManagerObj = null;
let projectObj = null;
let timelineObj = null;
let mainWindow = null;
let timelineListCache = null;
let timelineListCacheAt = 0;
let updateCheckTimer = null;
let activeAnalysisState = null;
const TIMELINE_LIST_CACHE_MS = 10000;

function initWorkflowIntegration() {
    try {
        const nodePath = path.join(__dirname, "WorkflowIntegration.node");
        if (!fs.existsSync(nodePath)) {
            return { ok: false, error: "WorkflowIntegration.node not found" };
        }
        workflowIntegration = require(nodePath);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || String(error) };
    }
}

function selectRuntimeRoot() {
    if (process.env.TIMELINEQC_WORK_DIR) {
        return process.env.TIMELINEQC_WORK_DIR;
    }

    const candidates = process.platform === "win32"
        ? [
            "G:\\MoteLineRuntime",
            "D:\\MoteLineRuntime",
            "E:\\MoteLineRuntime",
            "F:\\MoteLineRuntime",
            path.join(os.tmpdir(), "MoteLineRuntime"),
            path.join(__dirname, "runtime"),
        ]
        : [
            path.join(os.tmpdir(), "MoteLineRuntime"),
            path.join(os.homedir(), "Library", "Caches", "MoteLineRuntime"),
            path.join(__dirname, "runtime"),
        ];

    for (const candidate of candidates) {
        try {
            fs.mkdirSync(candidate, { recursive: true });
            const probe = path.join(candidate, ".write_test");
            fs.writeFileSync(probe, "1");
            fs.unlinkSync(probe);
            return candidate;
        } catch (_) {
            // try next candidate
        }
    }

    return path.join(__dirname, "runtime");
}

function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
        return String(pkg.version || "0.0.0");
    } catch (_) {
        return "0.0.0";
    }
}

function selectWindowIcon() {
    const iconCandidates = process.platform === "win32"
        ? ["logo.ico", "logo.png"]
        : ["logo.png", "logo.ico"];
    for (const fileName of iconCandidates) {
        const candidate = path.join(__dirname, fileName);
        if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(__dirname, "logo.png");
}

async function ensureResolveObjects() {
    if (!workflowIntegration) {
        const init = initWorkflowIntegration();
        if (!init.ok) {
            return { ok: false, error: init.error || "WorkflowIntegration init failed" };
        }
    }

    try {
        if (!resolveObj) {
            const initialized = await workflowIntegration.Initialize(PLUGIN_ID);
            if (!initialized) {
                return { ok: false, error: "WorkflowIntegration.Initialize failed" };
            }
            resolveObj = await workflowIntegration.GetResolve();
        }

        if (!resolveObj) {
            return { ok: false, error: "Resolve object unavailable" };
        }

        projectManagerObj = await resolveObj.GetProjectManager();
        if (!projectManagerObj) {
            return { ok: false, error: "ProjectManager unavailable" };
        }

        projectObj = await projectManagerObj.GetCurrentProject();
        if (!projectObj) {
            return { ok: false, error: "No current project available" };
        }

        const currentTimeline = await safeCall(() => projectObj.GetCurrentTimeline(), null);
        if (currentTimeline) {
            timelineObj = currentTimeline;
        } else {
            timelineObj = null;
            const count = safeInt(await safeCall(() => projectObj.GetTimelineCount(), 0), 0);
            if (count > 0) {
                timelineObj = await safeCall(() => projectObj.GetTimelineByIndex(1), null);
            } else {
                timelineObj = await safeCall(() => projectObj.GetTimelineByIndex(1), null);
            }
        }
        if (!timelineObj) {
            return { ok: false, error: "No timeline available" };
        }

        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || String(error) };
    }
}

function resetResolveCache() {
    timelineObj = null;
    projectObj = null;
    projectManagerObj = null;
    resolveObj = null;
}

function createWindow() {
    const windowIcon = selectWindowIcon();
    mainWindow = new BrowserWindow({
        title: APP_DISPLAY_NAME,
        width: 820,
        height: 920,
        minWidth: 580,
        minHeight: 700,
        frame: false,
        icon: windowIcon,
        backgroundColor: "#161719",
        useContentSize: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    mainWindow.setMenuBarVisibility(false);
    if (windowIcon && fs.existsSync(windowIcon)) {
        try {
            mainWindow.setIcon(nativeImage.createFromPath(windowIcon));
        } catch (_) {
            // best effort
        }
    }
    mainWindow.loadFile(path.join(__dirname, "frontend", "panel.html"));

    mainWindow.on("closed", () => {
        cleanupWorkflowIntegration();
        mainWindow = null;
    });
}

function cleanupWorkflowIntegration() {
    try {
        if (workflowIntegration && workflowIntegration.CleanUp) {
            workflowIntegration.CleanUp();
        }
    } catch (_) {
        // ignore
    }
}

function startUpdateMonitor() {
    if (process.platform !== "win32") {
        return;
    }

    const config = readUpdateConfig();
    if (!config.enabled || !config.manifest_url || isPlaceholderUrl(config.manifest_url)) {
        return;
    }

    setTimeout(() => {
        checkForUpdates({ silent: true }).catch(() => {});
    }, Math.max(1000, safeInt(config.startup_delay_ms, 4000)));

    const intervalMs = Math.max(1, safeNumber(config.check_interval_hours, 6)) * 60 * 60 * 1000;
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    updateCheckTimer = setInterval(() => {
        checkForUpdates({ silent: true }).catch(() => {});
    }, intervalMs);
}

function readUpdateConfig() {
    const defaults = {
        enabled: true,
        manifest_url: "",
        check_interval_hours: 6,
        startup_delay_ms: 4000,
        auto_download: true,
        auto_install_on_resolve_exit: true,
        timeout_ms: 12000,
    };
    let fileConfig = {};
    try {
        const configPath = path.join(__dirname, "update_config.json");
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        }
    } catch (_) {
        fileConfig = {};
    }
    const config = Object.assign({}, defaults, fileConfig);
    if (process.env.MOTELINE_UPDATE_MANIFEST_URL) {
        config.manifest_url = process.env.MOTELINE_UPDATE_MANIFEST_URL;
    }
    if (process.env.MOTELINE_UPDATE_ENABLED) {
        config.enabled = !/^(0|false|no)$/i.test(process.env.MOTELINE_UPDATE_ENABLED);
    }
    return config;
}

function isPlaceholderUrl(value) {
    const text = String(value || "").trim();
    return !text || text.includes("<") || text.includes(">") || text.includes("your-") || text.includes("example.com");
}

async function checkForUpdates(options = {}) {
    if (process.platform !== "win32") {
        return {
            status: "unsupported",
            current_version: APP_VERSION,
            message: "Automatic update is supported only on Windows builds",
        };
    }

    const config = readUpdateConfig();
    const manifestUrl = String(config.manifest_url || "").trim();
    if (!config.enabled || !manifestUrl || isPlaceholderUrl(manifestUrl)) {
        return { status: "disabled", current_version: APP_VERSION };
    }

    try {
        const manifest = normalizeUpdateManifest(await fetchJson(manifestUrl, config.timeout_ms));
        if (!manifest.version || !isNewerVersion(manifest.version, APP_VERSION)) {
            return {
                status: "current",
                current_version: APP_VERSION,
                latest_version: manifest.version || APP_VERSION,
            };
        }

        if (!config.auto_download) {
            return {
                status: "available",
                current_version: APP_VERSION,
                latest_version: manifest.version,
                url: manifest.url,
                notes: manifest.notes || "",
            };
        }

        const staged = await downloadAndStageUpdate(manifest, config);
        return Object.assign({
            status: "staged",
            current_version: APP_VERSION,
            latest_version: manifest.version,
        }, staged);
    } catch (error) {
        if (!options.silent) {
            return { status: "error", current_version: APP_VERSION, error: error.message || String(error) };
        }
        return { status: "error", current_version: APP_VERSION, error: error.message || String(error) };
    }
}

function normalizeUpdateManifest(manifest) {
    const data = manifest && typeof manifest === "object" ? manifest : {};
    return {
        version: String(data.version || data.tag_name || "").replace(/^v/i, ""),
        url: String(data.url || data.download_url || data.zip_url || data.package_url || ""),
        sha256: String(data.sha256 || data.hash || "").trim().toLowerCase(),
        notes: String(data.notes || data.body || data.description || ""),
    };
}

async function downloadAndStageUpdate(manifest, config) {
    if (!manifest.url || isPlaceholderUrl(manifest.url)) {
        throw new Error("Update manifest missing package url");
    }

    const updatesDir = path.join(RUNTIME_DIR, "updates");
    const version = String(manifest.version || "").replace(/^v/i, "");
    const zipPath = path.join(updatesDir, `moteline_${version}.zip`);
    const stageDir = path.join(updatesDir, `staged_${version}`);
    fs.mkdirSync(updatesDir, { recursive: true });

    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
        await downloadFile(manifest.url, zipPath, Math.max(30000, safeInt(config.timeout_ms, 12000)));
    }
    if (manifest.sha256) {
        const hash = sha256File(zipPath);
        if (hash !== manifest.sha256) {
            try { fs.unlinkSync(zipPath); } catch (_) {}
            throw new Error("Update package checksum mismatch");
        }
    }

    if (fs.existsSync(stageDir)) {
        fs.rmSync(stageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stageDir, { recursive: true });
    await expandZip(zipPath, stageDir);

    const stagedPluginDir = path.join(stageDir, "TimelineQC");
    if (!fs.existsSync(path.join(stagedPluginDir, "manifest.xml"))) {
        throw new Error("Update package does not contain TimelineQC/manifest.xml");
    }

    const pending = {
        version,
        zip_path: zipPath,
        stage_dir: stageDir,
        staged_plugin_dir: stagedPluginDir,
        plugin_dir: __dirname,
        created_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(updatesDir, "pending_update.json"), JSON.stringify(pending, null, 2), "utf8");

    if (config.auto_install_on_resolve_exit) {
        launchUpdateApplier(updatesDir, pending);
    }

    return {
        staged_version: version,
        staged_plugin_dir: stagedPluginDir,
        install_mode: config.auto_install_on_resolve_exit ? "after_resolve_exit" : "manual",
    };
}

function launchUpdateApplier(updatesDir, pending) {
    const scriptPath = path.join(updatesDir, "apply_update.ps1");
    const script = [
        "param([string]$SourceDir,[string]$PluginDir)",
        "$ErrorActionPreference = 'Stop'",
        "while (Get-Process -Name Resolve -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 3 }",
        "Start-Sleep -Seconds 1",
        "if (-not (Test-Path -LiteralPath $SourceDir)) { throw 'Staged plugin folder not found' }",
        "New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null",
        "Get-ChildItem -LiteralPath $PluginDir -Force | Where-Object { $_.Name -ne 'reports' } | Remove-Item -Recurse -Force",
        "Get-ChildItem -LiteralPath $SourceDir -Force | Copy-Item -Destination $PluginDir -Recurse -Force",
    ].join("\r\n");
    fs.writeFileSync(scriptPath, script, "utf8");
    const child = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-SourceDir",
        pending.staged_plugin_dir,
        "-PluginDir",
        pending.plugin_dir,
    ], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
}

function expandZip(zipPath, targetDir) {
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
            zipPath,
            targetDir,
        ], {
            windowsHide: true,
        });
        let stderr = "";
        child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `Expand-Archive failed with code ${code}`));
        });
    });
}

function fetchJson(url, timeoutMs) {
    return fetchText(url, timeoutMs).then((text) => JSON.parse(text));
}

function fetchText(url, timeoutMs, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith("https:") ? https : http;
        const req = client.get(url, { headers: { "Accept": "application/json,text/plain,*/*" } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
                res.resume();
                const nextUrl = new URL(res.headers.location, url).toString();
                fetchText(nextUrl, timeoutMs, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.setTimeout(Math.max(3000, safeInt(timeoutMs, 12000)), () => {
            req.destroy(new Error("Update request timed out"));
        });
    });
}

function downloadFile(url, filePath, timeoutMs, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith("https:") ? https : http;
        const req = client.get(url, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
                res.resume();
                const nextUrl = new URL(res.headers.location, url).toString();
                downloadFile(nextUrl, filePath, timeoutMs, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`Download failed with HTTP ${res.statusCode}`));
                return;
            }
            const tempPath = `${filePath}.tmp`;
            const out = fs.createWriteStream(tempPath);
            res.pipe(out);
            out.on("finish", () => {
                out.close(() => {
                    fs.renameSync(tempPath, filePath);
                    resolve();
                });
            });
            out.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(Math.max(15000, safeInt(timeoutMs, 30000)), () => {
            req.destroy(new Error("Update download timed out"));
        });
    });
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex").toLowerCase();
}

function isNewerVersion(latest, current) {
    const a = versionParts(latest);
    const b = versionParts(current);
    const length = Math.max(a.length, b.length, 3);
    for (let i = 0; i < length; i += 1) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff > 0) return true;
        if (diff < 0) return false;
    }
    return false;
}

function versionParts(value) {
    return String(value || "0")
        .replace(/^v/i, "")
        .split(/[.\-_+]/)
        .map((part) => parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
}

function buildToolEnv() {
    const tempDir = path.join(RUNTIME_DIR, "tmp");
    try {
        fs.mkdirSync(tempDir, { recursive: true });
    } catch (_) {
        // ignore
    }
    return Object.assign({}, process.env, {
        PYTHONIOENCODING: "utf-8",
        TMP: tempDir,
        TEMP: tempDir,
        TMPDIR: tempDir,
    });
}

function buildPythonEnv() {
    return buildToolEnv();
}

function beginAnalysisSession(kind) {
    const session = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        kind,
        cancelled: false,
        child: null,
    };
    activeAnalysisState = session;
    return session;
}

function endAnalysisSession(session) {
    if (activeAnalysisState === session) {
        activeAnalysisState = null;
    }
    if (mainWindow) {
        try {
            mainWindow.setTitle(APP_DISPLAY_NAME);
        } catch (_) {
            // ignore
        }
    }
}

function cancelActiveAnalysis() {
    if (!activeAnalysisState) {
        return { status: "ok", active: false, cancelled: false };
    }
    activeAnalysisState.cancelled = true;
    if (activeAnalysisState.child && typeof activeAnalysisState.child.kill === "function") {
        try {
            activeAnalysisState.child.kill();
        } catch (_) {}
    }
    safeCall(() => projectObj && projectObj.StopRendering && projectObj.StopRendering(), false);
    return { status: "ok", active: true, cancelled: true, kind: activeAnalysisState.kind };
}

function isAnalysisCancelled(session = activeAnalysisState) {
    return !!(session && session.cancelled);
}

function cancelledReport(message = "检查已取消") {
    return {
        cancelled: true,
        status: "cancelled",
        message,
        issues: [],
        total_issues: 0,
        issues_by_type: {},
        issues_by_severity: {},
        marker_count: 0,
    };
}

function pythonCandidates() {
    const candidates = [];
    const bundledPython = path.join(__dirname, "runtime", "python", "python.exe");
    if (fs.existsSync(bundledPython)) candidates.push({ exe: bundledPython, args: [] });
    if (process.env.TIMELINEQC_PYTHON) candidates.push({ exe: process.env.TIMELINEQC_PYTHON, args: [] });
    candidates.push({ exe: "python3", args: [] });
    candidates.push({ exe: "python", args: [] });
    candidates.push({ exe: "py", args: ["-3"] });
    return candidates;
}

function runBackend(action, params, analysisSession = null) {
    return new Promise((resolve) => {
        if (isAnalysisCancelled(analysisSession)) {
            resolve(cancelledReport());
            return;
        }
        const payload = JSON.stringify(params || {});
        const candidates = pythonCandidates();

        function tryCandidate(index, lastError) {
            if (isAnalysisCancelled(analysisSession)) {
                resolve(cancelledReport());
                return;
            }
            if (index >= candidates.length) {
                resolve({ error: lastError || "Python not found" });
                return;
            }

            const candidate = candidates[index];
            const args = candidate.args.concat([BACKEND_SCRIPT, action, "--stdin"]);
            const child = spawn(candidate.exe, args, {
                cwd: __dirname,
                env: buildPythonEnv(),
                windowsHide: true,
            });
            if (analysisSession) {
                analysisSession.child = child;
            }

            let stdout = "";
            let stderr = "";
            let movedToNextCandidate = false;

            child.stdout.on("data", (data) => {
                stdout += data.toString("utf8");
            });
            child.stderr.on("data", (data) => {
                stderr += data.toString("utf8");
            });
            child.on("error", (error) => {
                if (analysisSession && analysisSession.child === child) {
                    analysisSession.child = null;
                }
                if (isAnalysisCancelled(analysisSession)) {
                    resolve(cancelledReport());
                    return;
                }
                if (movedToNextCandidate) return;
                movedToNextCandidate = true;
                tryCandidate(index + 1, error.message || String(error));
            });
            child.on("close", (code) => {
                if (analysisSession && analysisSession.child === child) {
                    analysisSession.child = null;
                }
                if (isAnalysisCancelled(analysisSession)) {
                    resolve(cancelledReport());
                    return;
                }
                if (movedToNextCandidate) return;
                if (code !== 0) {
                    movedToNextCandidate = true;
                    tryCandidate(index + 1, stderr.trim() || `Python exited with code ${code}`);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (error) {
                    resolve({
                        error: "Backend returned invalid JSON",
                        stdout,
                        stderr,
                    });
                }
            });

            if (child.stdin) {
                child.stdin.on("error", () => {});
                child.stdin.write(payload, "utf8");
                child.stdin.end();
            }
        }

        tryCandidate(0, "");
    });
}

async function getTimelineInfo() {
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error };
    }

    const width = safeInt(await timelineObj.GetSetting("timelineResolutionWidth"), 0);
    const height = safeInt(await timelineObj.GetSetting("timelineResolutionHeight"), 0);
    const startFrame = safeInt(await timelineObj.GetStartFrame(), 0);
    const endFrame = safeInt(await timelineObj.GetEndFrame(), 0);
    const videoTrackCount = safeInt(await timelineObj.GetTrackCount("video"), 0);
    const audioTrackCount = safeInt(await timelineObj.GetTrackCount("audio"), 0);
    const aspect = width && height ? width / height : null;

    return {
        unique_id: String(await safeCall(() => timelineObj.GetUniqueId(), "") || ""),
        name: await timelineObj.GetName(),
        start_frame: startFrame,
        end_frame: endFrame,
        duration_frames: Math.max(0, endFrame - startFrame),
        video_track_count: videoTrackCount,
        audio_track_count: audioTrackCount,
        frame_rate: await timelineObj.GetSetting("timelineFrameRate"),
        start_timecode: await safeCall(() => timelineObj.GetStartTimecode(), "00:00:00:00"),
        width,
        height,
        resolution: width && height ? `${width}x${height}` : "--",
        aspect: aspect ? round(aspect, 4) : null,
        profile: aspect && Math.abs(aspect - 9 / 16) <= 0.035 ? "short_drama_vertical" : "custom",
    };
}

async function getTimelineListData(forceRefresh) {
    const count = safeInt(await safeCall(() => projectObj.GetTimelineCount(), 0), 0);
    const projectName = String(await safeCall(() => projectObj.GetName(), "") || "");
    const projectId = String(await safeCall(() => projectObj.GetUniqueId(), "") || "");
    const cacheFresh =
        !forceRefresh &&
        timelineListCache &&
        timelineListCache.projectId === projectId &&
        timelineListCache.projectName === projectName &&
        timelineListCache.count === count &&
        Date.now() - timelineListCacheAt < TIMELINE_LIST_CACHE_MS;

    if (cacheFresh) {
        return timelineListCache;
    }

    const timelineLookup = await collectTimelineLookup(count);
    const effectiveCount = count > 0 ? count : timelineLookup.timelines.length;
    const folderScope = await getTimelineFolderScope(effectiveCount, timelineLookup);
    timelineListCache = {
        count,
        projectId,
        projectName,
        timelineLookup,
        folderScope,
    };
    timelineListCacheAt = Date.now();
    return timelineListCache;
}

async function getTimelineList(params = {}) {
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error };
    }

    const data = await getTimelineListData(!!params.refresh);
    const count = data.count;
    const currentFingerprint = timelineObj ? await buildTimelineFingerprint(timelineObj) : null;
    const timelineLookup = data.timelineLookup;
    const folderScope = data.folderScope;
    const requestedFolderId = String(params.folder_id || ALL_TIMELINES_FOLDER_ID);
    const selectedFolderId = requestedFolderId === ALL_TIMELINES_FOLDER_ID || folderScope.refs_by_folder[requestedFolderId]
        ? requestedFolderId
        : ALL_TIMELINES_FOLDER_ID;
    const folderRefs = selectedFolderId === ALL_TIMELINES_FOLDER_ID
        ? null
        : (folderScope.refs_by_folder[selectedFolderId] || null);
    const timelines = Array.isArray(folderRefs)
        ? timelineLookup.timelines.filter((item) => timelineMatchesFolderRefs(item, folderRefs))
        : timelineLookup.timelines.slice();
    let currentIndex = 0;

    for (const item of timelines) {
        item.current = timelinesMatch(item, currentFingerprint);
        if (item.current) currentIndex = item.index;
    }

    return {
        status: "ok",
        folders: folderScope.folders,
        selected_folder_id: selectedFolderId,
        timelines,
        current_index: currentIndex,
        count: timelines.length,
    };
}

async function collectTimelineLookup(count) {
    const timelines = [];
    const names = new Set();
    const uniqueIds = new Set();

    const maxProbe = count > 0 ? count : 200;
    let consecutiveMisses = 0;
    for (let index = 1; index <= maxProbe; index += 1) {
        const timeline = await safeCall(() => projectObj.GetTimelineByIndex(index), null);
        if (!timeline) {
            if (count <= 0 && timelines.length > 0) {
                consecutiveMisses += 1;
                if (consecutiveMisses >= 10) {
                    break;
                }
            }
            continue;
        }

        const item = await buildTimelineFingerprint(timeline);
        item.index = index;
        item.current = false;
        timelines.push(item);
        if (item.unique_id) uniqueIds.add(item.unique_id);
        if (item.name) names.add(item.name);

        consecutiveMisses = 0;
    }

    if (!timelines.length) {
        const currentTimeline = await safeCall(() => projectObj.GetCurrentTimeline(), null);
        if (currentTimeline) {
            const item = await buildTimelineFingerprint(currentTimeline);
            item.index = 1;
            item.current = true;
            timelines.push(item);
            if (item.unique_id) uniqueIds.add(item.unique_id);
            if (item.name) names.add(item.name);
        }
    }

    return {
        timelines,
        names,
        uniqueIds,
    };
}

async function getTimelineFolderScope(totalTimelineCount, timelineLookup) {
    const folders = [{
        id: ALL_TIMELINES_FOLDER_ID,
        name: "全部时间线",
        path: "全部时间线",
        depth: 0,
        timeline_count: totalTimelineCount,
        direct_timeline_count: totalTimelineCount,
        all: true,
    }];
    const refsByFolder = {};

    const mediaPool = await safeCall(() => projectObj.GetMediaPool(), null);
    const rootFolder = mediaPool ? await safeCall(() => mediaPool.GetRootFolder(), null) : null;
    if (!rootFolder) {
        return { folders, refs_by_folder: refsByFolder };
    }

    async function walkFolder(folder, pathParts, depth, includeEntry) {
        const fallbackName = depth === 0 ? "素材池根目录" : "未命名文件夹";
        const name = String(await safeCall(() => folder.GetName(), fallbackName) || fallbackName);
        const nextPathParts = pathParts.concat([name]);
        const folderPath = nextPathParts.join("/");
        const folderId = await folderStableId(folder, folderPath);
        const directRefs = await collectFolderTimelineRefs(folder, {
            id: folderId,
            name,
            path: folderPath,
            depth,
        }, timelineLookup);
        let aggregateRefs = directRefs.slice();
        const children = normalizeResolveList(await safeCall(() => folder.GetSubFolderList(), []));

        for (const child of children) {
            if (!child) continue;
            const childRefs = await walkFolder(child, nextPathParts, depth + 1, true);
            aggregateRefs = aggregateRefs.concat(childRefs);
        }

        const uniqueRefs = dedupeTimelineRefs(aggregateRefs);
        refsByFolder[folderId] = uniqueRefs;

        if (includeEntry !== false && uniqueRefs.length > 0) {
            folders.push({
                id: folderId,
                name,
                path: folderPath,
                depth,
                timeline_count: uniqueRefs.length,
                direct_timeline_count: directRefs.length,
            });
        }

        return uniqueRefs;
    }

    try {
        await walkFolder(rootFolder, [], 0, false);
    } catch (_) {
        // Keep the all-timelines fallback if Resolve refuses folder traversal.
    }
    return { folders, refs_by_folder: refsByFolder };
}

async function folderStableId(folder, folderPath) {
    const uniqueId = String(await safeCall(() => folder.GetUniqueId(), "") || "").trim();
    if (uniqueId) return `folder:${uniqueId}`;
    return `path:${folderPath}`;
}

async function collectFolderTimelineRefs(folder, folderInfo, timelineLookup) {
    const refs = [];
    const clips = normalizeResolveList(await safeCall(() => folder.GetClipList(), []));
    for (const mediaPoolItem of clips) {
        if (!mediaPoolItem) continue;
        const props = await safeCall(() => mediaPoolItem.GetClipProperty(), {});
        const ref = await buildTimelineMediaPoolRef(mediaPoolItem, props, folderInfo, timelineLookup);
        if (ref) refs.push(ref);
    }
    return refs;
}

function isTimelineMediaPoolItem(name, props, uniqueId, timelineLookup) {
    if (uniqueId && timelineLookup && timelineLookup.uniqueIds && timelineLookup.uniqueIds.has(uniqueId)) {
        return true;
    }

    const typeText = normalizeTimelineText([
        props && props.Type,
        props && props["Clip Type"],
        props && props["Media Type"],
        props && props["媒体类型"],
        props && props.Kind,
        props && props.Format,
    ]);

    const nameMatchesKnownTimeline = !!(
        name &&
        timelineLookup &&
        timelineLookup.names &&
        timelineLookup.names.has(name)
    );

    if (looksLikeTimelineType(typeText) && nameMatchesKnownTimeline) {
        return true;
    }

    return false;
}

async function buildTimelineMediaPoolRef(mediaPoolItem, props, folderInfo, timelineLookup) {
    const name = String(
        await safeCall(() => mediaPoolItem.GetName(), "")
        || (props && (props.Name || props["Clip Name"] || props["File Name"]))
        || "未命名时间线"
    );
    const uniqueId = String(
        await safeCall(() => mediaPoolItem.GetUniqueId(), "")
        || await safeCall(() => mediaPoolItem.GetMediaId(), "")
        || ""
    );
    if (!isTimelineMediaPoolItem(name, props, uniqueId, timelineLookup)) {
        return null;
    }
    const matchedTimeline = findTimelineMatchForMediaPoolRef(name, uniqueId, timelineLookup);
    if (!matchedTimeline) {
        return null;
    }
    return {
        unique_id: matchedTimeline.unique_id || uniqueId,
        name: matchedTimeline.name || name,
        timeline_index: matchedTimeline.index,
        folder_id: folderInfo.id,
        folder_name: folderInfo.name,
        folder_path: folderInfo.path,
    };
}

function findTimelineMatchForMediaPoolRef(name, uniqueId, timelineLookup) {
    const timelines = timelineLookup && Array.isArray(timelineLookup.timelines)
        ? timelineLookup.timelines
        : [];
    if (uniqueId) {
        const byId = timelines.find((timeline) => timeline && timeline.unique_id && timeline.unique_id === uniqueId);
        if (byId) return byId;
    }
    if (name) {
        return timelines.find((timeline) => timeline && timeline.name === name) || null;
    }
    return null;
}

function timelineMatchesFolderRefs(timeline, refs) {
    if (!refs || !refs.length) return false;
    for (const ref of refs) {
        if (!ref) continue;
        if (ref.timeline_index && timeline.index && ref.timeline_index === timeline.index) {
            return true;
        }
        if (ref.unique_id && timeline.unique_id && ref.unique_id === timeline.unique_id) {
            return true;
        }
        if (ref.name && timeline.name && ref.name === timeline.name) {
            return true;
        }
    }
    return false;
}

function dedupeTimelineRefs(refs) {
    const seen = new Set();
    const uniqueRefs = [];
    for (const ref of refs || []) {
        if (!ref) continue;
        const key = ref.timeline_index
            ? `timeline:${ref.timeline_index}`
            : (ref.unique_id ? `id:${ref.unique_id}` : `name:${ref.name || ""}`);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueRefs.push(ref);
    }
    return uniqueRefs;
}

function normalizeTimelineText(values) {
    return (values || [])
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase())
        .join(" ");
}

function looksLikeTimelineType(text) {
    if (!text) return false;
    return [
        "timeline",
        "时间线",
        "時間線",
    ].some((keyword) => text.includes(keyword));
}

async function selectTimeline(indexValue) {
    const switchResult = await switchTimelineByIndex(indexValue);
    if (switchResult.error) {
        return switchResult;
    }

    const info = await getTimelineInfo();
    return {
        status: "ok",
        selected_index: switchResult.selected_index,
        current_index: switchResult.current_index,
        switch_result: switchResult.switch_result,
        timeline: info,
    };
}

async function switchTimelineByIndex(indexValue, skipEnsure) {
    if (!skipEnsure) {
        const ready = await ensureResolveObjects();
        if (!ready.ok) {
            return { error: ready.error };
        }
    }

    const index = safeInt(indexValue, 0);
    const count = safeInt(await safeCall(() => projectObj.GetTimelineCount(), 0), 0);
    if (index < 1 || (count > 0 && index > count)) {
        return { error: `Invalid timeline index: ${index}` };
    }

    const timeline = await safeCall(() => projectObj.GetTimelineByIndex(index), null);
    if (!timeline) {
        return { error: `Timeline not found: ${index}` };
    }

    const switched = await safeCall(() => projectObj.SetCurrentTimeline(timeline), null);
    if (switched === false) {
        return { error: `Failed to select timeline: ${index}` };
    }
    timelineObj = timeline;
    await sleep(120);
    const currentTimeline = await safeCall(() => projectObj.GetCurrentTimeline(), null);
    if (currentTimeline) {
        timelineObj = currentTimeline;
    }
    return {
        status: "ok",
        selected_index: index,
        current_index: index,
        switch_result: switched,
    };
}

async function buildTimelineFingerprint(timeline) {
    const width = safeInt(await safeCall(() => timeline.GetSetting("timelineResolutionWidth"), 0), 0);
    const height = safeInt(await safeCall(() => timeline.GetSetting("timelineResolutionHeight"), 0), 0);
    const startFrame = safeInt(await safeCall(() => timeline.GetStartFrame(), 0), 0);
    const endFrame = safeInt(await safeCall(() => timeline.GetEndFrame(), 0), 0);

    return {
        unique_id: String(await safeCall(() => timeline.GetUniqueId(), "") || ""),
        name: String(await safeCall(() => timeline.GetName(), "未命名时间线") || "未命名时间线"),
        start_frame: startFrame,
        end_frame: endFrame,
        duration_frames: Math.max(0, endFrame - startFrame),
        frame_rate: String(await safeCall(() => timeline.GetSetting("timelineFrameRate"), "") || ""),
        width,
        height,
        resolution: width && height ? `${width}x${height}` : "--",
        video_track_count: safeInt(await safeCall(() => timeline.GetTrackCount("video"), 0), 0),
    };
}

function timelinesMatch(candidate, current) {
    if (!candidate || !current) return false;
    if (candidate.unique_id && current.unique_id) {
        return candidate.unique_id === current.unique_id;
    }
    return (
        candidate.name === current.name &&
        candidate.start_frame === current.start_frame &&
        candidate.end_frame === current.end_frame &&
        candidate.frame_rate === current.frame_rate &&
        candidate.video_track_count === current.video_track_count
    );
}

async function collectClipsInfo(analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error };
    }

    const clipsInfo = [];
    const videoTrackCount = safeInt(await timelineObj.GetTrackCount("video"), 0);
    const timelineStart = safeInt(await timelineObj.GetStartFrame(), 0);

    for (let trackIdx = 1; trackIdx <= videoTrackCount; trackIdx += 1) {
        if (isAnalysisCancelled(analysisSession)) return cancelledReport();
        if (trackIdx > 1 && trackIdx % 2 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const trackName = await safeCall(() => timelineObj.GetTrackName("video", trackIdx), "");
        const trackEnabled = await safeCall(() => timelineObj.GetIsTrackEnabled("video", trackIdx), true);
        const clips = await safeCall(() => timelineObj.GetItemListInTrack("video", trackIdx), []);
        if (!Array.isArray(clips)) {
            continue;
        }

        for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
            if (clipIndex > 0 && clipIndex % 8 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const clip = clips[clipIndex];
            if (isAnalysisCancelled(analysisSession)) return cancelledReport();
            try {
                const rawStart = safeInt(await clip.GetStart(), 0);
                const rawEnd = safeInt(await clip.GetEnd(), rawStart);
                const startFrame = normalizeTimelineFrame(rawStart, timelineStart);
                const endFrame = normalizeTimelineFrame(rawEnd, timelineStart);
                let duration = safeInt(await clip.GetDuration(), Math.max(0, endFrame - startFrame));
                if (duration <= 0 && endFrame > startFrame) {
                    duration = endFrame - startFrame;
                }

                const enabled = trackEnabled && (await safeCall(() => clip.GetClipEnabled(), true));
                const mediaPoolItem = await safeCall(() => clip.GetMediaPoolItem(), null);
                const clipProps = mediaPoolItem ? await safeCall(() => mediaPoolItem.GetClipProperty(), {}) : {};
                const itemProps = await safeCall(() => clip.GetProperty(), {});
                const gradeStatus = await collectGradeStatus(clip, clipProps);
                const clipName = await safeCall(() => clip.GetName(), "Unknown");
                const transitionMetadata = await collectTransitionMetadata(clip);
                const transitionHint = detectTransitionHint({
                    clipName,
                    trackName,
                    mediaType: clipProps.Type || clipProps["Clip Type"] || clipProps["Video Codec"] || "",
                    fileName: clipProps["File Name"] || clipProps.FileName || "",
                    filePath: clipProps["File Path"] || clipProps.FilePath || "",
                    clipProps,
                    itemProps,
                    transitionMetadata,
                });
                const graphicOverlayHint = detectGraphicOverlayHint({
                    clipName,
                    trackName,
                    mediaType: clipProps.Type || clipProps["Clip Type"] || clipProps["Video Codec"] || "",
                    fileName: clipProps["File Name"] || clipProps.FileName || "",
                    filePath: clipProps["File Path"] || clipProps.FilePath || "",
                    clipProps,
                    itemProps,
                    trackIndex: trackIdx,
                });
                const transparentOverlayHint = detectTransparentOverlayHint({
                    clipName,
                    trackName,
                    mediaType: clipProps.Type || clipProps["Clip Type"] || clipProps["Video Codec"] || "",
                    fileName: clipProps["File Name"] || clipProps.FileName || "",
                    filePath: clipProps["File Path"] || clipProps.FilePath || "",
                    clipProps,
                    itemProps,
                    trackIndex: trackIdx,
                    graphicOverlayHint,
                });

                clipsInfo.push({
                    track_index: trackIdx,
                    track_name: trackName,
                    track_enabled: !!trackEnabled,
                    enabled: !!enabled,
                    name: clipName,
                    start: rawStart,
                    end: rawEnd,
                    start_frame: startFrame,
                    end_frame: endFrame,
                    duration,
                    left_offset: await safeCall(() => clip.GetLeftOffset(), 0),
                    right_offset: await safeCall(() => clip.GetRightOffset(), 0),
                    source_start_frame: await safeCall(() => clip.GetSourceStartFrame(), null),
                    source_end_frame: await safeCall(() => clip.GetSourceEndFrame(), null),
                    media_id: mediaPoolItem ? await safeCall(() => mediaPoolItem.GetMediaId(), "") : "",
                    file_name: clipProps["File Name"] || clipProps.FileName || "",
                    file_path: clipProps["File Path"] || clipProps.FilePath || "",
                    media_type: clipProps.Type || clipProps["Clip Type"] || clipProps["Video Codec"] || "",
                    item_properties: normalizeTimelineItemProperties(itemProps),
                    fusion_comp_count: await safeCall(() => clip.GetFusionCompCount(), 0),
                    grade_status: gradeStatus,
                    transition_hint: transitionHint,
                    transition_metadata: transitionMetadata,
                    graphic_overlay_hint: graphicOverlayHint,
                    transparent_overlay_hint: transparentOverlayHint,
                });
            } catch (_) {
                // skip problematic clip
            }
        }
    }

    return clipsInfo;
}

async function collectAudioClipsInfo(analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error };
    }

    const clipsInfo = [];
    const audioTrackCount = safeInt(await safeCall(() => timelineObj.GetTrackCount("audio"), 0), 0);
    const timelineStart = safeInt(await safeCall(() => timelineObj.GetStartFrame(), 0), 0);

    for (let trackIdx = 1; trackIdx <= audioTrackCount; trackIdx += 1) {
        if (isAnalysisCancelled(analysisSession)) return cancelledReport();
        if (trackIdx > 1 && trackIdx % 2 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const trackName = await safeCall(() => timelineObj.GetTrackName("audio", trackIdx), "");
        const trackEnabled = await safeCall(() => timelineObj.GetIsTrackEnabled("audio", trackIdx), true);
        const trackFormat = await safeCall(() => timelineObj.GetTrackFormat("audio", trackIdx), "");
        const trackType = await safeCall(() => timelineObj.GetTrackType("audio", trackIdx), "");
        const clips = normalizeResolveList(await safeCall(() => timelineObj.GetItemListInTrack("audio", trackIdx), []));

        for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
            if (clipIndex > 0 && clipIndex % 8 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const clip = clips[clipIndex];
            if (isAnalysisCancelled(analysisSession)) return cancelledReport();
            if (!clip) continue;
            try {
                const rawStart = safeInt(await safeCall(() => clip.GetStart(), 0), 0);
                const rawEnd = safeInt(await safeCall(() => clip.GetEnd(), rawStart), rawStart);
                const startFrame = normalizeTimelineFrame(rawStart, timelineStart);
                const endFrame = normalizeTimelineFrame(rawEnd, timelineStart);
                let duration = safeInt(await safeCall(() => clip.GetDuration(), Math.max(0, endFrame - startFrame)), Math.max(0, endFrame - startFrame));
                if (duration <= 0 && endFrame > startFrame) {
                    duration = endFrame - startFrame;
                }

                const mediaPoolItem = await safeCall(() => clip.GetMediaPoolItem(), null);
                const clipProps = mediaPoolItem ? await safeCall(() => mediaPoolItem.GetClipProperty(), {}) : {};
                const itemProps = await safeCall(() => clip.GetProperty(), {});
                const enabled = trackEnabled && (await safeCall(() => clip.GetClipEnabled(), true));

                clipsInfo.push({
                    track_index: trackIdx,
                    track_name: trackName,
                    track_enabled: !!trackEnabled,
                    track_format: trackFormat,
                    track_type: trackType,
                    enabled: !!enabled,
                    name: await safeCall(() => clip.GetName(), "Unknown"),
                    start: rawStart,
                    end: rawEnd,
                    start_frame: startFrame,
                    end_frame: endFrame,
                    duration,
                    media_id: mediaPoolItem ? await safeCall(() => mediaPoolItem.GetMediaId(), "") : "",
                    clip_properties: clipProps && typeof clipProps === "object" ? clipProps : {},
                    item_properties: itemProps && typeof itemProps === "object" ? itemProps : {},
                });
            } catch (_) {
                // skip problematic audio clip
            }
        }
    }

    return clipsInfo;
}

function detectMonoAudioIssues(audioClipsInfo) {
    const issues = [];
    for (const clip of audioClipsInfo || []) {
        if (!clip || clip.enabled === false || clip.track_enabled === false) continue;

        const evidence = getMonoAudioEvidence(clip);
        if (!evidence || !evidence.mono) continue;

        const startFrame = Math.max(0, safeInt(clip.start_frame, 0));
        const duration = Math.max(1, safeInt(clip.duration, safeInt(clip.end_frame, startFrame + 1) - startFrame));
        const clipName = clip.name || "Unknown";
        const trackLabel = clip.track_index ? `A${clip.track_index}` : "A?";

        issues.push({
            type: "mono_audio",
            frame: startFrame,
            duration_frames: duration,
            severity: "warning",
            note: `音频疑似单声道: ${clipName} (${trackLabel})，依据 ${evidence.label}`,
            confidence: evidence.confidence,
            clip_name: clipName,
            track_index: safeInt(clip.track_index, 0),
            detection_mode: "timeline_audio",
        });
    }
    return issues;
}

function getMonoAudioEvidence(clip) {
    const candidates = [];
    const clipProps = clip.clip_properties || {};
    const itemProps = clip.item_properties || {};
    Object.keys(clipProps).forEach((key) => candidates.push({ key, value: clipProps[key], priority: 3 }));
    Object.keys(itemProps).forEach((key) => candidates.push({ key, value: itemProps[key], priority: 2 }));
    candidates.push({ key: "track_format", value: clip.track_format, priority: 2 });
    candidates.push({ key: "track_type", value: clip.track_type, priority: 2 });
    candidates.push({ key: "track_name", value: clip.track_name, priority: 1 });

    let bestMono = null;
    let explicitStereo = false;

    for (const candidate of candidates) {
        const parsed = parseAudioChannelEvidence(candidate.key, candidate.value, candidate.priority);
        if (!parsed) continue;
        if (parsed.mono) {
            if (!bestMono || parsed.confidence > bestMono.confidence) {
                bestMono = parsed;
            }
        } else if (parsed.explicit_channels && parsed.channel_count > 1 && candidate.priority >= 2) {
            explicitStereo = true;
        }
    }

    if (!bestMono) return null;
    if (explicitStereo && bestMono.confidence < 0.9) return null;
    return bestMono;
}

function parseAudioChannelEvidence(key, value, priority) {
    if (value === undefined || value === null || value === "") return null;

    const keyText = String(key || "").toLowerCase();
    const rawText = String(value).trim();
    const text = rawText.toLowerCase();
    const channelKey = /channel|channels|声道|聲道|track_format|track_type/.test(keyText);
    const countMatch = text.match(/(?:^|[^0-9])([1-9][0-9]?)\s*(?:ch|chs|channel|channels|声道|聲道)(?:[^0-9]|$)/);
    const keyCountMatch = channelKey ? text.match(/^\s*([1-9][0-9]?)(?:\.0+)?\s*$/) : null;
    const labeledCountMatch = text.match(/(?:channels?|声道|聲道)\D{0,8}([1-9][0-9]?)/);

    if (/\bmono\b|单声道|單聲道/.test(text)) {
        return {
            mono: true,
            label: `${key}: ${rawText}`,
            confidence: priority >= 2 ? 0.92 : 0.78,
            explicit_channels: true,
            channel_count: 1,
        };
    }

    const matchedCount = countMatch || keyCountMatch || labeledCountMatch;
    if (matchedCount && (channelKey || countMatch || labeledCountMatch)) {
        const channelCount = safeInt(matchedCount[1], 0);
        if (channelCount === 1) {
            return {
                mono: true,
                label: `${key}: ${rawText}`,
                confidence: priority >= 2 ? 0.9 : 0.72,
                explicit_channels: true,
                channel_count: 1,
            };
        }
        if (channelCount > 1) {
            return {
                mono: false,
                label: `${key}: ${rawText}`,
                confidence: 0.82,
                explicit_channels: true,
                channel_count: channelCount,
            };
        }
    }

    if (/\bstereo\b|立体声|立體聲/.test(text)) {
        return {
            mono: false,
            label: `${key}: ${rawText}`,
            confidence: 0.82,
            explicit_channels: true,
            channel_count: 2,
        };
    }

    return null;
}

function normalizeTimelineItemProperties(itemProps) {
    const props = itemProps && typeof itemProps === "object" ? itemProps : {};
    const opacity = firstNumericProperty(props, ["Opacity", "opacity"], 100);
    const compositeMode = firstNumericProperty(props, ["CompositeMode", "Composite Mode", "compositeMode"], 0);
    return {
        opacity,
        composite_mode: compositeMode,
        zoom_x: firstNumericProperty(props, ["ZoomX", "Zoom X"], 1),
        zoom_y: firstNumericProperty(props, ["ZoomY", "Zoom Y"], 1),
        crop_left: firstNumericProperty(props, ["CropLeft", "Crop Left"], 0),
        crop_right: firstNumericProperty(props, ["CropRight", "Crop Right"], 0),
        crop_top: firstNumericProperty(props, ["CropTop", "Crop Top"], 0),
        crop_bottom: firstNumericProperty(props, ["CropBottom", "Crop Bottom"], 0),
        transition_mix: firstNumericProperty(props, ["TransitionMix", "Transition Mix", "transitionMix"], 0),
    };
}

function firstNumericProperty(props, keys, fallback) {
    for (const key of keys) {
        if (props[key] !== undefined && props[key] !== null && props[key] !== "") {
            const value = parseFloat(props[key]);
            if (Number.isFinite(value)) return value;
        }
    }
    return fallback;
}

async function collectGradeStatus(clip, clipProps) {
    const status = {
        node_count: null,
        has_grade_signal: false,
        strong_grade_signal: false,
        metadata_grade_hint: false,
        reason: "",
    };

    try {
        const group = await safeCall(() => clip.GetColorGroup(), null);
        if (group) {
            status.has_grade_signal = true;
            status.strong_grade_signal = true;
            status.reason = "已加入调色组";
        }
    } catch (_) {}

    try {
        const numNodes = await safeCall(() => clip.GetNumNodes(), null);
        if (numNodes !== null && numNodes !== undefined) {
            status.node_count = safeInt(numNodes, null);
            if (status.node_count > 1) {
                status.has_grade_signal = true;
                status.strong_grade_signal = true;
                status.reason = "存在多个调色节点";
            } else if (status.node_count === 1) {
                status.metadata_grade_hint = true;
                if (!status.reason) status.reason = "仅发现单节点，需结合画面判断";
            }
        }
    } catch (_) {}

    const lutUsed = String(clipProps.LUT || "").trim();
    if (lutUsed && !["none", "no lut", "无"].includes(lutUsed.toLowerCase())) {
        status.has_grade_signal = true;
        status.strong_grade_signal = true;
        status.reason = "素材属性包含 LUT";
    }

    if (!status.has_grade_signal) {
        const keywords = ["grade", "color", "lut", "gamma", "lift", "gain"];
        const propertyKeys = Object.keys(clipProps || {});
        if (propertyKeys.some((key) => keywords.some((kw) => key.toLowerCase().includes(kw)))) {
            status.metadata_grade_hint = true;
            if (!status.reason) status.reason = "素材属性包含色彩字段，需结合画面判断";
        }
    }

    return status;
}

async function collectTransitionMetadata(clip) {
    const methods = [
        "GetLeftTransition",
        "GetRightTransition",
        "GetStartTransition",
        "GetEndTransition",
        "GetTransition",
        "GetTransitions",
    ];
    const hits = [];
    for (const methodName of methods) {
        if (!clip || typeof clip[methodName] !== "function") continue;
        const value = await safeCall(() => clip[methodName](), null);
        if (value) {
            hits.push(methodName);
        }
    }
    return {
        has_transition: hits.length > 0,
        methods: hits,
    };
}

const TRANSITION_KEYWORDS = [
    "transition",
    "dissolve",
    "cross dissolve",
    "dip to",
    "fade",
    "wipe",
    "push",
    "slide",
    "zoom",
    "blur",
    "glitch",
    "flash transition",
    "swish",
    "whip",
    "smooth cut",
    "转场",
    "叠化",
    "溶解",
    "淡入",
    "淡出",
    "淡化",
    "闪白",
    "闪黑",
    "擦除",
    "划像",
    "推拉",
    "变焦",
];

const GRAPHIC_OVERLAY_KEYWORDS = [
    "lower third",
    "lowerthird",
    "name bar",
    "namebar",
    "name tag",
    "location tag",
    "location bar",
    "info bar",
    "caption bar",
    "strap",
    "banner",
    "callout",
    "chiron",
    "chyron",
    "title card",
    "subtitle bar",
    "字幕条",
    "人名条",
    "地名条",
    "姓名条",
    "名字条",
    "名条",
    "地名",
    "人名",
    "姓名",
    "地点条",
    "地点",
    "地址条",
    "位置条",
    "信息条",
    "介绍条",
    "标题条",
    "花字",
    "角标",
    "台标",
    "水印",
    "标签",
    "标识",
    "条幅",
    "贴纸",
];

const OVERLAY_IMAGE_EXTENSIONS = new Set([".png", ".apng", ".gif", ".webp", ".tga", ".psd", ".exr", ".tif", ".tiff", ".jpg", ".jpeg"]);
const OVERLAY_VIDEO_EXTENSIONS = new Set([".mov", ".m4v", ".mp4", ".mxf", ".mkv", ".avi", ".webm"]);
const QUICK_TRANSPARENT_IMAGE_EXTENSIONS = new Set([".png"]);
const STILL_MEDIA_KEYWORDS = ["still", "image", "picture", "photo", "png", "jpeg", "jpg", "tiff", "tga", "webp", "gif", "psd", "exr"];
const ALPHA_HINT_KEYWORDS = [
    "alpha channel",
    "alpha mode",
    "has alpha",
    "with alpha",
    "straight alpha",
    "transparen",
    "transparency",
    "rgba",
    "argb",
    "bgra",
    "abgr",
    "yuva",
    "premult",
    "transparent",
    "4444",
    "prores 4444",
    "prores4444",
    "ap4h",
    "ap4x",
    "animation",
    "qtrle",
    "matte",
    "\u900f\u660e",
    "\u963f\u5c14\u6cd5",
];
const ALPHA_PROPERTY_KEYS = ["alpha", "alpha mode", "alpha channel", "matte", "transparency"];
const ALPHA_NEGATIVE_KEYWORDS = ["none", "no", "not", "without", "false", "off", "disabled", "0", "\u65e0", "\u6ca1\u6709", "\u4e0d\u542b", "\u5426"];

function detectTransitionHint(source) {
    source = source || {};
    const reasons = [];
    let confidence = 0;
    const textFields = [
        source.clipName,
        source.trackName,
        source.mediaType,
        source.fileName,
        source.filePath,
    ];

    if (source.transitionMetadata && source.transitionMetadata.has_transition) {
        confidence += 0.85;
        reasons.push("resolve_transition_api");
    }

    if (containsTransitionKeyword(textFields.join(" "))) {
        confidence += 0.7;
        reasons.push("name_or_path");
    }

    const propScore = scoreTransitionProperties(source.clipProps, 0.25) + scoreTransitionProperties(source.itemProps, 0.35);
    if (propScore > 0) {
        confidence += propScore;
        reasons.push("properties");
    }

    confidence = Math.min(1, confidence);
    return {
        is_transition: confidence >= 0.45,
        confidence,
        reason: reasons.join(","),
    };
}

function detectGraphicOverlayHint(source) {
    source = source || {};
    const fields = [
        source.clipName,
        source.trackName,
        source.mediaType,
        source.fileName,
        source.filePath,
    ];
    const text = fields.join(" ").toLowerCase();
    const pathText = String(source.filePath || source.fileName || "").toLowerCase();
    const ext = path.extname(pathText || "");
    const trackIndex = safeInt(source.trackIndex, 0);
    const alphaHint = hasAlphaHintSafe(source.clipProps, source.itemProps, source.fileName, source.mediaType, source.filePath);
    const pngLike = QUICK_TRANSPARENT_IMAGE_EXTENSIONS.has(ext);
    const videoLike = OVERLAY_VIDEO_EXTENSIONS.has(ext) || isVideoSource(source.mediaType, source.clipProps);
    let confidence = 0;
    const reasons = [];

    if (containsAnyKeyword(text, GRAPHIC_OVERLAY_KEYWORDS) && (!videoLike || pngLike)) {
        confidence += 0.75;
        reasons.push("graphic_keyword");
    }

    if (trackIndex > 1 && pngLike) {
        confidence += 0.72;
        reasons.push("upper_track_png");
    }

    if (!videoLike && alphaHint) {
        confidence += trackIndex > 1 ? 0.42 : 0.28;
        reasons.push("alpha_hint");
    }

    if (pngLike && containsAnyKeyword(text, ["name", "location", "人名", "地名", "字幕", "角标", "lower third", "banner"])) {
        confidence += 0.2;
    }

    confidence = Math.min(1, confidence);
    return {
        is_graphic_overlay: confidence >= 0.5,
        confidence,
        reasons,
        extension: ext,
    };
}

function detectTransparentOverlayHint(source) {
    source = source || {};
    const pathText = String(source.filePath || source.fileName || "").toLowerCase();
    const ext = path.extname(pathText || "");
    const trackIndex = safeInt(source.trackIndex, 0);
    let confidence = 0;
    const reasons = [];

    if (trackIndex > 1 && QUICK_TRANSPARENT_IMAGE_EXTENSIONS.has(ext)) {
        confidence += 1;
        reasons.push("upper_track_png");
    }

    confidence = Math.min(1, confidence);
    return {
        is_transparent_overlay: confidence >= 0.7,
        should_ignore: confidence >= 0.7 && trackIndex > 1,
        confidence,
        reasons,
        extension: ext,
    };
}

function isTransparentOverlayClipData(clipData) {
    if (!clipData) return false;
    const hint = clipData.transparent_overlay_hint || {};
    const trackIndex = safeInt(clipData.track_index, 0);
    if (trackIndex <= 1) {
        return false;
    }
    if (hint.should_ignore || hint.is_transparent_overlay || parseFloat(hint.confidence || 0) >= 0.7) {
        return true;
    }
    const fallback = detectTransparentOverlayHint({
        clipName: clipData.name,
        trackName: clipData.track_name,
        mediaType: clipData.media_type,
        fileName: clipData.file_name,
        filePath: clipData.file_path,
        itemProps: clipData.item_properties,
        trackIndex: clipData.track_index,
        graphicOverlayHint: clipData.graphic_overlay_hint,
    });
    return fallback.should_ignore;
}

function shouldIgnoreQuickAnalysisClip(clipData, options) {
    if (!clipData || (options && options.quick_ignore_transparent_overlay_layers === false)) {
        return false;
    }
    if (safeInt(clipData.track_index, 0) <= 1) {
        return false;
    }
    return isTransparentOverlayClipData(clipData);
}

function filterQuickAnalysisClips(clipsInfo, options) {
    return (clipsInfo || []).filter((clip) => !shouldIgnoreQuickAnalysisClip(clip, options));
}

function containsAnyKeyword(text, keywords) {
    const normalized = String(text || "").toLowerCase();
    return (keywords || []).some((keyword) => normalized.includes(String(keyword || "").toLowerCase()));
}

function hasAlphaHint(...sources) {
    for (const source of sources) {
        if (!source) continue;
        const text = typeof source === "object"
            ? Object.entries(source).map(([key, value]) => `${key}:${value}`).join(" ")
            : String(source);
        const lowered = text.toLowerCase();
        if (!lowered) continue;
        if (ALPHA_HINT_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
            if (!/\b(no|not|without|false|none|无|没有)\b/.test(lowered)) {
                return true;
            }
        }
    }
    return false;
}

function hasAlphaHintSafe(...sources) {
    for (const source of sources) {
        if (!source) continue;
        if (typeof source === "object") {
            for (const [key, value] of Object.entries(source)) {
                const keyText = String(key || "").toLowerCase();
                const valueText = String(value === undefined || value === null ? "" : value).toLowerCase();
                const pairText = `${keyText}:${valueText}`;
                if (!valueText && ALPHA_PROPERTY_KEYS.some((keyword) => keyText.includes(keyword))) {
                    continue;
                }
                if (isNegativeAlphaText(pairText)) {
                    continue;
                }
                if (isExplicitAlphaProperty(keyText, valueText) || isStrongAlphaText(valueText) || isStrongAlphaText(pairText)) {
                    return true;
                }
            }
            continue;
        }

        const lowered = String(source || "").toLowerCase();
        if (!lowered || isNegativeAlphaText(lowered)) continue;
        if (isStrongAlphaText(lowered)) {
            return true;
        }
    }
    return false;
}

function isExplicitAlphaProperty(keyText, valueText) {
    if (!ALPHA_PROPERTY_KEYS.some((keyword) => keyText.includes(keyword))) {
        return false;
    }
    if (!valueText || isNegativeAlphaText(valueText)) {
        return false;
    }
    return true;
}

function isStrongAlphaText(text) {
    const lowered = String(text || "").toLowerCase();
    if (!lowered || isNegativeAlphaText(lowered)) {
        return false;
    }
    return ALPHA_HINT_KEYWORDS.some((keyword) => lowered.includes(String(keyword).toLowerCase()));
}

function isNegativeAlphaText(text) {
    const lowered = String(text || "").toLowerCase();
    if (!lowered) return false;
    return ALPHA_NEGATIVE_KEYWORDS.some((keyword) => {
        const value = String(keyword).toLowerCase();
        if (value === "0") {
            return /(^|[:=\s])0($|[\s,;])/.test(lowered);
        }
        return lowered.includes(value);
    });
}

function isStillImageSource(mediaType, clipProps) {
    const text = stringifyMetadata(mediaType, clipProps).toLowerCase();
    return containsAnyKeyword(text, STILL_MEDIA_KEYWORDS);
}

function isVideoSource(mediaType, clipProps) {
    const text = stringifyMetadata(mediaType, clipProps).toLowerCase();
    return /video|movie|quicktime|mpeg|h\.?264|h\.?265|prores|dnx|avc|hevc|mov|mp4|mxf|mkv|avi|webm/.test(text);
}

function stringifyMetadata(...sources) {
    const parts = [];
    for (const source of sources) {
        if (!source) continue;
        if (typeof source === "object") {
            for (const [key, value] of Object.entries(source)) {
                parts.push(`${key}:${value}`);
            }
        } else {
            parts.push(String(source));
        }
    }
    return parts.join(" ");
}

function scoreTransitionProperties(props, weight) {
    if (!props || typeof props !== "object") return 0;
    let score = 0;
    for (const [key, value] of Object.entries(props)) {
        const keyText = String(key || "");
        const valueText = String(value || "");
        if (containsTransitionKeyword(keyText) || containsTransitionKeyword(valueText)) {
            score = Math.max(score, weight);
        }
        if (/transition|dissolve|fade|wipe/i.test(keyText) && valueText && valueText !== "0" && valueText.toLowerCase() !== "false") {
            score = Math.max(score, weight + 0.15);
        }
    }
    return Math.min(0.6, score);
}

function containsTransitionKeyword(text) {
    const normalized = String(text || "").toLowerCase();
    if (!normalized) return false;
    return TRANSITION_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function isTransitionLikeClipData(clipData) {
    if (!clipData) return false;
    const hint = clipData.transition_hint || {};
    const metadata = clipData.transition_metadata || {};
    if (metadata.has_transition || hint.is_transition || parseFloat(hint.confidence || 0) >= 0.45) {
        return true;
    }
    return containsTransitionKeyword([
        clipData.name || "",
        clipData.track_name || "",
        clipData.media_type || "",
        clipData.file_name || "",
        clipData.file_path || "",
    ].join(" "));
}

function isDecorativeOverlayClipData(clipData) {
    if (!clipData) return false;
    const hint = clipData.graphic_overlay_hint || {};
    if (hint.is_graphic_overlay || parseFloat(hint.confidence || 0) >= 0.5) {
        return true;
    }
    const fallback = detectGraphicOverlayHint({
        clipName: clipData.name,
        trackName: clipData.track_name,
        mediaType: clipData.media_type,
        fileName: clipData.file_name,
        filePath: clipData.file_path,
        clipProps: clipData.clip_properties,
        itemProps: clipData.item_properties,
        trackIndex: clipData.track_index,
    });
    return fallback.is_graphic_overlay;
}

async function runQuickVisualAnalysis(timelineInfo, analysisClipsInfo, overlayClipsInfo, options, requestedVisualChecks, analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const wantsStackVisual = requestedVisualChecks && requestedVisualChecks.length > 0;
    const preflight = wantsStackVisual
        ? await buildStackPreflight(timelineInfo, analysisClipsInfo, options, requestedVisualChecks, analysisSession)
        : {
            mode: "metadata_only",
            duration_frames: Math.max(0, safeInt(timelineInfo.duration_frames, 0)),
            stack_clip_count: 0,
            segment_count: 0,
            suspect_intervals: [],
            suspect_interval_count: 0,
            predicted_issues: [],
            counters: {
                segments: 0,
                stack_gap: 0,
                black_source: 0,
                short_visible: 0,
                sandwich_flash: 0,
                transition_window: 0,
            },
    };
    if (preflight && preflight.cancelled) return cancelledReport();
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const plan = await buildQuickSamplePlan(timelineInfo, analysisClipsInfo, overlayClipsInfo, options, preflight, analysisSession);
    if (plan && plan.cancelled) return cancelledReport();
    if (!plan.frames.length) {
        return {
            issues: dedupeIssues(filterIssuesByTransition([].concat(preflight.predicted_issues || []), preflight.transition_intervals || [], options)),
            capture: {
                mode: "quick_visual",
                source: "none",
                sample_count: 0,
                error: "",
                plan,
                preflight,
            },
        };
    }

    const capture = await captureQuickFrameSamples(timelineInfo, plan, options, analysisSession);
    if (capture && capture.cancelled) return cancelledReport();
    const issues = dedupeIssues(filterIssuesByTransition(
        (preflight.predicted_issues || []).concat(detectQuickVisualIssues(capture.samples || [], options, requestedVisualChecks)),
        preflight.transition_intervals || [],
        options
    ));

    return {
        issues,
        capture: Object.assign({}, capture, {
            mode: "quick_visual",
            plan: {
                strategy: plan.strategy,
                requested_samples: plan.frames.length,
                duration_frames: plan.duration_frames,
                suspect_interval_count: preflight.suspect_intervals.length,
                ungraded_probe_count: plan.ungraded_probe_count || 0,
            },
            preflight,
        }),
    };
}

async function buildStackPreflight(timelineInfo, clipsInfo, options, requestedVisualChecks, analysisSession = activeAnalysisState) {
    const duration = Math.max(0, safeInt(timelineInfo.duration_frames, 0));
    const contextFrames = Math.max(1, safeInt(options.quick_stack_context_frames, 4));
    const maxFlashFrames = Math.max(
        1,
        Math.max(safeInt(options.flash_min_frames, 3), safeInt(options.micro_clip_max_frames, 3))
    );
    const wantsBlack = requestedVisualChecks.includes("black_frame") || requestedVisualChecks.includes("black_screen");
    const wantsFlash = requestedVisualChecks.includes("flash_frame");
    const stackClips = [];
    const sourceClips = clipsInfo || [];
    for (let idx = 0; idx < sourceClips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const sourceClip = sourceClips[idx];
        if (shouldIgnoreQuickAnalysisClip(sourceClip, options)) continue;
        const normalized = normalizeStackClip(sourceClip, duration);
        if (normalized) stackClips.push(normalized);
    }
    const boundaries = new Set([0, duration]);
    const suspectIntervals = [];
    const predictedIssues = [];

    for (let idx = 0; idx < stackClips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const clip = stackClips[idx];
        boundaries.add(clip.start);
        boundaries.add(clip.end);
    }

    const sortedBoundaries = Array.from(boundaries)
        .filter((frame) => frame >= 0 && frame <= duration)
        .sort((a, b) => a - b);
    const rawSegments = [];
    for (let idx = 0; idx < sortedBoundaries.length - 1; idx += 1) {
        if (idx > 0 && idx % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const start = sortedBoundaries[idx];
        const end = sortedBoundaries[idx + 1];
        if (end <= start) continue;
        const visibleClip = resolveTopFullFrameClip(stackClips, start, end);
        rawSegments.push({
            start,
            end,
            duration: end - start,
            visible_clip: visibleClip,
            visible_key: visibleClip ? visibleClip.signature : "gap",
            state: visibleClip ? "covered" : "gap",
        });
    }

    const segments = mergeStackSegments(rawSegments);
    const counters = {
        segments: segments.length,
        stack_gap: 0,
        black_source: 0,
        short_visible: 0,
        sandwich_flash: 0,
        transition_window: 0,
        transition_window_sampled: 0,
    };

    for (let index = 0; index < segments.length; index += 1) {
        if (index > 0 && index % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const segment = segments[index];
        if (!segment.visible_clip) {
            counters.stack_gap += 1;
            if (wantsBlack) {
                const issueType = segment.duration >= safeInt(options.black_screen_min_frames, 8) ? "black_screen" : "black_frame";
                predictedIssues.push({
                    type: issueType,
                    frame: segment.start,
                    duration_frames: segment.duration,
                    severity: "error",
                    note: `堆叠预判: ${segment.duration} 帧没有可见主画面，疑似输出为黑`,
                    detection_mode: "stack_preflight",
                    reason: "stack_gap",
                });
                suspectIntervals.push(makeSuspectInterval(segment.start, segment.end, contextFrames, duration, {
                    reason: "stack_gap",
                    interval_type: "gap",
                    predicted_issue_type: issueType,
                    confidence: 0.95,
                    exact: true,
                }));
            }
            continue;
        }

        const clip = segment.visible_clip;
        if (wantsBlack && clip.maybe_black_source) {
            counters.black_source += 1;
            const issueType = segment.duration >= safeInt(options.black_screen_min_frames, 8) ? "black_screen" : "black_frame";
            predictedIssues.push({
                type: issueType,
                frame: segment.start,
                duration_frames: segment.duration,
                severity: "error",
                note: `堆叠预判: 可见片段看起来像黑源，持续 ${segment.duration} 帧`,
                confidence: 0.82,
                detection_mode: "stack_preflight",
                reason: "black_like_source",
            });
            suspectIntervals.push(makeSuspectInterval(segment.start, segment.end, contextFrames, duration, {
                reason: "black_like_source",
                interval_type: "black_source",
                predicted_issue_type: issueType,
                clip_name: clip.name,
                track_index: clip.track_index,
                confidence: 0.75,
                exact: true,
            }));
        }

        if (wantsFlash && segment.duration <= maxFlashFrames) {
            const prev = previousCoveredSegment(segments, index);
            const next = nextCoveredSegment(segments, index);
            const sandwiched = prev && next && prev.visible_key === next.visible_key && prev.visible_key !== segment.visible_key;
            counters.short_visible += 1;
            if (sandwiched) counters.sandwich_flash += 1;
            predictedIssues.push({
                type: "flash_frame",
                frame: segment.start,
                duration_frames: segment.duration,
                severity: "warning",
                note: sandwiched
                    ? `堆叠预判: ${segment.duration} 帧短片段夹在相同画面之间，疑似夹帧`
                    : `堆叠预判: 可见片段仅 ${segment.duration} 帧，疑似夹帧/残片`,
                confidence: sandwiched ? 0.9 : 0.68,
                detection_mode: "stack_preflight",
                reason: sandwiched ? "sandwiched_short_segment" : "short_visible_segment",
                clip_name: clip.name,
                track_index: clip.track_index,
            });
            suspectIntervals.push(makeSuspectInterval(segment.start, segment.end, contextFrames, duration, {
                reason: sandwiched ? "sandwiched_short_segment" : "short_visible_segment",
                interval_type: "flash_candidate",
                predicted_issue_type: "flash_frame",
                clip_name: clip.name,
                track_index: clip.track_index,
                confidence: sandwiched ? 0.9 : 0.68,
                exact: true,
            }));
        }

        if ((clip.has_fusion || clip.is_partial_or_blended) && (wantsBlack || wantsFlash)) {
            suspectIntervals.push(makeSuspectInterval(segment.start, segment.end, contextFrames, duration, {
                reason: clip.has_fusion ? "fusion_or_compound_clip" : "partial_or_blended_clip",
                interval_type: "risky_stack_clip",
                predicted_issue_type: wantsBlack ? "black_frame" : "flash_frame",
                clip_name: clip.name,
                track_index: clip.track_index,
                confidence: 0.5,
                exact: segment.duration <= Math.max(12, maxFlashFrames * 2),
            }));
        }
    }

    if (wantsFlash) {
        for (let idx = 0; idx < stackClips.length; idx += 1) {
            if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const clip = stackClips[idx];
            if (!clipCanProvidePrimaryCoverage(clip)) continue;
            if (clip.is_transition_like) continue;
            if (clip.duration > maxFlashFrames) continue;
            predictedIssues.push({
                type: "flash_frame",
                frame: clip.start,
                duration_frames: clip.duration,
                severity: "warning",
                note: `时间线预检: ${clip.duration} 帧短片段，疑似夹帧/残片`,
                confidence: 0.72,
                detection_mode: "timeline_structure",
                reason: "legacy_short_clip",
                clip_name: clip.name,
                track_index: clip.track_index,
            });
            suspectIntervals.push(makeSuspectInterval(clip.start, clip.end, contextFrames, duration, {
                reason: "legacy_short_clip",
                interval_type: "flash_candidate",
                predicted_issue_type: "flash_frame",
                clip_name: clip.name,
                track_index: clip.track_index,
                confidence: 0.72,
                exact: true,
            }));
        }
    }

    const transitionProtection = await buildTransitionProtection(stackClips, segments, duration, options, contextFrames, wantsBlack, wantsFlash, analysisSession);
    if (transitionProtection.cancelled) return cancelledReport();
    counters.transition_window = transitionProtection.candidate_count;
    const selectedTransitions = selectEvenly(
        transitionProtection.intervals,
        Math.max(0, safeInt(options.quick_transition_probe_limit, 160))
    );
    counters.transition_window_sampled = selectedTransitions.length;
    suspectIntervals.push(...selectedTransitions);

    const mergedIntervals = mergeSuspectIntervals(suspectIntervals);
    return {
        mode: "stack_preflight",
        duration_frames: duration,
        stack_clip_count: stackClips.length,
        segment_count: segments.length,
        suspect_intervals: mergedIntervals,
        suspect_interval_count: mergedIntervals.length,
        predicted_issues: predictedIssues,
        counters,
        transition_intervals: transitionProtection.intervals,
        transition_summary: transitionProtection.summary,
    };
}

async function buildTimelineTransitionProtection(timelineInfo, clipsInfo, options, analysisSession = activeAnalysisState) {
    const duration = Math.max(0, safeInt(timelineInfo && timelineInfo.duration_frames, 0));
    const stackClips = [];
    const sourceClips = clipsInfo || [];
    for (let idx = 0; idx < sourceClips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const sourceClip = sourceClips[idx];
        if (shouldIgnoreQuickAnalysisClip(sourceClip, options)) continue;
        const normalized = normalizeStackClip(sourceClip, duration);
        if (normalized) stackClips.push(normalized);
    }
    if (!duration || !stackClips.length) {
        return emptyTransitionProtection();
    }

    const boundaries = new Set([0, duration]);
    for (let idx = 0; idx < stackClips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const clip = stackClips[idx];
        boundaries.add(clip.start);
        boundaries.add(clip.end);
    }

    const sortedBoundaries = Array.from(boundaries)
        .filter((frame) => frame >= 0 && frame <= duration)
        .sort((a, b) => a - b);
    const rawSegments = [];
    for (let idx = 0; idx < sortedBoundaries.length - 1; idx += 1) {
        if (idx > 0 && idx % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const start = sortedBoundaries[idx];
        const end = sortedBoundaries[idx + 1];
        if (end <= start) continue;
        const visibleClip = resolveTopFullFrameClip(stackClips, start, end);
        rawSegments.push({
            start,
            end,
            duration: end - start,
            visible_clip: visibleClip,
            visible_key: visibleClip ? visibleClip.signature : "gap",
            state: visibleClip ? "covered" : "gap",
        });
    }

    return buildTransitionProtection(
        stackClips,
        mergeStackSegments(rawSegments),
        duration,
        options || {},
        Math.max(1, safeInt(options && options.transition_ignore_radius_frames, 8)),
        true,
        true,
        analysisSession
    );
}

async function buildTransitionProtection(stackClips, segments, duration, options, contextFrames, wantsBlack, wantsFlash, analysisSession = activeAnalysisState) {
    const intervals = [];
    const radius = Math.max(1, safeInt(options && options.transition_ignore_radius_frames, contextFrames || 8));
    const maxTransitionClipFrames = Math.max(2, safeInt(options && options.transition_clip_max_frames, 36));
    let candidateCount = 0;

    if (!duration || !Array.isArray(segments) || !segments.length) {
        return emptyTransitionProtection();
    }

    for (let idx = 0; idx < segments.length; idx += 1) {
        if (idx > 0 && idx % 160 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const segment = segments[idx];
        const clip = segment.visible_clip;
        if (!clip || !clip.is_transition_like) continue;
        const confidence = Math.max(0.72, safeNumber(clip.transition_confidence, 0.72));
        candidateCount += 1;
        intervals.push(makeSuspectInterval(segment.start, segment.end, radius, duration, {
            reason: "transition_clip",
            interval_type: "transition",
            predicted_issue_type: wantsFlash ? "flash_frame" : (wantsBlack ? "black_frame" : "transition"),
            confidence,
            exact: segment.duration <= maxTransitionClipFrames,
        }));
    }

    for (let idx = 1; idx < segments.length; idx += 1) {
        if (idx > 0 && idx % 160 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const left = segments[idx - 1];
        const right = segments[idx];
        if (!left.visible_clip || !right.visible_clip) continue;
        if (left.visible_key === right.visible_key) continue;

        const boundary = right.start;
        const confidence = transitionBoundaryConfidence(left, right, stackClips, boundary, radius);
        if (confidence < 0.55) continue;

        const boundaryRadius = confidence >= 0.8 ? Math.max(radius, Math.min(18, radius * 2)) : radius;
        candidateCount += 1;
        intervals.push(makeSuspectInterval(boundary, boundary + 1, boundaryRadius, duration, {
            reason: "transition_boundary",
            interval_type: "transition",
            predicted_issue_type: wantsFlash ? "flash_frame" : (wantsBlack ? "black_frame" : "transition"),
            confidence,
            exact: false,
        }));
    }

    const merged = mergeSuspectIntervals(intervals);
    return {
        intervals: merged,
        candidate_count: candidateCount,
        summary: {
            enabled: true,
            candidate_count: candidateCount,
            protected_interval_count: merged.length,
            radius_frames: radius,
        },
    };
}

function emptyTransitionProtection() {
    return {
        intervals: [],
        candidate_count: 0,
        summary: {
            enabled: true,
            candidate_count: 0,
            protected_interval_count: 0,
            radius_frames: 0,
        },
    };
}

function transitionBoundaryConfidence(left, right, stackClips, boundary, radius) {
    const leftClip = left && left.visible_clip;
    const rightClip = right && right.visible_clip;
    if (!leftClip || !rightClip) return 0;

    let score = 0.12;
    if (leftClip.is_transition_like || rightClip.is_transition_like) score += 0.7;
    if (leftClip.is_partial_or_blended || rightClip.is_partial_or_blended) score += 0.28;
    if (leftClip.has_fusion || rightClip.has_fusion) score += 0.2;
    if (hasPrimaryClipOverlapAroundBoundary(stackClips, boundary, radius)) score += 0.35;
    if (Math.min(left.duration || 0, right.duration || 0) <= Math.max(2, radius)) score += 0.12;

    return Math.min(1, score);
}

function hasPrimaryClipOverlapAroundBoundary(stackClips, boundary, radius) {
    const windowStart = Math.max(0, safeInt(boundary, 0) - Math.max(1, radius));
    const windowEnd = safeInt(boundary, 0) + Math.max(1, radius);
    let firstSignature = "";
    for (const clip of stackClips || []) {
        if (!clipCanProvidePrimaryCoverage(clip)) continue;
        if (clip.start >= windowEnd || windowStart >= clip.end) continue;
        if (!firstSignature) {
            firstSignature = clip.signature;
            continue;
        }
        if (clip.signature !== firstSignature) {
            return true;
        }
    }
    return false;
}

function selectEvenly(items, limit) {
    const source = items || [];
    if (limit <= 0) return [];
    if (source.length <= limit) return source.slice();

    const result = [];
    const seen = new Set();
    const step = source.length / limit;
    for (let idx = 0; idx < limit; idx += 1) {
        const sourceIndex = Math.min(source.length - 1, Math.floor(idx * step));
        if (seen.has(sourceIndex)) continue;
        seen.add(sourceIndex);
        result.push(source[sourceIndex]);
    }
    return result;
}

function normalizeStackClip(clip, duration) {
    if (!clip || clip.enabled === false || clip.track_enabled === false) return null;
    const start = Math.max(0, Math.min(duration, safeInt(clip.start_frame, 0)));
    const end = Math.max(start, Math.min(duration, safeInt(clip.end_frame, start)));
    if (end <= start) return null;

    const props = clip.item_properties || {};
    const opacity = Number.isFinite(parseFloat(props.opacity)) ? parseFloat(props.opacity) : 100;
    const compositeMode = Number.isFinite(parseFloat(props.composite_mode)) ? parseFloat(props.composite_mode) : 0;
    const overlay = isOverlayClip(clip);
    const blackSource = isBlackSourceClip(clip);
    const transitionLike = isTransitionLikeClipData(clip);
    const transitionHint = clip.transition_hint || {};
    const decorativeOverlay = isDecorativeOverlayClipData(clip);
    const graphicOverlayHint = clip.graphic_overlay_hint || {};
    const signature = [
        clip.media_id || "",
        clip.file_path || "",
        clip.name || "",
        clip.source_start_frame === null || clip.source_start_frame === undefined ? "" : clip.source_start_frame,
        clip.source_end_frame === null || clip.source_end_frame === undefined ? "" : clip.source_end_frame,
    ].join("|") || `${clip.name || "clip"}:${clip.track_index}:${start}:${end}`;

    return {
        original: clip,
        start,
        end,
        duration: end - start,
        track_index: safeInt(clip.track_index, 0),
        name: clip.name || "Unknown",
        track_name: clip.track_name || "",
        media_type: clip.media_type || "",
        file_path: clip.file_path || "",
        signature,
        opacity,
        composite_mode: compositeMode,
        is_overlay: overlay,
        is_decorative_overlay: decorativeOverlay,
        overlay_confidence: Number.isFinite(parseFloat(graphicOverlayHint.confidence)) ? parseFloat(graphicOverlayHint.confidence) : (decorativeOverlay ? 0.6 : 0),
        maybe_black_source: blackSource,
        has_fusion: safeInt(clip.fusion_comp_count, 0) > 0 || looksLikeFusionClip(clip),
        is_partial_or_blended: opacity < 99 || compositeMode !== 0,
        is_transition_like: transitionLike,
        transition_confidence: Number.isFinite(parseFloat(transitionHint.confidence)) ? parseFloat(transitionHint.confidence) : (transitionLike ? 0.55 : 0),
    };
}

function resolveTopFullFrameClip(stackClips, start, end) {
    let best = null;
    for (const clip of stackClips || []) {
        if (clip.start >= end || clip.end <= start) continue;
        if (!clipCanProvidePrimaryCoverage(clip)) continue;
        if (!best || clip.track_index > best.track_index) {
            best = clip;
            continue;
        }
        if (clip.track_index === best.track_index) {
            const bestSpan = best.end - best.start;
            const clipSpan = clip.end - clip.start;
            if (clipSpan > bestSpan || (clipSpan === bestSpan && clip.start > best.start)) {
                best = clip;
            }
        }
    }
    return best;
}

function clipCanProvidePrimaryCoverage(clip) {
    if (!clip || clip.opacity <= 5) return false;
    if (clip.is_decorative_overlay) return false;
    if (clip.is_overlay && !clip.maybe_black_source) return false;
    return true;
}

function mergeStackSegments(rawSegments) {
    const merged = [];
    for (const segment of rawSegments || []) {
        const last = merged[merged.length - 1];
        if (
            last &&
            last.end === segment.start &&
            last.visible_key === segment.visible_key &&
            last.state === segment.state
        ) {
            last.end = segment.end;
            last.duration = last.end - last.start;
        } else {
            merged.push(Object.assign({}, segment));
        }
    }
    return merged;
}

function previousCoveredSegment(segments, index) {
    for (let idx = index - 1; idx >= 0; idx -= 1) {
        if (segments[idx] && segments[idx].visible_clip) return segments[idx];
    }
    return null;
}

function nextCoveredSegment(segments, index) {
    for (let idx = index + 1; idx < segments.length; idx += 1) {
        if (segments[idx] && segments[idx].visible_clip) return segments[idx];
    }
    return null;
}

function makeSuspectInterval(start, end, contextFrames, duration, meta) {
    const intervalStart = Math.max(0, safeInt(start, 0) - contextFrames);
    const intervalEnd = Math.min(duration, Math.max(intervalStart + 1, safeInt(end, start + 1) + contextFrames));
    return Object.assign({
        start: intervalStart,
        end: intervalEnd,
        core_start: Math.max(0, safeInt(start, 0)),
        core_end: Math.min(duration, Math.max(safeInt(start, 0) + 1, safeInt(end, start + 1))),
    }, meta || {});
}

function mergeSuspectIntervals(intervals) {
    const sorted = (intervals || [])
        .filter((interval) => interval && interval.end > interval.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (!last || interval.start > last.end) {
            merged.push(Object.assign({}, interval, {
                reasons: [interval.reason || ""].filter(Boolean),
                predicted_issue_types: [interval.predicted_issue_type || ""].filter(Boolean),
            }));
        } else {
            last.end = Math.max(last.end, interval.end);
            last.core_start = Math.min(last.core_start, interval.core_start);
            last.core_end = Math.max(last.core_end, interval.core_end);
            if (interval.reason && !last.reasons.includes(interval.reason)) last.reasons.push(interval.reason);
            if (interval.predicted_issue_type && !last.predicted_issue_types.includes(interval.predicted_issue_type)) {
                last.predicted_issue_types.push(interval.predicted_issue_type);
            }
            last.confidence = Math.max(last.confidence || 0, interval.confidence || 0);
            last.exact = !!last.exact || !!interval.exact;
        }
    }
    return merged;
}

function isBlackSourceClip(clip) {
    const text = [
        clip.name || "",
        clip.track_name || "",
        clip.media_type || "",
        clip.file_name || "",
        clip.file_path || "",
    ].join(" ").toLowerCase();
    return [
        "black",
        "blank",
        "solid color",
        "solidcolor",
        "color generator",
        "黑",
        "黑场",
        "黑帧",
        "纯黑",
    ].some((keyword) => text.includes(keyword));
}

function looksLikeFusionClip(clip) {
    const text = [
        clip.name || "",
        clip.track_name || "",
        clip.media_type || "",
    ].join(" ").toLowerCase();
    return text.includes("fusion") || text.includes("compound") || text.includes("复合") || text.includes("融合");
}

async function buildQuickSamplePlan(timelineInfo, analysisClipsInfo, overlayClipsInfo, options, preflight, analysisSession = activeAnalysisState) {
    const duration = Math.max(0, safeInt(timelineInfo.duration_frames, 0));
    const fullScanMax = Math.max(1, safeInt(options.quick_full_scan_max_frames, 360));
    const forceFullScan = !!(options && (options.quick_force_full_scan || options.precise_direct_full_scan));
    const maxSamples = forceFullScan ? Number.MAX_SAFE_INTEGER : Math.max(fullScanMax, safeInt(options.quick_max_samples, 420));
    const suspectFullScanMax = Math.max(1, safeInt(options.quick_suspect_full_scan_max_frames, 90));
    const exactClipMax = Math.max(1, safeInt(options.quick_exact_clip_max_frames, 60));
    const exactGapMax = Math.max(1, safeInt(options.quick_exact_gap_max_frames, 240));
    const fallbackClipLimit = Math.max(1, safeInt(options.quick_fallback_clip_limit, 16));
    const rawUngradedProbeLimit = safeInt(options.quick_ungraded_max_clips, 0);
    const ungradedProbeLimit = rawUngradedProbeLimit <= 0 ? Number.POSITIVE_INFINITY : Math.max(1, rawUngradedProbeLimit);
    const overexposureProbeLimit = Math.max(1, safeInt(options.quick_overexposure_max_clips, 24));
    const stride = Math.max(1, safeInt(options.quick_stride_frames, 10));
    const edgeWindow = Math.max(1, safeInt(options.quick_edge_window_frames, 4));
    const frames = new Set();
    const metaByFrame = {};
    let strategy = "stack_preflight";
    const suspectIntervals = preflight && Array.isArray(preflight.suspect_intervals) ? preflight.suspect_intervals : [];
    const wantsOverexposure = !!(options && Array.isArray(options.check_types) && options.check_types.includes("overexposure"));
    const wantsStackVisual = !!(options && Array.isArray(options.check_types) && options.check_types.some((type) => ["black_frame", "black_screen", "flash_frame", "overexposure"].includes(type)));
    const primaryIntervals = wantsStackVisual ? await buildPrimaryVideoIntervals(analysisClipsInfo, duration, analysisSession) : [];
    if (primaryIntervals.cancelled) return cancelledReport();
    const decorativeOverlayIntervals = await buildDecorativeOverlayIntervals(overlayClipsInfo || analysisClipsInfo, duration, analysisSession);
    if (decorativeOverlayIntervals.cancelled) return cancelledReport();
    let ungradedProbeCount = 0;
    let overexposureProbeCount = 0;

    function addFrame(frame, meta) {
        const value = safeInt(frame, -1);
        if (value < 0 || value >= duration) return;
        const adjustedMeta = applyDecorativeOverlayCoverage(value, meta, decorativeOverlayIntervals);
        frames.add(value);
        if (adjustedMeta && shouldReplaceSampleMeta(metaByFrame[value], adjustedMeta)) {
            metaByFrame[value] = adjustedMeta;
        }
    }

    function addRange(start, end, meta) {
        const rangeStart = Math.max(0, safeInt(start, 0));
        const rangeEnd = Math.min(duration, safeInt(end, rangeStart));
        for (let frame = rangeStart; frame < rangeEnd; frame += 1) {
            addFrame(frame, meta);
        }
    }

    if (wantsStackVisual && forceFullScan) {
        const mergedCoverage = mergeIntervals(primaryIntervals);
        const gapIntervals = buildGapsFromMergedIntervals(mergedCoverage, duration);
        const fullScanIntervals = primaryIntervals.map((interval) => Object.assign({}, interval, { interval_type: "timeline_full_scan" }))
            .concat(gapIntervals.map((interval) => Object.assign({}, interval, { interval_type: "gap" })));
        for (let idx = 0; idx < fullScanIntervals.length; idx += 1) {
            if (idx > 0 && idx % 80 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const interval = fullScanIntervals[idx];
            addRange(interval.start, interval.end, {
                interval_id: `forced_full_${idx}_${interval.start}_${interval.end}`,
                interval_type: interval.interval_type || "timeline_full_scan",
                interval_start: interval.start,
                interval_end: interval.end,
                full_scan: true,
                suspect: true,
                capture_mode: "still_first",
            });
        }
        strategy = "forced_full_scan";
    } else if (wantsStackVisual && suspectIntervals.length > 0) {
        for (let idx = 0; idx < suspectIntervals.length; idx += 1) {
            if (idx > 0 && idx % 80 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const interval = suspectIntervals[idx];
            const intervalStart = Math.max(0, safeInt(interval.start, 0));
            const intervalEnd = Math.min(duration, Math.max(intervalStart + 1, safeInt(interval.end, intervalStart + 1)));
            const intervalDuration = intervalEnd - intervalStart;
            const intervalType = interval.interval_type || "suspect";
            const meta = {
                interval_id: `suspect_${idx}_${intervalStart}_${intervalEnd}`,
                interval_type: intervalType,
                interval_start: intervalStart,
                interval_end: intervalEnd,
                core_start: safeInt(interval.core_start, intervalStart),
                core_end: safeInt(interval.core_end, intervalEnd),
                reason: interval.reason || "",
                prediction: interval.predicted_issue_type || (interval.predicted_issue_types || []).join(","),
                confidence: interval.confidence || 0,
                suspect: true,
                full_scan: intervalType === "transition"
                    ? false
                    : (
                        intervalDuration <= suspectFullScanMax ||
                        (interval.exact &&
                            intervalDuration <= (intervalType === "gap" ? exactGapMax : exactClipMax))
                    ),
                capture_mode: "still_first",
            };

            if (intervalType === "transition") {
                addTransitionProbeFrames(intervalStart, intervalEnd, meta, addFrame);
            } else if (meta.full_scan) {
                addRange(intervalStart, intervalEnd, meta);
            } else {
                addIntervalProbeFrames(intervalStart, intervalEnd, stride, edgeWindow, meta, addFrame);
            }
        }
        strategy = "stack_suspects";
    } else if (wantsStackVisual && duration <= fullScanMax) {
        const mergedCoverage = mergeIntervals(primaryIntervals);
        const gapIntervals = buildGapsFromMergedIntervals(mergedCoverage, duration);
        const fullScanIntervals = primaryIntervals.map((interval) => Object.assign({}, interval, { interval_type: "timeline_full_scan" }))
            .concat(gapIntervals.map((interval) => Object.assign({}, interval, { interval_type: "gap" })));
        for (let idx = 0; idx < fullScanIntervals.length; idx += 1) {
            if (idx > 0 && idx % 80 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const interval = fullScanIntervals[idx];
            addRange(interval.start, interval.end, {
                interval_id: `timeline_full_${idx}_${interval.start}_${interval.end}`,
                interval_type: interval.interval_type || "timeline_full_scan",
                interval_start: interval.start,
                interval_end: interval.end,
                full_scan: true,
                suspect: true,
                capture_mode: "still_first",
            });
        }
        strategy = "timeline_full_scan";
    } else if (wantsStackVisual) {
        const sparseFrames = new Set();
        [0, Math.floor(duration / 2), duration - 1].forEach((frame) => sparseFrames.add(frame));
        const byQuarter = [0.1, 0.25, 0.5, 0.75, 0.9].map((ratio) => Math.floor(duration * ratio));
        byQuarter.forEach((frame) => sparseFrames.add(frame));
        const selectedFallbackClips = primaryIntervals.length
            ? primaryIntervals.filter((_, idx) => idx % Math.max(1, Math.ceil(primaryIntervals.length / fallbackClipLimit)) === 0)
            : [];
        if (primaryIntervals.length && selectedFallbackClips.length) {
            const lastPrimary = primaryIntervals[primaryIntervals.length - 1];
            const lastSelected = selectedFallbackClips[selectedFallbackClips.length - 1];
            if (lastSelected.start !== lastPrimary.start || lastSelected.end !== lastPrimary.end) {
                selectedFallbackClips.push(lastPrimary);
            }
        }

        for (let idx = 0; idx < selectedFallbackClips.length; idx += 1) {
            if (idx > 0 && idx % 80 === 0 && !(await yieldToEventLoop(analysisSession))) {
                return cancelledReport();
            }
            const clip = selectedFallbackClips[idx];
            addIntervalProbeFrames(clip.start, clip.end, Math.max(1, Math.floor((clip.end - clip.start) / 4) || stride), edgeWindow, {
                interval_id: `fallback_${idx}_${clip.start}_${clip.end}`,
                interval_type: "fallback_clip",
                interval_start: clip.start,
                interval_end: clip.end,
                clip_name: clip.clip_name || "",
                track_index: safeInt(clip.track_index, 0),
                suspect: true,
                full_scan: false,
                capture_mode: "still_first",
            }, addFrame);
        }

        for (const frame of sparseFrames) {
            addFrame(frame, {
                interval_id: "timeline_sparse",
                interval_type: "timeline",
                interval_start: 0,
                interval_end: duration,
                full_scan: false,
                suspect: false,
                capture_mode: "still_first",
            });
        }
        strategy = "sparse_fallback";
    } else {
        strategy = "metadata_probes";
    }

    if (options && Array.isArray(options.check_types) && options.check_types.includes("ungraded")) {
        const ungradedProbeFrames = await buildUngradedProbeFrames(analysisClipsInfo, duration, options, ungradedProbeLimit, decorativeOverlayIntervals, analysisSession);
        if (ungradedProbeFrames.cancelled) return cancelledReport();
        ungradedProbeCount = ungradedProbeFrames.length;
        ungradedProbeFrames.forEach(({ frame, meta }) => addFrame(frame, meta));
        if (ungradedProbeCount) {
            strategy += "_ungraded";
        }
    }

    if (wantsOverexposure) {
        const overexposureProbeFrames = await buildOverexposureProbeFrames(analysisClipsInfo, duration, options, overexposureProbeLimit, decorativeOverlayIntervals, analysisSession);
        if (overexposureProbeFrames.cancelled) return cancelledReport();
        overexposureProbeCount = overexposureProbeFrames.length;
        overexposureProbeFrames.forEach(({ frame, meta }) => addFrame(frame, meta));
        if (overexposureProbeCount) {
            strategy += "_exposure";
        }
    }

    let sorted = Array.from(frames).sort((a, b) => a - b);
    if (sorted.length > maxSamples) {
        sorted = capSampleFrames(sorted, maxSamples, metaByFrame);
        strategy += "_capped";
    }

    return {
        frames: sorted,
        meta_by_frame: metaByFrame,
        strategy,
        duration_frames: duration,
        suspect_interval_count: suspectIntervals.length,
        ungraded_probe_count: ungradedProbeCount,
        overexposure_probe_count: overexposureProbeCount,
    };
}

function addSparseRange(start, end, stride, edgeWindow, buildMeta, addFrame) {
    addIntervalProbeFrames(start, end, stride, edgeWindow, null, (frame) => addFrame(frame, buildMeta(frame)));
}

function shouldReplaceSampleMeta(existing, incoming) {
    if (!incoming) return false;
    if (!existing) return true;

    const existingType = existing.interval_type || "";
    const incomingType = incoming.interval_type || "";
    const genericTypes = new Set(["", "timeline", "timeline_sparse", "timeline_full_scan", "fallback_clip", "boundary"]);
    const highPriorityTypes = new Set(["gap", "black_source", "flash_candidate", "transition", "risky_stack_clip", "exposure_probe"]);

    if (incomingType === "ungraded_probe") {
        return genericTypes.has(existingType);
    }
    if (highPriorityTypes.has(incomingType)) {
        return !highPriorityTypes.has(existingType);
    }
    return genericTypes.has(existingType) && !genericTypes.has(incomingType);
}

function addIntervalProbeFrames(start, end, stride, edgeWindow, meta, addFrame) {
    const intervalStart = Math.max(0, safeInt(start, 0));
    const intervalEnd = Math.max(intervalStart, safeInt(end, intervalStart));
    const duration = intervalEnd - intervalStart;
    if (duration <= 0) return;

    if (meta && meta.full_scan) {
        for (let frame = intervalStart; frame < intervalEnd; frame += 1) {
            addFrame(frame, meta);
        }
        return;
    }

    if (duration <= Math.max(24, edgeWindow * 2 + 8)) {
        for (let frame = intervalStart; frame < intervalEnd; frame += 1) {
            addFrame(frame, meta);
        }
        return;
    }

    const probes = new Set();
    for (let offset = 0; offset < Math.min(edgeWindow, duration); offset += 1) {
        probes.add(intervalStart + offset);
        probes.add(intervalEnd - 1 - offset);
    }

    [0.1, 0.25, 0.5, 0.75, 0.9].forEach((ratio) => {
        probes.add(intervalStart + Math.min(duration - 1, Math.max(0, Math.floor(duration * ratio))));
    });

    const sampleStep = Math.max(1, Math.min(stride, Math.floor(duration / 12) || stride));
    for (let frame = intervalStart; frame < intervalEnd; frame += sampleStep) {
        probes.add(frame);
        if (probes.size >= 15) break;
    }

    Array.from(probes)
        .filter((frame) => frame >= intervalStart && frame < intervalEnd)
        .sort((a, b) => a - b)
        .forEach((frame) => addFrame(frame, meta));
}

function addTransitionProbeFrames(start, end, meta, addFrame) {
    const intervalStart = Math.max(0, safeInt(start, 0));
    const intervalEnd = Math.max(intervalStart + 1, safeInt(end, intervalStart + 1));
    const frames = new Set([
        intervalStart,
        Math.min(intervalEnd - 1, intervalStart + 1),
        Math.max(intervalStart, Math.floor((intervalStart + intervalEnd - 1) / 2)),
        Math.max(intervalStart, intervalEnd - 2),
        intervalEnd - 1,
    ]);
    Array.from(frames)
        .filter((frame) => frame >= intervalStart && frame < intervalEnd)
        .sort((a, b) => a - b)
        .forEach((frame) => addFrame(frame, meta));
}

async function buildTopVisibleMainClips(clipsInfo, duration, analysisSession = activeAnalysisState) {
    const clips = [];
    const sourceClips = clipsInfo || [];
    for (let idx = 0; idx < sourceClips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const normalized = normalizeVisibleMainClip(sourceClips[idx], duration);
        if (normalized) clips.push(normalized);
    }
    if (!clips.length) {
        return [];
    }

    const boundaries = new Set([0, duration]);
    for (let idx = 0; idx < clips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const clip = clips[idx];
        boundaries.add(clip.start);
        boundaries.add(clip.end);
    }

    const sortedBoundaries = Array.from(boundaries)
        .filter((frame) => frame >= 0 && frame <= duration)
        .sort((a, b) => a - b);
    const segments = [];

    for (let idx = 0; idx < sortedBoundaries.length - 1; idx += 1) {
        if (idx > 0 && idx % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const start = sortedBoundaries[idx];
        const end = sortedBoundaries[idx + 1];
        if (end <= start) continue;

        const visibleClip = resolveTopVisibleMainClip(clips, start, end);
        if (!visibleClip) continue;

        segments.push({
            start,
            end,
            duration: end - start,
            signature: visibleClip.signature,
            clip: visibleClip.clip,
        });
    }

    return segments;
}

function normalizeVisibleMainClip(clip, duration) {
    if (!clip || clip.enabled === false || clip.track_enabled === false) return null;
    if (isOverlayClip(clip)) return null;

    const start = Math.max(0, Math.min(duration, safeInt(clip.start_frame, 0)));
    const end = Math.max(start, Math.min(duration, safeInt(clip.end_frame, start)));
    if (end <= start) return null;

    return {
        start,
        end,
        track_index: safeInt(clip.track_index, 0),
        signature: [
            clip.media_id || "",
            clip.file_path || "",
            clip.name || "",
            clip.source_start_frame === null || clip.source_start_frame === undefined ? "" : clip.source_start_frame,
            clip.source_end_frame === null || clip.source_end_frame === undefined ? "" : clip.source_end_frame,
            clip.track_index || 0,
        ].join("|"),
        clip,
    };
}

function resolveTopVisibleMainClip(clips, start, end) {
    let best = null;
    for (const item of clips) {
        if (item.start >= end || item.end <= start) continue;
        if (!best || item.track_index > best.track_index) {
            best = item;
            continue;
        }
        if (best && item.track_index === best.track_index) {
            const bestSpan = best.end - best.start;
            const itemSpan = item.end - item.start;
            if (itemSpan > bestSpan || (itemSpan === bestSpan && item.start > best.start)) {
                best = item;
            }
        }
    }

    return best;
}

async function buildUngradedProbeFrames(clipsInfo, duration, options, limit, overlayIntervals, analysisSession = activeAnalysisState) {
    const minClipFrames = Math.max(1, safeInt(options.ungraded_min_clip_frames, 8));
    const candidates = [];
    const visibleSegments = await buildTopVisibleMainClips(clipsInfo, duration, analysisSession);
    if (visibleSegments.cancelled) return cancelledReport();

    for (let idx = 0; idx < visibleSegments.length; idx += 1) {
        if (idx > 0 && idx % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const segment = visibleSegments[idx];
        const clip = segment.clip;
        const start = segment.start;
        const end = segment.end;
        const clipDuration = end - start;
        if (clipDuration < minClipFrames) continue;

        const gradeStatus = clip.grade_status || {};
        const gradeScore = gradeStatus.strong_grade_signal ? 0 : (gradeStatus.has_grade_signal ? 2 : 4);
        const score = gradeScore + Math.min(4, Math.floor(clipDuration / 90));
        candidates.push({
            score,
            start,
            end,
            duration: clipDuration,
            clip,
            gradeStatus,
        });
    }

    candidates.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.duration !== b.duration) return b.duration - a.duration;
        return a.start - b.start || safeInt(a.clip.track_index, 0) - safeInt(b.clip.track_index, 0);
    });

    const selected = !Number.isFinite(limit) || limit <= 0 ? candidates : candidates.slice(0, limit);
    const results = [];
    selected.forEach((candidate, idx) => {
        const start = candidate.start;
        const end = candidate.end;
        const clipDuration = Math.max(1, candidate.duration);
        const probeFrames = [];

        if (clipDuration <= 12) {
            for (let frame = start; frame < end; frame += 1) {
                probeFrames.push(frame);
            }
        } else if (clipDuration <= 48) {
            [
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.35),
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.5),
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.65),
            ].forEach((frame) => {
                if (!probeFrames.includes(frame)) probeFrames.push(frame);
            });
        } else {
            [
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.22),
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.5),
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.82),
            ].forEach((frame) => {
                if (!probeFrames.includes(frame)) probeFrames.push(frame);
            });
        }

        probeFrames.forEach((probeFrame) => {
            results.push({
                frame: probeFrame,
                meta: {
                    interval_id: `ungraded_${idx}_${start}_${end}`,
                    interval_type: "ungraded_probe",
                    interval_start: start,
                    interval_end: end,
                    core_start: probeFrame,
                    core_end: Math.min(end, probeFrame + 1),
                    clip_key: buildTimelineSegmentKey(candidate.clip, start, end),
                    clip_name: candidate.clip.name || "",
                    track_index: safeInt(candidate.clip.track_index, 0),
                    track_name: candidate.clip.track_name || "",
                    duration_frames: candidate.duration,
                    grade_status: candidate.gradeStatus,
                    capture_mode: "still_first",
                    suspect: !candidate.gradeStatus.strong_grade_signal,
                    full_scan: clipDuration <= 12,
                    probe_kind: "ungraded",
                },
            });
        });
    });

    return results;
}

async function buildOverexposureProbeFrames(clipsInfo, duration, options, limit, overlayIntervals, analysisSession = activeAnalysisState) {
    const minClipFrames = Math.max(1, safeInt(options.overexposure_min_frames, 3));
    const candidates = [];
    const visibleSegments = await buildTopVisibleMainClips(clipsInfo, duration, analysisSession);
    if (visibleSegments.cancelled) return cancelledReport();

    for (let idx = 0; idx < visibleSegments.length; idx += 1) {
        if (idx > 0 && idx % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const segment = visibleSegments[idx];
        const clip = segment.clip;
        const start = segment.start;
        const end = segment.end;
        const clipDuration = end - start;
        if (clipDuration < minClipFrames) continue;

        const gradeStatus = clip.grade_status || {};
        const score = Math.floor(clipDuration / 45) + (gradeStatus.strong_grade_signal ? 0 : 2) + (gradeStatus.has_grade_signal ? 1 : 3);
        candidates.push({
            score,
            start,
            end,
            duration: clipDuration,
            clip,
            gradeStatus,
        });
    }

    candidates.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.duration !== b.duration) return b.duration - a.duration;
        return a.start - b.start || safeInt(a.clip.track_index, 0) - safeInt(b.clip.track_index, 0);
    });

    const results = [];
    candidates.slice(0, limit).forEach((candidate, idx) => {
        const start = candidate.start;
        const end = candidate.end;
        const clipDuration = Math.max(1, candidate.duration);
        const probeFrames = [];

        if (clipDuration <= 12) {
            for (let frame = start; frame < end; frame += 1) {
                probeFrames.push(frame);
            }
        } else if (clipDuration <= 48) {
            const center = selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.5);
            const offsets = [-1, 0, 1];
            offsets.forEach((offset) => {
                const frame = Math.max(start, Math.min(end - 1, center + offset));
                if (!probeFrames.includes(frame)) {
                    probeFrames.push(frame);
                }
            });
        } else {
            const probePoints = [
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.25),
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.5),
                selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, 0.9),
            ];
            probePoints.forEach((frame) => {
                if (!probeFrames.includes(frame)) {
                    probeFrames.push(frame);
                }
            });
        }

        probeFrames.forEach((frame) => {
            results.push({
                frame,
                meta: {
                    interval_id: `overexposure_${idx}_${start}_${end}`,
                    interval_type: "exposure_probe",
                    interval_start: start,
                    interval_end: end,
                    core_start: frame,
                    core_end: Math.min(end, frame + 1),
                    clip_key: candidate.clip.media_id || candidate.clip.file_path || `${candidate.clip.track_index}_${start}_${end}_${candidate.clip.name || "clip"}`,
                    clip_name: candidate.clip.name || "",
                    track_index: safeInt(candidate.clip.track_index, 0),
                    track_name: candidate.clip.track_name || "",
                    duration_frames: candidate.duration,
                    grade_status: candidate.gradeStatus,
                    capture_mode: "still_first",
                    suspect: true,
                    full_scan: clipDuration <= 12,
                    probe_kind: "overexposure",
                },
            });
        });
    });

    return results;
}

function buildTimelineSegmentKey(clip, start, end) {
    const safeClip = clip || {};
    return [
        safeInt(safeClip.track_index, 0),
        safeInt(start, 0),
        safeInt(end, safeInt(start, 0)),
        safeClip.media_id || "",
        safeClip.file_path || "",
        safeClip.name || "",
        safeClip.source_start_frame === null || safeClip.source_start_frame === undefined ? "" : safeClip.source_start_frame,
        safeClip.source_end_frame === null || safeClip.source_end_frame === undefined ? "" : safeClip.source_end_frame,
    ].join("|");
}

function selectProbeFrameAvoidingIntervals(start, end, overlayIntervals, preferredRatio = 0.5) {
    const intervalStart = safeInt(start, 0);
    const intervalEnd = Math.max(intervalStart + 1, safeInt(end, intervalStart + 1));
    const duration = intervalEnd - intervalStart;
    const preferred = Math.max(
        intervalStart,
        Math.min(intervalEnd - 1, intervalStart + Math.floor(duration * preferredRatio))
    );

    if (!isFrameInIntervals(preferred, overlayIntervals)) {
        return preferred;
    }

    const candidates = [
        intervalStart + Math.floor(duration * 0.2),
        intervalStart + Math.floor(duration * 0.35),
        intervalStart + Math.floor(duration * 0.65),
        intervalStart + Math.floor(duration * 0.8),
        intervalStart,
        intervalEnd - 1,
    ].map((frame) => Math.max(intervalStart, Math.min(intervalEnd - 1, frame)));

    for (const candidate of candidates) {
        if (!isFrameInIntervals(candidate, overlayIntervals)) {
            return candidate;
        }
    }
    return preferred;
}

function isFrameInIntervals(frame, intervals) {
    if (!intervals || !intervals.length) return false;
    return intervals.some((interval) => frame >= safeInt(interval.start, 0) && frame < safeInt(interval.end, 0));
}

function capSampleFrames(sortedFrames, maxSamples, metaByFrame) {
    if (sortedFrames.length <= maxSamples) {
        return sortedFrames;
    }

    const mandatory = new Set([sortedFrames[0], sortedFrames[sortedFrames.length - 1]]);
    for (const [frameKey, meta] of Object.entries(metaByFrame || {})) {
        if (!meta) continue;
        if (!["gap", "black_source", "flash_candidate", "transition", "risky_stack_clip", "fallback_clip", "ungraded_probe", "exposure_probe"].includes(meta.interval_type)) {
            continue;
        }
        mandatory.add(safeInt(frameKey, 0));
        mandatory.add(safeInt(meta.interval_start, 0));
        mandatory.add(Math.max(0, safeInt(meta.interval_end, 1) - 1));
    }

    const mandatoryFrames = Array.from(mandatory).filter((frame) => frame >= 0 && frame < Number.MAX_SAFE_INTEGER).sort((a, b) => a - b);
    if (mandatoryFrames.length >= maxSamples) {
        return mandatoryFrames.slice(0, maxSamples - 1).concat([sortedFrames[sortedFrames.length - 1]]).filter((frame, index, arr) => arr.indexOf(frame) === index).sort((a, b) => a - b);
    }

    const optional = sortedFrames.filter((frame) => !mandatory.has(frame));
    const result = mandatoryFrames.slice();
    const remaining = Math.max(0, maxSamples - result.length);
    if (remaining > 0 && optional.length) {
        const step = optional.length / remaining;
        for (let idx = 0; idx < remaining; idx += 1) {
            const pick = optional[Math.min(optional.length - 1, Math.floor(idx * step))];
            result.push(pick);
        }
    }

    return Array.from(new Set(result)).sort((a, b) => a - b);
}

async function buildPrimaryVideoIntervals(clipsInfo, duration, analysisSession = activeAnalysisState) {
    const intervals = [];
    const clips = clipsInfo || [];
    for (let idx = 0; idx < clips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const clip = clips[idx];
        if (!clip || clip.enabled === false || clip.track_enabled === false) continue;
        if (isOverlayClip(clip)) continue;
        const start = Math.max(0, Math.min(duration, safeInt(clip.start_frame, 0)));
        const end = Math.max(start, Math.min(duration, safeInt(clip.end_frame, start)));
        if (end <= start) continue;
        intervals.push({
            start,
            end,
            clip_name: clip.name || "",
            track_index: safeInt(clip.track_index, 0),
        });
    }
    return intervals.sort((a, b) => a.start - b.start || a.end - b.end);
}

async function buildDecorativeOverlayIntervals(clipsInfo, duration, analysisSession = activeAnalysisState) {
    const intervals = [];
    const clips = clipsInfo || [];
    for (let idx = 0; idx < clips.length; idx += 1) {
        if (idx > 0 && idx % 250 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const clip = clips[idx];
        if (!clip || clip.enabled === false || clip.track_enabled === false) continue;
        const transparentOverlay = isTransparentOverlayClipData(clip);
        if (!transparentOverlay) continue;
        const start = Math.max(0, Math.min(duration, safeInt(clip.start_frame, 0)));
        const end = Math.max(start, Math.min(duration, safeInt(clip.end_frame, start)));
        if (end <= start) continue;
        intervals.push({
            start,
            end,
            track_index: safeInt(clip.track_index, 0),
            confidence: safeNumber(clip.graphic_overlay_hint && clip.graphic_overlay_hint.confidence, 0.6),
            clip_name: clip.name || "",
        });
    }
    return mergeIntervals(intervals.sort((a, b) => a.start - b.start || a.end - b.end));
}

function applyDecorativeOverlayCoverage(frame, meta, overlayIntervals) {
    if (!overlayIntervals || !overlayIntervals.length) return meta;
    if (!overlayIntervals.some((interval) => frame >= interval.start && frame < interval.end)) {
        return meta;
    }
    const intervalType = meta && meta.interval_type ? meta.interval_type : "";
    if (intervalType === "gap" || intervalType === "black_source") {
        return meta;
    }
    return Object.assign({}, meta || {}, {
        decorative_overlay_covering: true,
        capture_mode: "still_first",
    });
}

function mergeIntervals(intervals) {
    const merged = [];
    for (const interval of intervals || []) {
        if (!merged.length || interval.start > merged[merged.length - 1].end) {
            merged.push({ start: interval.start, end: interval.end });
        } else {
            merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
        }
    }
    return merged;
}

function buildGapsFromMergedIntervals(mergedIntervals, duration) {
    const gaps = [];
    let cursor = 0;
    for (const interval of mergedIntervals || []) {
        if (interval.start > cursor) {
            gaps.push({ start: cursor, end: interval.start });
        }
        cursor = Math.max(cursor, interval.end);
    }
    if (cursor < duration) {
        gaps.push({ start: cursor, end: duration });
    }
    return gaps;
}

function isOverlayClip(clipData) {
    if (isTransitionLikeClipData(clipData)) {
        return true;
    }
    if (isTransparentOverlayClipData(clipData)) {
        return true;
    }
    if (isDecorativeOverlayClipData(clipData)) {
        return true;
    }
    const ext = path.extname(String(clipData.file_path || clipData.file_name || "").toLowerCase());
    const videoLike = OVERLAY_VIDEO_EXTENSIONS.has(ext) || isVideoSource(clipData.media_type, clipData.clip_properties);
    if (videoLike) {
        return false;
    }
    const text = [
        clipData.name || "",
        clipData.track_name || "",
        clipData.media_type || "",
        clipData.file_name || "",
        clipData.file_path || "",
    ].join(" ").toLowerCase();
    return [
        "title",
        "text",
        "caption",
        "subtitle",
        "字幕",
        "标题",
        "花字",
        "水印",
        "logo",
        "adjustment",
        "调整片段",
        "调节片段",
        "compound",
        "fusion",
    ].some((keyword) => text.includes(keyword));
}

async function captureQuickFrameSamples(timelineInfo, plan, options, analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const samples = [];
    const errors = [];
    const sourceCounts = {};
    const previousPage = await safeCall(() => resolveObj.GetCurrentPage(), null);
    const previousTimecode = await safeCall(() => timelineObj.GetCurrentTimecode(), null);
    const workDir = ensureWorkDir();
    const captureDir = path.join(workDir, "quick_samples");
    fs.mkdirSync(captureDir, { recursive: true });

    await safeCall(() => resolveObj.OpenPage("color"), false);
    await sleep(Math.max(0, safeInt(options.quick_page_settle_ms, 50)));

    try {
        for (let index = 0; index < plan.frames.length; index += 1) {
            if (isAnalysisCancelled(analysisSession)) {
                return { cancelled: true, samples, errors, source_counts: sourceCounts };
            }
            const frame = plan.frames[index];
            if (index > 0 && index % 8 === 0) {
                await sleep(0);
            }
            const meta = plan.meta_by_frame[String(frame)] || null;
            const syntheticFeature = syntheticFeatureForSample(frame, meta);
            if (syntheticFeature) {
                sourceCounts[syntheticFeature.source] = (sourceCounts[syntheticFeature.source] || 0) + 1;
                samples.push({
                    frame,
                    timecode: timelineFrameOffsetToTimecode(timelineInfo, frame),
                    source: syntheticFeature.source,
                    meta,
                    feature: syntheticFeature.feature,
                    is_black: isFeatureBlack(syntheticFeature.feature, options),
                    is_overexposed: isFeatureOverexposed(syntheticFeature.feature, options),
                });
                continue;
            }

            const timecode = timelineFrameOffsetToTimecode(timelineInfo, frame);
            const moved = await safeCall(() => timelineObj.SetCurrentTimecode(timecode), false);
            if (!moved) {
                errors.push({ frame, error: "SetCurrentTimecode failed", timecode });
                continue;
            }

            const captured = await captureCurrentFrameFeature(frame, timecode, meta, captureDir);
            if (!captured || !captured.feature) {
                errors.push({ frame, error: "No thumbnail/still available", timecode });
                continue;
            }

            sourceCounts[captured.source] = (sourceCounts[captured.source] || 0) + 1;
            samples.push({
                frame,
                timecode,
                source: captured.source,
                meta,
                feature: captured.feature,
                is_black: isFeatureBlack(captured.feature, options),
                is_overexposed: isFeatureOverexposed(captured.feature, options),
            });
        }
    } finally {
        if (previousTimecode) {
            await safeCall(() => timelineObj.SetCurrentTimecode(previousTimecode), false);
        }
        if (previousPage) {
            await safeCall(() => resolveObj.OpenPage(previousPage), false);
        }
    }

    return {
        samples,
        errors,
        source_counts: sourceCounts,
        meta_type_counts: summarizeSampleMetaTypes(samples),
        sample_count: samples.length,
        requested_sample_count: plan.frames.length,
        work_dir: workDir,
        capture_dir: captureDir,
        error: samples.length ? "" : (errors.length ? "Unable to capture any sample frames" : ""),
    };
}

function syntheticFeatureForSample(frame, meta) {
    if (!meta || meta.interval_type !== "gap") {
        return null;
    }
    if (!isFrameInsideMetaCore(frame, meta)) {
        return null;
    }
    return { source: "stack_gap", feature: makeBlackFeature() };
}

async function captureCurrentFrameFeature(frame, timecode, meta, captureDir) {
    const captureMode = meta && meta.capture_mode ? meta.capture_mode : "";
    const overlayGuard = !!(meta && meta.decorative_overlay_covering);

    if (overlayGuard) {
        const stillFeature = await featureFromExportedStill(frame, timecode, captureDir);
        if (stillFeature) {
            return { source: "still_overlay_guard", feature: stillFeature };
        }
        return null;
    }

    if (captureMode === "still_first") {
        const stillFeature = await featureFromExportedStill(frame, timecode, captureDir);
        if (stillFeature) {
            return { source: "still", feature: stillFeature };
        }
        const thumbnail = await safeCall(() => timelineObj.GetCurrentClipThumbnailImage(), null);
        const thumbnailFeature = featureFromThumbnail(thumbnail);
        if (thumbnailFeature) {
            return { source: "thumbnail", feature: thumbnailFeature };
        }
        if (meta && meta.interval_type === "gap" && isFrameInsideMetaCore(frame, meta)) {
            return { source: "gap_blank", feature: makeBlackFeature() };
        }
        return null;
    }

    const thumbnail = await safeCall(() => timelineObj.GetCurrentClipThumbnailImage(), null);
    const thumbnailFeature = featureFromThumbnail(thumbnail);
    if (thumbnailFeature) {
        return { source: "thumbnail", feature: thumbnailFeature };
    }

    if (captureMode === "thumbnail_only") {
        return null;
    }

    const stillFeature = await featureFromExportedStill(frame, timecode, captureDir);
    if (stillFeature) {
        return { source: "still", feature: stillFeature };
    }

    return null;
}

function isFrameInsideMetaCore(frame, meta) {
    if (!meta) return false;
    const value = safeInt(frame, -1);
    const coreStart = safeInt(meta.core_start, safeInt(meta.interval_start, 0));
    const coreEnd = Math.max(coreStart + 1, safeInt(meta.core_end, safeInt(meta.interval_end, coreStart + 1)));
    return value >= coreStart && value < coreEnd;
}

function summarizeSampleMetaTypes(samples) {
    const counts = {};
    for (const sample of samples || []) {
        const type = sample && sample.meta && sample.meta.interval_type ? sample.meta.interval_type : "unknown";
        counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
}

async function featureFromExportedStill(frame, _timecode, captureDir) {
    if (!projectObj || typeof projectObj.ExportCurrentFrameAsStill !== "function") {
        return null;
    }

    const filePath = path.join(captureDir, `sample_${String(frame).padStart(8, "0")}.png`);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}

    const ok = await safeCall(() => projectObj.ExportCurrentFrameAsStill(filePath), false);
    if (!ok) return null;
    const ready = await waitForFile(filePath, 1500);
    if (!ready) return null;

    try {
        const image = nativeImage.createFromPath(filePath);
        if (!image || image.isEmpty()) return null;
        const size = image.getSize();
        const bitmap = image.toBitmap();
        return featureFromPixelBuffer(bitmap, size.width, size.height, "bgra");
    } catch (_) {
        return null;
    }
}

async function waitForFile(filePath, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return true;
        } catch (_) {}
        await sleep(20);
    }
    return false;
}

function featureFromThumbnail(thumbnail) {
    if (!thumbnail || typeof thumbnail !== "object" || !thumbnail.data) {
        return null;
    }
    const width = safeInt(thumbnail.width, 0);
    const height = safeInt(thumbnail.height, 0);
    if (!width || !height) return null;

    try {
        const buffer = Buffer.from(String(thumbnail.data), "base64");
        return featureFromPixelBuffer(buffer, width, height, "rgb");
    } catch (_) {
        return null;
    }
}

function featureFromPixelBuffer(buffer, width, height, format) {
    const pixelCount = width * height;
    if (!buffer || !pixelCount) return null;
    const bytesPerPixel = Math.max(3, Math.floor(buffer.length / pixelCount));
    const gridWidth = 32;
    const gridHeight = Math.max(18, Math.min(72, Math.round(height * (gridWidth / Math.max(1, width)))));
    const gray = [];
    const contentGray = [];
    let sum = 0;
    let sumSq = 0;
    let saturationSum = 0;
    let saturationCount = 0;
    let contentSaturationSum = 0;
    let contentSaturationCount = 0;
    let brightCount = 0;
    let clippedCount = 0;

    for (let gy = 0; gy < gridHeight; gy += 1) {
        const y = Math.min(height - 1, Math.floor((gy + 0.5) * height / gridHeight));
        for (let gx = 0; gx < gridWidth; gx += 1) {
            const x = Math.min(width - 1, Math.floor((gx + 0.5) * width / gridWidth));
            const offset = (y * width + x) * bytesPerPixel;
            if (offset + 2 >= buffer.length) continue;

            let r;
            let g;
            let b;
            if (format === "bgra" && bytesPerPixel >= 4) {
                b = buffer[offset];
                g = buffer[offset + 1];
                r = buffer[offset + 2];
            } else {
                r = buffer[offset];
                g = buffer[offset + 1];
                b = buffer[offset + 2];
            }

            const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            const rn = r / 255;
            const gn = g / 255;
            const bn = b / 255;
            const maxRgb = Math.max(rn, gn, bn);
            const minRgb = Math.min(rn, gn, bn);
            const saturation = maxRgb <= 0 ? 0 : (maxRgb - minRgb) / maxRgb;
            saturationSum += saturation;
            saturationCount += 1;
            if (luma >= 235 / 255) {
                brightCount += 1;
            }
            if (luma >= 250 / 255) {
                clippedCount += 1;
            }
            gray.push(luma);
            sum += luma;
            sumSq += luma * luma;

            if (isUngradedContentGridCell(gx, gy, gridWidth, gridHeight)) {
                contentGray.push(luma);
                contentSaturationSum += saturation;
                contentSaturationCount += 1;
            }
        }
    }

    if (!gray.length) return null;

    const mean = sum / gray.length;
    const variance = Math.max(0, sumSq / gray.length - mean * mean);
    const sorted = gray.slice().sort((a, b) => a - b);
    const p05 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.05))];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))];
    const darkCutoff = 62 / 255;
    const darkCount = gray.reduce((count, value) => count + (value <= darkCutoff ? 1 : 0), 0);
    const contentStats = summarizeFeatureValues(contentGray.length ? contentGray : gray, contentSaturationSum, contentSaturationCount, saturationSum, saturationCount);

    return {
        gray,
        mean,
        luma: mean,
        std: Math.sqrt(variance),
        contrast: p95 - p05,
        saturation: saturationCount ? saturationSum / saturationCount : 0,
        content_mean: contentStats.mean,
        content_luma: contentStats.mean,
        content_contrast: contentStats.contrast,
        content_saturation: contentStats.saturation,
        p05,
        p95,
        dark_ratio: darkCount / gray.length,
        bright_ratio: brightCount / gray.length,
        clipped_ratio: clippedCount / gray.length,
        width,
        height,
    };
}

function isUngradedContentGridCell(gx, gy, gridWidth, gridHeight) {
    const xRatio = (gx + 0.5) / Math.max(1, gridWidth);
    const yRatio = (gy + 0.5) / Math.max(1, gridHeight);
    return xRatio >= 0.08 && xRatio <= 0.92 && yRatio >= 0.12 && yRatio <= 0.78;
}

function summarizeFeatureValues(values, contentSaturationSum, contentSaturationCount, fallbackSaturationSum, fallbackSaturationCount) {
    const source = values && values.length ? values : [0];
    const sorted = source.slice().sort((a, b) => a - b);
    const mean = source.reduce((sum, value) => sum + value, 0) / source.length;
    const p10 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.1))];
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.9))];
    const saturation = contentSaturationCount
        ? contentSaturationSum / contentSaturationCount
        : (fallbackSaturationCount ? fallbackSaturationSum / fallbackSaturationCount : 0);
    return {
        mean,
        contrast: p90 - p10,
        saturation,
    };
}

function makeBlackFeature() {
    const gray = new Array(32 * 57).fill(0);
    return {
        gray,
        mean: 0,
        luma: 0,
        std: 0,
        contrast: 0,
        saturation: 0,
        p05: 0,
        p95: 0,
        dark_ratio: 1,
        bright_ratio: 0,
        width: 32,
        height: 57,
    };
}

function detectQuickVisualIssues(samples, options, requestedVisualChecks) {
    if (!samples.length) return [];

    const wanted = new Set(requestedVisualChecks || []);
    const wantsUngraded = !!(options && Array.isArray(options.check_types) && options.check_types.includes("ungraded"));
    const issues = [];
    if (wanted.has("black_frame") || wanted.has("black_screen")) {
        issues.push(...detectQuickBlackIssues(samples, options, wanted));
        issues.push(...detectSparseIntervalBlackIssues(samples, options, wanted));
    }
    if (wanted.has("flash_frame")) {
        issues.push(...detectQuickFlashIssues(samples, options));
    }
    if (wanted.has("overexposure")) {
        issues.push(...detectQuickOverexposureIssues(samples, options));
    }
    if (wantsUngraded) {
        issues.push(...detectQuickUngradedIssues(samples, options));
    }

    return dedupeIssues(issues);
}

function isDecorativeOverlaySample(sample) {
    return !!(sample && sample.meta && sample.meta.decorative_overlay_covering);
}

async function detectTimelineUngradedIssues(clipsInfo, timelineInfo, options, analysisSession = activeAnalysisState) {
    const duration = Math.max(0, safeInt(timelineInfo.duration_frames, 0));
    const issues = [];
    const visibleSegments = await buildTopVisibleMainClips(clipsInfo, duration, analysisSession);
    if (visibleSegments.cancelled) return cancelledReport();
    for (let idx = 0; idx < visibleSegments.length; idx += 1) {
        if (idx > 0 && idx % 120 === 0 && !(await yieldToEventLoop(analysisSession))) {
            return cancelledReport();
        }
        const segment = visibleSegments[idx];
        const clip = segment.clip || {};
        const gradeStatus = clip.grade_status || {};
        const startFrame = Math.max(0, safeInt(segment.start, 0));
        const durationFrames = Math.max(1, safeInt(segment.duration, 1));
        const clipName = clip.name || "Unknown";
        const clipLabel = `${clipName}${clip.track_index !== undefined ? ` (V${clip.track_index})` : ""}`;

        if (gradeStatus.strong_grade_signal) {
            continue;
        }

        if (!gradeStatus.has_grade_signal) {
            issues.push({
                type: "ungraded",
                frame: startFrame,
                duration_frames: durationFrames,
                severity: "warning",
                confidence: 0.74,
                detection_mode: "timeline_metadata",
                clip_name: clipName,
                track_index: safeInt(clip.track_index, 0),
                note: `快速预检未发现调色信号: ${clipLabel}`,
            });
            continue;
        }

        issues.push({
            type: "ungraded",
            frame: startFrame,
            duration_frames: durationFrames,
            severity: "warning",
            confidence: 0.56,
            detection_mode: "timeline_metadata",
            clip_name: clipName,
            track_index: safeInt(clip.track_index, 0),
            note: `快速预检仅发现单节点/弱调色信号: ${clipLabel}`,
        });
    }
    return issues;
}

function detectQuickBlackIssues(samples, options, wanted) {
    const issues = [];
    const screenMinFrames = Math.max(1, safeInt(options.black_screen_min_frames, 8));
    const blackAnalysisSamples = (samples || []).filter(isBlackAnalysisSample);

    for (const group of splitContiguousSamples(blackAnalysisSamples)) {
        let startIndex = -1;
        for (let idx = 0; idx <= group.length; idx += 1) {
            const black = idx < group.length && group[idx].is_black;
            if (black && startIndex < 0) {
                startIndex = idx;
            }
            if ((!black || idx === group.length) && startIndex >= 0) {
                const endIndex = idx - 1;
                const duration = endIndex - startIndex + 1;
                const startFrame = group[startIndex].frame;
                const runSamples = group.slice(startIndex, endIndex + 1);
                if (runSamples.length && runSamples.every(isDecorativeOverlaySample)) {
                    startIndex = -1;
                    continue;
                }
                const exactRange = exactBlackRunRange(runSamples, startFrame, duration);
                if (!exactRange) {
                    startIndex = -1;
                    continue;
                }
                if (exactRange.duration >= screenMinFrames && wanted.has("black_screen")) {
                    issues.push(makeVisualIssue("black_screen", exactRange.start, exactRange.duration, "error", `快速抽样发现黑场持续 ${exactRange.duration} 帧`));
                } else if (wanted.has("black_frame")) {
                    issues.push(makeVisualIssue("black_frame", exactRange.start, exactRange.duration, "error", `快速抽样发现黑帧持续 ${exactRange.duration} 帧`));
                }
                startIndex = -1;
            }
        }
    }

    return issues;
}

function isBlackAnalysisSample(sample) {
    if (!sample || isDecorativeOverlaySample(sample)) return false;
    const meta = sample.meta || {};
    const intervalType = meta.interval_type || "";
    if (meta.probe_kind === "ungraded" || meta.probe_kind === "overexposure") return false;
    if (intervalType === "ungraded_probe" || intervalType === "exposure_probe" || intervalType === "transition") {
        return false;
    }
    return true;
}

function exactBlackRunRange(runSamples, fallbackStart, fallbackDuration) {
    const samples = (runSamples || []).filter((sample) => sample && Number.isFinite(sample.frame));
    if (!samples.length) {
        return null;
    }

    let start = safeInt(fallbackStart, samples[0].frame);
    let end = start + Math.max(1, safeInt(fallbackDuration, samples.length));
    const exactSamples = samples.filter((sample) => {
        const type = sample.meta && sample.meta.interval_type ? sample.meta.interval_type : "";
        return type === "gap" || type === "black_source";
    });

    if (exactSamples.length === samples.length) {
        const ids = new Set(exactSamples.map((sample) => sample.meta && sample.meta.interval_id ? sample.meta.interval_id : ""));
        if (ids.size === 1) {
            const meta = exactSamples[0].meta || {};
            const coreStart = safeInt(meta.core_start, safeInt(meta.interval_start, start));
            const coreEnd = Math.max(coreStart + 1, safeInt(meta.core_end, safeInt(meta.interval_end, end)));
            start = Math.max(start, coreStart);
            end = Math.min(end, coreEnd);
        }
    }

    if (end <= start) {
        return null;
    }
    return {
        start,
        duration: Math.max(1, end - start),
    };
}

function detectSparseIntervalBlackIssues(samples, options, wanted) {
    const issues = [];
    const screenMinFrames = Math.max(1, safeInt(options.black_screen_min_frames, 8));
    const groups = {};
    for (const sample of samples) {
        if (!isBlackAnalysisSample(sample)) continue;
        const meta = sample.meta;
        if (!meta || !meta.interval_id || meta.full_scan) continue;
        groups[meta.interval_id] = groups[meta.interval_id] || { meta, samples: [] };
        groups[meta.interval_id].samples.push(sample);
    }

    for (const item of Object.values(groups)) {
        const meta = item.meta;
        const intervalDuration = safeInt(meta.interval_end, 0) - safeInt(meta.interval_start, 0);
        if (intervalDuration <= 0 || !item.samples.length) continue;
        if (item.samples.every(isDecorativeOverlaySample)) continue;
        const blackSamples = item.samples.filter((sample) => sample.is_black);
        if (!blackSamples.length) continue;

        const isGap = meta.interval_type === "gap";
        const clipLikeTypes = new Set(["clip", "fallback_clip", "timeline", "timeline_sparse", "suspect", "risky_stack_clip"]);
        const strongClipSignal = meta.interval_type === "black_source"
            || (
                clipLikeTypes.has(meta.interval_type) &&
                item.samples.length >= 2 &&
                (
                    meta.full_scan
                        ? blackSamples.length >= 1
                        : blackSamples.length / item.samples.length >= 0.5
                )
        );
        const strongGapSignal = isGap && blackSamples.length >= 1;
        if (!strongGapSignal && !strongClipSignal) continue;

        const preciseRange = sparseIssueRange(meta, blackSamples);
        const issueStart = preciseRange[0];
        const issueDuration = Math.max(1, preciseRange[1] - preciseRange[0]);
        const exactSparseRange = isGap || meta.interval_type === "black_source" || meta.interval_type === "timeline_full_scan";
        if (exactSparseRange && issueDuration >= screenMinFrames && wanted.has("black_screen")) {
            issues.push(makeVisualIssue(
                "black_screen",
                issueStart,
                issueDuration,
                "error",
                isGap ? `时间线空白形成黑场，约 ${issueDuration} 帧` : `快速抽样发现疑似黑场，约 ${issueDuration} 帧`
            ));
        } else if (wanted.has("black_frame")) {
            issues.push(makeVisualIssue(
                "black_frame",
                issueStart,
                exactSparseRange ? issueDuration : 1,
                "error",
                isGap ? `时间线空白形成黑帧，约 ${issueDuration} 帧` : `快速抽样发现疑似黑帧，约 ${issueDuration} 帧`
            ));
        }
    }

    return issues;
}

function sparseIssueRange(meta, blackSamples) {
    const samples = (blackSamples || []).filter((sample) => sample && Number.isFinite(sample.frame)).sort((a, b) => a.frame - b.frame);
    if (!samples.length) {
        const start = safeInt(meta && meta.core_start, safeInt(meta && meta.interval_start, 0));
        const end = Math.max(start + 1, safeInt(meta && meta.core_end, safeInt(meta && meta.interval_end, start + 1)));
        return [start, end];
    }

    const intervalType = meta && meta.interval_type ? meta.interval_type : "";
    if (intervalType === "gap" || intervalType === "black_source" || intervalType === "timeline_full_scan") {
        const start = safeInt(meta.core_start, safeInt(meta.interval_start, samples[0].frame));
        const end = Math.max(start + 1, safeInt(meta.core_end, safeInt(meta.interval_end, start + 1)));
        return [start, end];
    }

    return [samples[0].frame, samples[0].frame + 1];
}

function detectQuickFlashIssues(samples, options) {
    const issues = [];
    const flashSamples = (samples || []).filter(isFlashAnalysisSample);
    const threshold = Number.isFinite(parseFloat(options.flash_threshold)) ? parseFloat(options.flash_threshold) : 0.28;
    const returnThreshold = Number.isFinite(parseFloat(options.flash_return_threshold)) ? parseFloat(options.flash_return_threshold) : 0.12;
    const minDuration = Math.max(1, safeInt(options.flash_min_frames, 3));
    const cooldownFrames = 3;

    for (const group of splitContiguousSamples(flashSamples)) {
        if (group.length < 3) continue;
        let lastHitEnd = -1;

        for (let idx = 1; idx < group.length - 1; idx += 1) {
            if (lastHitEnd >= 0 && group[idx].frame <= lastHitEnd + cooldownFrames) {
                continue;
            }

            const candidate = matchQuickFlashRun(group, idx, minDuration, threshold, returnThreshold, options);
            if (!candidate) continue;

            lastHitEnd = candidate.frame + candidate.duration_frames - 1;
            issues.push(makeVisualIssue(
                "flash_frame",
                candidate.frame,
                candidate.duration_frames,
                "warning",
                `快速抽样发现疑似夹帧，异常 ${candidate.duration_frames} 帧，前后画面相似`
            ));
        }
    }

    return issues;
}

function isFlashAnalysisSample(sample) {
    const meta = sample && sample.meta ? sample.meta : {};
    const intervalType = meta.interval_type || "";
    if (isDecorativeOverlaySample(sample)) return false;
    if (meta.probe_kind === "ungraded" || meta.probe_kind === "overexposure") return false;
    if (intervalType === "ungraded_probe" || intervalType === "exposure_probe" || intervalType === "gap" || intervalType === "black_source") {
        return false;
    }
    return meta.full_scan || ["flash_candidate", "fallback_clip", "transition", "timeline", "timeline_sparse", "suspect", "risky_stack_clip"].includes(intervalType);
}

function detectQuickOverexposureIssues(samples, options) {
    const issues = [];
    const minDuration = Math.max(1, safeInt(options.overexposure_min_frames, 3));

    for (const group of splitContiguousSamples(samples)) {
        let startIndex = -1;
        for (let idx = 0; idx <= group.length; idx += 1) {
            const overexposed = idx < group.length && group[idx].is_overexposed;
            if (overexposed && startIndex < 0) {
                startIndex = idx;
            }
            if ((!overexposed || idx === group.length) && startIndex >= 0) {
                const endIndex = idx - 1;
                const duration = endIndex - startIndex + 1;
                const first = group[startIndex];
                const runSamples = group.slice(startIndex, endIndex + 1);
                if (runSamples.length && runSamples.every(isDecorativeOverlaySample)) {
                    startIndex = -1;
                    continue;
                }
                if (duration >= minDuration) {
                    const stats = summarizeOverexposureSamples(group.slice(startIndex, endIndex + 1));
                    const issue = makeVisualIssue(
                        "overexposure",
                        first.frame,
                        duration,
                        "warning",
                        `快速抽样发现疑似过曝，持续 ${duration} 帧`
                    );
                    if (stats) {
                        issue.note += `，亮度 ${round(stats.mean, 3)} / 高亮占比 ${round(stats.brightRatio, 3)}`;
                    }
                    issue.confidence = 0.74;
                    issues.push(issue);
                } else if (duration === 1 && isStrongOverexposure(first.feature, options)) {
                    const issue = makeVisualIssue(
                        "overexposure",
                        first.frame,
                        1,
                        "warning",
                        "快速抽样发现单帧强过曝"
                    );
                    issue.confidence = 0.66;
                    issues.push(issue);
                }
                startIndex = -1;
            }
        }
    }

    issues.push(...detectSparseOverexposureIssues(samples, options));
    return issues;
}

function detectSparseOverexposureIssues(samples, options) {
    const issues = [];
    const groups = {};

    for (const sample of samples || []) {
        const meta = sample.meta || {};
        if (!sample.is_overexposed || !meta.interval_id || meta.full_scan) continue;
        if (!["fallback_clip", "timeline", "timeline_sparse", "exposure_probe"].includes(meta.interval_type || "")) continue;
        groups[meta.interval_id] = groups[meta.interval_id] || { meta, samples: [] };
        groups[meta.interval_id].samples.push(sample);
    }

    for (const item of Object.values(groups)) {
        const meta = item.meta || {};
        if (item.samples.every(isDecorativeOverlaySample)) continue;
        const overexposedSamples = item.samples.filter((sample) => sample.is_overexposed);
        if (!overexposedSamples.length) continue;
        const sampleCount = item.samples.length;
        const intervalDuration = Math.max(1, safeInt(meta.interval_end, 0) - safeInt(meta.interval_start, 0));
        const strongSignal = overexposedSamples.length >= 2 || overexposedSamples.some((sample) => isStrongOverexposure(sample.feature, options));
        if (!strongSignal) continue;

        const first = overexposedSamples[0];
        const duration = meta.interval_type === "exposure_probe"
            ? Math.max(1, Math.min(intervalDuration, overexposedSamples.length))
            : 1;
        const stats = summarizeOverexposureSamples(overexposedSamples);
        const clipLabel = meta.clip_name ? `: ${meta.clip_name}` : "";
        const issue = makeVisualIssue(
            "overexposure",
            first.frame,
            duration,
            "warning",
            `快速抽样发现疑似过曝${clipLabel}`
        );
        if (stats) {
            issue.note += `，高亮占比 ${round(stats.brightRatio, 3)} (${overexposedSamples.length}/${sampleCount})`;
        }
        issue.confidence = meta.interval_type === "exposure_probe" ? 0.72 : 0.64;
        issues.push(issue);
    }

    return issues;
}

function summarizeOverexposureSamples(sampleList) {
    const valid = (sampleList || []).filter((sample) => sample && sample.feature);
    if (!valid.length) return null;
    return {
        mean: averageNumber(valid.map((sample) => sample.feature.mean)),
        brightRatio: averageNumber(valid.map((sample) => sample.feature.bright_ratio || 0)),
        p95: averageNumber(valid.map((sample) => sample.feature.p95)),
    };
}

function detectQuickUngradedIssues(samples, options) {
    const issues = [];
    const groups = {};
    const contrastPool = [];
    const saturationPool = [];

    for (const sample of samples) {
        const meta = sample.meta || {};
        if (meta.interval_type !== "ungraded_probe") continue;
        const clipKey = meta.clip_key || meta.interval_id || `frame_${sample.frame}`;
        groups[clipKey] = groups[clipKey] || { meta, samples: [] };
        groups[clipKey].samples.push(sample);
        if (sample.feature && !sample.is_black && !sample.is_overexposed) {
            const contrast = ungradedFeatureContrast(sample.feature);
            const saturation = ungradedFeatureSaturation(sample.feature);
            if (Number.isFinite(contrast)) contrastPool.push(contrast);
            if (Number.isFinite(saturation)) saturationPool.push(saturation);
        }
    }

    if (!Object.keys(groups).length) {
        return issues;
    }

    const medianContrast = medianOfNumbers(contrastPool);
    const medianSaturation = medianOfNumbers(saturationPool);

    for (const item of Object.values(groups)) {
        const meta = item.meta || {};
        const gradeStatus = meta.grade_status || {};
        const stats = summarizeUngradedSamples(item.samples, options);
        const startFrame = safeInt(meta.interval_start, item.samples[0] ? item.samples[0].frame : 0);
        const durationFrames = Math.max(1, safeInt(meta.duration_frames, safeInt(meta.interval_end, startFrame + 1) - startFrame));
        const clipName = meta.clip_name || "Unknown";
        const clipLabel = `${clipName}${meta.track_index !== undefined ? ` (V${meta.track_index})` : ""}`;
        const noGradeSignal = !gradeStatus.has_grade_signal;
        const weakGradeSignal = gradeStatus.has_grade_signal && !gradeStatus.strong_grade_signal;

        if (stats && (stats.black_ratio >= 0.5 || stats.overexposed_ratio >= 0.5)) {
            continue;
        }

        if (!stats) {
            if (noGradeSignal || weakGradeSignal) {
                const issue = makeVisualIssue(
                    "ungraded",
                    startFrame,
                    durationFrames,
                    "warning",
                    `快速抽样未获得足够画面，但未发现调色信号: ${clipLabel}`
                );
                issue.confidence = noGradeSignal ? 0.78 : 0.66;
                issues.push(issue);
            }
            continue;
        }

        const contrastLimit = noGradeSignal ? 0.58 : (weakGradeSignal ? 0.46 : 0.28);
        const saturationLimit = noGradeSignal ? 0.56 : (weakGradeSignal ? 0.42 : 0.24);
        const relContrastRatio = noGradeSignal ? 0.92 : (weakGradeSignal ? 0.9 : 0.72);
        const relSaturationRatio = noGradeSignal ? 0.92 : (weakGradeSignal ? 0.9 : 0.78);
        const absFlat = stats.contrast < contrastLimit && stats.saturation < saturationLimit;
        const relFlat = medianContrast !== null && medianSaturation !== null
            ? (
                stats.contrast < Math.max(noGradeSignal ? 0.32 : (weakGradeSignal ? 0.28 : 0.2), medianContrast * relContrastRatio) &&
                stats.saturation < Math.max(noGradeSignal ? 0.26 : (weakGradeSignal ? 0.22 : 0.14), medianSaturation * relSaturationRatio)
            )
            : false;
        const validLuma = stats.luma > 0.08 && stats.luma < 0.94;
        const weakVisualSignal = weakGradeSignal && validLuma && (
            (stats.contrast < 0.5 && stats.saturation < 0.46) ||
            (stats.contrast < 0.62 && stats.saturation < 0.34) ||
            stats.flat_ratio >= 0.6
        );
        const noGradeVisualSignal = noGradeSignal && validLuma && stats.valid_count >= 1 && (
            (stats.contrast < 0.58 && stats.saturation < 0.56) ||
            (stats.contrast < 0.72 && stats.saturation < 0.42) ||
            (stats.contrast < 0.44 && stats.saturation < 0.68) ||
            stats.flat_ratio >= 0.45
        );

        if (!absFlat && !relFlat && !weakVisualSignal && !noGradeVisualSignal) {
            continue;
        }

        const confidence = gradeStatus.strong_grade_signal ? 0.62 : (weakGradeSignal ? 0.74 : 0.82);
        const issue = makeVisualIssue(
            "ungraded",
            startFrame,
            durationFrames,
            "warning",
            `快速抽样发现疑似未调色: ${clipLabel}`
        );
        issue.confidence = confidence;
        issue.note = `${issue.note}，中心对比度 ${round(stats.contrast, 3)} / 中心饱和度 ${round(stats.saturation, 3)}`;
        issues.push(issue);
    }

    return issues;
}

function summarizeUngradedSamples(sampleList, options) {
    if (!sampleList || !sampleList.length) {
        return null;
    }

    const analysisSamples = sampleList.filter((sample) => sample && sample.feature);
    if (!analysisSamples.length) {
        return null;
    }

    const valid = analysisSamples.filter((sample) => sample && sample.feature && !sample.is_black && !sample.is_overexposed);
    if (!valid.length) {
        return null;
    }

    const blackCount = analysisSamples.filter((sample) => sample && sample.is_black).length;
    const overexposedCount = analysisSamples.filter((sample) => sample && sample.is_overexposed).length;
    const flatCount = valid.filter((sample) => {
        const feature = sample.feature;
        const contrastLimit = Math.max(0.2, safeNumber(options && options.ungraded_contrast_limit, 0.34));
        const saturationLimit = Math.max(0.14, safeNumber(options && options.ungraded_saturation_limit, 0.3));
        return ungradedFeatureContrast(feature) <= contrastLimit && ungradedFeatureSaturation(feature) <= saturationLimit;
    }).length;

    return {
        contrast: averageNumber(valid.map((sample) => ungradedFeatureContrast(sample.feature))),
        saturation: averageNumber(valid.map((sample) => ungradedFeatureSaturation(sample.feature))),
        luma: averageNumber(valid.map((sample) => ungradedFeatureLuma(sample.feature))),
        sample_count: analysisSamples.length,
        valid_count: valid.length,
        black_ratio: blackCount / analysisSamples.length,
        overexposed_ratio: overexposedCount / analysisSamples.length,
        flat_ratio: flatCount / valid.length,
    };
}

function ungradedFeatureContrast(feature) {
    if (!feature) return 1;
    return Number.isFinite(feature.content_contrast) ? feature.content_contrast : feature.contrast;
}

function ungradedFeatureSaturation(feature) {
    if (!feature) return 1;
    return Number.isFinite(feature.content_saturation) ? feature.content_saturation : feature.saturation;
}

function ungradedFeatureLuma(feature) {
    if (!feature) return 0;
    return Number.isFinite(feature.content_mean) ? feature.content_mean : feature.mean;
}

function medianOfNumbers(values) {
    const filtered = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!filtered.length) {
        return null;
    }
    const mid = Math.floor(filtered.length / 2);
    if (filtered.length % 2) {
        return filtered[mid];
    }
    return (filtered[mid - 1] + filtered[mid]) / 2;
}

function averageNumber(values) {
    const filtered = (values || []).filter((value) => Number.isFinite(value));
    if (!filtered.length) {
        return 0;
    }
    return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function matchQuickFlashRun(group, startIndex, minDuration, threshold, returnThreshold, options) {
    const prevFeature = group[startIndex - 1].feature;
    if (!prevFeature) return null;

    const maxDuration = Math.min(minDuration, group.length - startIndex - 1);
    for (let duration = 1; duration <= maxDuration; duration += 1) {
        const endIndex = startIndex + duration - 1;
        const nextIndex = endIndex + 1;
        const firstFeature = group[startIndex].feature;
        const lastFeature = group[endIndex].feature;
        const nextFeature = group[nextIndex].feature;
        if (!firstFeature || !lastFeature || !nextFeature) continue;
        const candidateSamples = group.slice(startIndex, endIndex + 1);
        if (candidateSamples.some((sample) => sample.is_black || isFeatureBlack(sample.feature, options))) {
            continue;
        }

        const enterScore = featureDiff(prevFeature, firstFeature);
        const exitScore = featureDiff(lastFeature, nextFeature);
        const returnScore = featureDiff(prevFeature, nextFeature);
        const breakScore = Math.min(enterScore, exitScore);

        if (breakScore < threshold) continue;
        if (returnScore > returnThreshold) continue;
        if (!lumaSpike(prevFeature, firstFeature, nextFeature) && enterScore < threshold * 1.15) continue;

        return {
            frame: group[startIndex].frame,
            duration_frames: duration,
            diff_score: round(breakScore, 4),
            return_score: round(returnScore, 4),
        };
    }

    return null;
}

function splitContiguousSamples(samples) {
    const sorted = samples.slice().sort((a, b) => a.frame - b.frame);
    const groups = [];
    let current = [];
    for (const sample of sorted) {
        if (!current.length || sample.frame === current[current.length - 1].frame + 1) {
            current.push(sample);
        } else {
            groups.push(current);
            current = [sample];
        }
    }
    if (current.length) groups.push(current);
    return groups;
}

function isFeatureBlack(feature, options) {
    const threshold = (safeInt(options.black_threshold, 18) || 18) / 255;
    const darkRatioThreshold = parseFloat(options.black_dark_ratio);
    const darkRatio = Number.isFinite(darkRatioThreshold) ? darkRatioThreshold : 0.94;
    const highlightThreshold = (safeInt(options.black_highlight_threshold, 62) || 62) / 255;
    return (
        feature.mean <= threshold &&
        feature.dark_ratio >= darkRatio &&
        feature.p95 <= highlightThreshold
    );
}

function isFeatureOverexposed(feature, options) {
    if (!feature) return false;
    options = options || {};
    const meanThreshold = normalizeUnitThreshold(options.overexposure_luma_threshold, 0.82);
    const brightRatioThreshold = parseFloat(options.overexposure_bright_ratio);
    const brightRatio = Number.isFinite(brightRatioThreshold) ? brightRatioThreshold : 0.28;
    const p95Threshold = normalizeUnitThreshold(options.overexposure_p95_threshold, 0.97);
    const bright = Number.isFinite(feature.bright_ratio) ? feature.bright_ratio : 0;
    const clipped = Number.isFinite(feature.clipped_ratio) ? feature.clipped_ratio : 0;
    const strongFullFrame = (
        feature.mean >= meanThreshold &&
        bright >= brightRatio &&
        feature.p95 >= p95Threshold
    );
    const localizedClip = (
        feature.mean >= Math.max(0.66, meanThreshold - 0.12) &&
        bright >= Math.max(0.12, brightRatio * 0.5) &&
        feature.p95 >= Math.max(0.98, p95Threshold) &&
        feature.p05 >= 0.22 &&
        feature.saturation <= 0.42
    );
    const clippedHighlight = (
        clipped >= 0.035 &&
        feature.p95 >= Math.max(0.985, p95Threshold) &&
        feature.mean >= Math.max(0.58, meanThreshold - 0.18) &&
        feature.saturation <= 0.48
    );
    return strongFullFrame || localizedClip || clippedHighlight;
}

function isStrongOverexposure(feature, options) {
    if (!feature) return false;
    options = options || {};
    const p95Threshold = normalizeUnitThreshold(options.overexposure_p95_threshold, 0.97);
    const brightRatio = Number.isFinite(feature.bright_ratio) ? feature.bright_ratio : 0;
    return feature.mean >= 0.88 && brightRatio >= 0.42 && feature.p95 >= Math.max(0.985, p95Threshold);
}

function normalizeUnitThreshold(value, fallback) {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed > 1 ? parsed / 255 : parsed;
}

function featureDiff(a, b) {
    const length = Math.min(a.gray.length, b.gray.length);
    if (!length) return 1;
    let pixelDiff = 0;
    for (let idx = 0; idx < length; idx += 1) {
        pixelDiff += Math.abs(a.gray[idx] - b.gray[idx]);
    }
    pixelDiff /= length;
    const meanDiff = Math.abs(a.mean - b.mean);
    const contrastDiff = Math.abs(a.std - b.std);
    return pixelDiff * 0.82 + meanDiff * 0.12 + contrastDiff * 0.06;
}

function lumaSpike(prevFeature, currFeature, nextFeature) {
    const currDelta = Math.max(
        Math.abs(currFeature.mean - prevFeature.mean),
        Math.abs(currFeature.mean - nextFeature.mean)
    );
    const neighborDelta = Math.abs(prevFeature.mean - nextFeature.mean);
    return currDelta >= 0.18 && neighborDelta <= 0.08;
}

function makeVisualIssue(type, frame, durationFrames, severity, note) {
    return {
        type,
        frame,
        duration_frames: Math.max(1, safeInt(durationFrames, 1)),
        severity,
        note,
        confidence: 0.78,
        detection_mode: "quick_visual",
    };
}

async function renderTimelineToFrames(timelineInfo, targetHeightValue, analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const workDir = ensureWorkDir();
    const renderDir = path.join(workDir, "render");
    const framesDir = path.join(workDir, "frames");
    fs.mkdirSync(renderDir, { recursive: true });
    fs.mkdirSync(framesDir, { recursive: true });

    await safeCall(() => resolveObj.OpenPage("deliver"), false);

    const customName = `moteline_${Date.now()}`;
    await trySetRenderFormatAndCodec();
    await tryLoadRenderPreset();

    const targetHeight = safeInt(targetHeightValue, 960) || 960;
    const renderWidthHeight = chooseAnalysisResolution(timelineInfo.width, timelineInfo.height, targetHeight);
    const settingResult = await applyRenderSettingsWithFallback(renderDir, customName, renderWidthHeight, timelineInfo);
    if (!settingResult.ok) {
        return {
            error: "Failed to apply render settings",
            work_dir: workDir,
            attempts: settingResult.attempts,
        };
    }
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();

    const jobId = await safeCall(() => projectObj.AddRenderJob(), null);
    if (!jobId) {
        return { error: "Failed to add render job", work_dir: workDir };
    }
    if (isAnalysisCancelled(analysisSession)) {
        await safeCall(() => projectObj.DeleteRenderJob(jobId), false);
        return cancelledReport();
    }

    const started = await safeCall(() => projectObj.StartRendering(jobId), false);
    if (!started) {
        return { error: "Failed to start rendering", work_dir: workDir };
    }

    const renderStatus = await waitForRender(jobId, analysisSession);
    if (renderStatus.cancelled) {
        await safeCall(() => projectObj.DeleteRenderJob(jobId), false);
        return cancelledReport();
    }
    if (renderStatus.error) {
        return { error: renderStatus.error, work_dir: workDir, render_status: renderStatus };
    }

    const renderedFile = findLatestRenderedFile(renderDir);
    if (!renderedFile) {
        return { error: "Render completed but no output file found", work_dir: workDir, render_dir: renderDir };
    }

    const ffmpegPath = findFfmpeg();
    if (!ffmpegPath) {
        return { error: "FFmpeg not found", work_dir: workDir, rendered_file: renderedFile };
    }

    const extracted = await extractFrames(ffmpegPath, renderedFile, framesDir, renderWidthHeight.height, analysisSession);
    if (extracted && extracted.cancelled) {
        await safeCall(() => projectObj.DeleteRenderJob(jobId), false);
        return cancelledReport();
    }
    if (!extracted) {
        return { error: "Failed to extract frames", work_dir: workDir, rendered_file: renderedFile };
    }
    const extractedFrameCount = countExtractedFrames(framesDir);
    if (extractedFrameCount <= 0) {
        return { error: "Frame extraction completed but no frames were produced", work_dir: workDir, rendered_file: renderedFile, frames_dir: framesDir };
    }

    await safeCall(() => projectObj.DeleteRenderJob(jobId), false);

    return {
        work_dir: workDir,
        render_dir: renderDir,
        frames_dir: framesDir,
        rendered_file: renderedFile,
        render_status: renderStatus,
        render_settings_mode: settingResult.mode,
        sample_count: extractedFrameCount,
        requested_sample_count: Math.max(0, safeInt(timelineInfo.duration_frames, 0)),
    };
}

async function applyRenderSettingsWithFallback(renderDir, customName, renderWidthHeight, timelineInfo) {
    const frameRate = parseFloat(timelineInfo.frame_rate);
    const hasFrameRate = !Number.isNaN(frameRate);
    const markIn = timelineObj.GetStartFrame ? await timelineObj.GetStartFrame() : timelineInfo.start_frame;
    const markOut = timelineObj.GetEndFrame ? await timelineObj.GetEndFrame() : timelineInfo.end_frame;

    const attempts = [
        {
            mode: "analysis_resolution_all_frames",
            settings: {
                SelectAllFrames: true,
                TargetDir: renderDir,
                CustomName: customName,
                ExportVideo: true,
                ExportAudio: false,
                FormatWidth: renderWidthHeight.width,
                FormatHeight: renderWidthHeight.height,
                VideoQuality: "Least",
            },
        },
        {
            mode: "analysis_resolution_mark_range",
            settings: {
                SelectAllFrames: false,
                MarkIn: markIn,
                MarkOut: markOut,
                TargetDir: renderDir,
                CustomName: customName,
                ExportVideo: true,
                ExportAudio: false,
                FormatWidth: renderWidthHeight.width,
                FormatHeight: renderWidthHeight.height,
            },
        },
        {
            mode: "minimal_all_frames",
            settings: {
                SelectAllFrames: true,
                TargetDir: renderDir,
                CustomName: customName,
                ExportVideo: true,
                ExportAudio: false,
            },
        },
        {
            mode: "target_only",
            settings: {
                TargetDir: renderDir,
                CustomName: customName,
            },
        },
    ];

    if (hasFrameRate) {
        attempts[0].settings.FrameRate = frameRate;
        attempts[1].settings.FrameRate = frameRate;
    }

    const attemptLog = [];
    for (const attempt of attempts) {
        const ok = await safeCall(() => projectObj.SetRenderSettings(attempt.settings), false);
        attemptLog.push({
            mode: attempt.mode,
            ok: !!ok,
            keys: Object.keys(attempt.settings),
        });
        if (ok) {
            return { ok: true, mode: attempt.mode, attempts: attemptLog };
        }
    }

    return { ok: false, mode: "", attempts: attemptLog };
}

async function waitForRender(jobId, analysisSession = activeAnalysisState, timeoutSeconds = 1800) {
    const start = Date.now();
    let lastStatus = null;
    while (Date.now() - start < timeoutSeconds * 1000) {
        if (isAnalysisCancelled(analysisSession)) {
            await safeCall(() => projectObj.StopRendering(), false);
            return { cancelled: true, last_status: lastStatus };
        }
        const status = await safeCall(() => projectObj.GetRenderJobStatus(jobId), null);
        if (status && typeof status === "object") {
            lastStatus = status;
            const text = String(status.JobStatus || status.Status || status.status || "").toLowerCase();
            if (text.includes("failed") || text.includes("error")) {
                return { error: `Render failed: ${JSON.stringify(status)}`, last_status: status };
            }
            if (text.includes("complete")) {
                return { status };
            }
        }
        const rendering = await safeCall(() => projectObj.IsRenderingInProgress(), false);
        if (!rendering) {
            return { status: lastStatus || { JobStatus: "Complete" } };
        }
        await sleep(500);
    }
    await safeCall(() => projectObj.StopRendering(), false);
    return { error: "Render timed out", last_status: lastStatus };
}

function findLatestRenderedFile(directory) {
    const files = walkFiles(directory).filter((file) => [".mp4", ".mov", ".mkv", ".avi"].includes(path.extname(file).toLowerCase()));
    if (files.length === 0) {
        return null;
    }
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0];
}

function countExtractedFrames(directory) {
    try {
        return fs.readdirSync(directory).filter((file) => /^frame_.*\.png$/i.test(file) || /\.png$/i.test(file)).length;
    } catch (_) {
        return 0;
    }
}

function walkFiles(dir) {
    const result = [];
    if (!fs.existsSync(dir)) return result;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...walkFiles(full));
        } else if (entry.isFile()) {
            result.push(full);
        }
    }
    return result;
}

function findFfmpeg() {
    const candidates = [
        process.env.FFMPEG_PATH,
        path.join(__dirname, "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
        path.join(__dirname, "runtime", "ffmpeg", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ].filter(Boolean);
    for (const exe of candidates) {
        try {
            if (fs.existsSync(exe)) {
                return exe;
            }
        } catch (_) {}
    }
    return null;
}

async function extractFrames(ffmpegPath, videoFile, outputDir, targetHeight, analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const outputPattern = path.join(outputDir, "frame_%06d.png");
    const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoFile,
        "-vf",
        `scale=-2:${targetHeight}`,
        "-vsync",
        "0",
        "-y",
        outputPattern,
    ];
    const result = await spawnProcess(ffmpegPath, args, analysisSession);
    if (result && result.cancelled) return cancelledReport();
    return result.code === 0;
}

function spawnProcess(exe, args, analysisSession = activeAnalysisState) {
    return new Promise((resolve) => {
        const child = spawn(exe, args, {
            cwd: __dirname,
            env: buildToolEnv(),
            windowsHide: true,
        });
        if (analysisSession) {
            analysisSession.child = child;
        }
        let stderr = "";
        child.stderr.on("data", (data) => {
            stderr += data.toString("utf8");
        });
        child.on("error", (error) => {
            if (analysisSession && analysisSession.child === child) {
                analysisSession.child = null;
            }
            if (isAnalysisCancelled(analysisSession)) {
                resolve(cancelledReport());
                return;
            }
            resolve({ code: -1, stderr: error.message || String(error) });
        });
        child.on("close", (code) => {
            if (analysisSession && analysisSession.child === child) {
                analysisSession.child = null;
            }
            if (isAnalysisCancelled(analysisSession)) {
                resolve(cancelledReport());
                return;
            }
            resolve({ code, stderr });
        });
    });
}

async function trySetRenderFormatAndCodec() {
    const candidates = [
        ["mp4", "H264"],
        ["mp4", "H.264"],
        ["mov", "H264"],
        ["mov", "H.264"],
    ];
    for (const [format, codec] of candidates) {
        const ok = await safeCall(() => projectObj.SetCurrentRenderFormatAndCodec(format, codec), false);
        if (ok) return true;
    }
    return false;
}

async function tryLoadRenderPreset() {
    const presets = ["H.264 Main", "H.264 Master", "YouTube 1080p"];
    for (const preset of presets) {
        const ok = await safeCall(() => projectObj.LoadRenderPreset(preset), false);
        if (ok) return true;
    }
    return false;
}

function ensureWorkDir() {
    const dir = path.join(RUNTIME_DIR, "analysis");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `run_${Date.now()}`);
}

function chooseAnalysisResolution(width, height, targetHeight) {
    if (!width || !height) {
        return { width: 540, height: targetHeight };
    }
    let renderWidth;
    let renderHeight;
    if (height >= width) {
        renderHeight = targetHeight;
        renderWidth = Math.round(renderHeight * (width / height));
    } else {
        renderWidth = targetHeight;
        renderHeight = Math.round(renderWidth * (height / width));
    }
    return { width: makeEven(Math.max(2, renderWidth)), height: makeEven(Math.max(2, renderHeight)) };
}

async function runAnalysisPipeline(params, analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const timelineInfo = await getTimelineInfo();
    if (timelineInfo.error) return timelineInfo;
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();

    const clipsInfo = await collectClipsInfo(analysisSession);
    if (clipsInfo.cancelled) return cancelledReport();
    if (clipsInfo.error) return clipsInfo;
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();

    const options = Object.assign(
        {
            check_types: ["short_drama_structure", "black_frame", "black_screen", "flash_frame", "ungraded", "overexposure", "mono_audio"],
            black_threshold: 18,
            black_screen_min_frames: 8,
            black_dark_ratio: 0.94,
            black_highlight_threshold: 62,
            flash_threshold: 0.28,
            flash_return_threshold: 0.12,
            flash_min_frames: 3,
            micro_clip_max_frames: 3,
            ungraded_min_clip_frames: 8,
            overexposure_luma_threshold: 0.82,
            overexposure_bright_ratio: 0.28,
            overexposure_p95_threshold: 0.97,
            overexposure_min_frames: 3,
            render_height: 960,
            quick_full_scan_max_frames: 360,
            quick_max_samples: 300,
            quick_suspect_full_scan_max_frames: 72,
            quick_exact_clip_max_frames: 48,
            quick_exact_gap_max_frames: 180,
            quick_stride_frames: 12,
            quick_edge_window_frames: 3,
            quick_fallback_clip_limit: 12,
            quick_ungraded_max_clips: 0,
            quick_overexposure_max_clips: 16,
            quick_transition_probe_limit: 40,
            quick_page_settle_ms: 30,
            quick_ignore_transparent_overlay_layers: true,
            precise_direct_full_scan_max_frames: 7200,
            transition_ignore_radius_frames: 8,
            transition_clip_max_frames: 36,
            transition_black_ignore_max_frames: 12,
            transition_flash_ignore_max_frames: 6,
            transition_overexposure_ignore_max_frames: 4,
            add_markers: true,
            cleanup_frames: true,
            render_enabled: true,
        },
        params || {}
    );

    const quickMode = options.render_enabled === false || options.check_mode === "quick";
    const quickAnalysisClipsInfo = quickMode ? filterQuickAnalysisClips(clipsInfo, options) : clipsInfo;
    const visualChecks = ["black_frame", "black_screen", "flash_frame", "overexposure"];
    const requestedVisualChecks = visualChecks.filter((type) => options.check_types.includes(type));
    const wantsQuickUngraded = options.check_types.includes("ungraded");
    const wantsQuickMonoAudio = options.check_types.includes("mono_audio");
    const audioClipsInfo = wantsQuickMonoAudio ? await collectAudioClipsInfo(analysisSession) : [];
    if (audioClipsInfo.cancelled) return cancelledReport();
    const audioResults = wantsQuickMonoAudio && !audioClipsInfo.error ? detectMonoAudioIssues(audioClipsInfo, options) : [];
    const transitionProtection = await buildTimelineTransitionProtection(timelineInfo, quickAnalysisClipsInfo, options, analysisSession);
    if (transitionProtection.cancelled) return cancelledReport();
    const quickVisualReport = quickMode && (requestedVisualChecks.length || wantsQuickUngraded)
        ? await runQuickVisualAnalysis(timelineInfo, quickAnalysisClipsInfo, clipsInfo, options, requestedVisualChecks, analysisSession)
        : null;
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const quickUngradedMetadataResults = quickMode && wantsQuickUngraded
        ? await detectTimelineUngradedIssues(quickAnalysisClipsInfo, timelineInfo, options, analysisSession)
        : [];
    if (quickUngradedMetadataResults.cancelled) return cancelledReport();
    const structuralResults = [];
    let structuralReport = null;
    if (options.check_types.includes("short_drama_structure")) {
        structuralReport = await runBackend("analyze_frames", {
            timeline_info: timelineInfo,
            clips_info: clipsInfo,
            frames_dir: "",
            options: Object.assign({}, options, {
                check_types: ["short_drama_structure"],
            }),
        }, analysisSession);
        if (structuralReport.cancelled) return cancelledReport();
        if (structuralReport.error) {
            return structuralReport;
        }
        structuralResults.push(...(structuralReport.issues || []));
    }

    let renderResult = {};
    let framesDir = options.frames_dir || "";
    let directVisualReport = null;
    let directVisualError = "";
    if (!quickMode && options.render_enabled) {
        renderResult = await renderTimelineToFrames(timelineInfo, options.render_height, analysisSession);
        if (renderResult.cancelled) return cancelledReport();
        if (renderResult.frames_dir) {
            framesDir = renderResult.frames_dir;
        }
    } else if (quickVisualReport && quickVisualReport.capture) {
        renderResult = Object.assign(
            {
                skipped: true,
                render_settings_mode: "quick_visual",
            },
            quickVisualReport.capture || {}
        );
    }

    const frameVisualChecks = new Set(["black_frame", "black_screen", "flash_frame", "overexposure"]);
    const missingPreciseFrames = !quickMode && requestedVisualChecks.some((type) => frameVisualChecks.has(type)) && (!framesDir || renderResult.error);
    if (missingPreciseFrames) {
        const maxDirectFrames = Math.max(1, safeInt(options.precise_direct_full_scan_max_frames, 7200));
        if (timelineInfo.duration_frames <= maxDirectFrames) {
            directVisualReport = await runQuickVisualAnalysis(
                timelineInfo,
                quickAnalysisClipsInfo,
                clipsInfo,
                Object.assign({}, options, {
                    render_enabled: false,
                    check_mode: "precise_direct",
                    precise_direct_full_scan: true,
                    quick_force_full_scan: true,
                    quick_full_scan_max_frames: Math.max(safeInt(options.quick_full_scan_max_frames, 360), timelineInfo.duration_frames),
                    quick_max_samples: Math.max(safeInt(options.quick_max_samples, 300), timelineInfo.duration_frames),
                }),
                requestedVisualChecks,
                analysisSession
            );
            if (directVisualReport.cancelled || isAnalysisCancelled(analysisSession)) return cancelledReport();
            if (directVisualReport.capture && directVisualReport.capture.error) {
                directVisualError = `精确检查渲染失败后，直接逐帧兜底也未取得画面: ${directVisualReport.capture.error}`;
            }
        } else {
            directVisualError = `精确检查无法取得逐帧画面: ${renderResult.error || "render frames unavailable"}；时间线 ${timelineInfo.duration_frames} 帧超过直接逐帧兜底上限 ${maxDirectFrames} 帧`;
        }
    }

    const backendCheckTypes = options.check_types
        .filter((type) => type !== "short_drama_structure")
        .filter((type) => type !== "mono_audio")
        .filter((type) => !(quickMode && visualChecks.indexOf(type) !== -1))
        .filter((type) => !(quickMode && type === "ungraded"))
        .filter((type) => framesDir || !frameVisualChecks.has(type));
    let backendResult = {
        issues: [],
        total_issues: 0,
        issues_by_type: {},
        issues_by_severity: {},
    };
    if (backendCheckTypes.length) {
        backendResult = await runBackend("analyze_frames", {
            timeline_info: timelineInfo,
            clips_info: clipsInfo,
            frames_dir: framesDir,
            options: Object.assign({}, options, {
                check_types: backendCheckTypes,
            }),
        }, analysisSession);
    }
    if (backendResult.cancelled || isAnalysisCancelled(analysisSession)) return cancelledReport();
    if (backendResult.error) {
        if (options.cleanup_frames && renderResult.work_dir) {
            cleanupWorkDir(renderResult.work_dir);
        }
        const fallbackIssues = filterIssuesByTransition(
            structuralResults
                .concat(audioResults)
                .concat(quickUngradedMetadataResults)
                .concat(quickVisualReport ? quickVisualReport.issues || [] : [])
                .concat(directVisualReport ? directVisualReport.issues || [] : []),
            transitionProtection,
            options
        );
        const dedupedFallbackIssues = dedupeIssues(fallbackIssues);
        return Object.assign({}, backendResult, {
            scenario: "short_drama",
            timeline: timelineInfo,
            render: cleanRenderResult(renderResult),
            quick_visual: quickVisualReport ? {
                sample_count: quickVisualReport.capture ? quickVisualReport.capture.sample_count : 0,
                requested_sample_count: quickVisualReport.capture ? quickVisualReport.capture.requested_sample_count : 0,
                source_counts: quickVisualReport.capture ? quickVisualReport.capture.source_counts : {},
                errors: quickVisualReport.capture ? quickVisualReport.capture.errors : [],
                plan: quickVisualReport.capture ? quickVisualReport.capture.plan : {},
                error: quickVisualReport.capture ? quickVisualReport.capture.error : "",
                preflight: quickVisualReport.capture ? quickVisualReport.capture.preflight : null,
            } : null,
            direct_visual: directVisualReport ? {
                sample_count: directVisualReport.capture ? directVisualReport.capture.sample_count : 0,
                requested_sample_count: directVisualReport.capture ? directVisualReport.capture.requested_sample_count : 0,
                source_counts: directVisualReport.capture ? directVisualReport.capture.source_counts : {},
                errors: directVisualReport.capture ? directVisualReport.capture.errors : [],
                plan: directVisualReport.capture ? directVisualReport.capture.plan : {},
                error: directVisualReport.capture ? directVisualReport.capture.error : "",
                preflight: directVisualReport.capture ? directVisualReport.capture.preflight : null,
            } : null,
            issues: dedupedFallbackIssues,
            total_issues: dedupedFallbackIssues.length,
            issues_by_type: summarizeIssues(dedupedFallbackIssues, "type"),
            issues_by_severity: summarizeIssues(dedupedFallbackIssues, "severity"),
            transition_protection: transitionProtection.summary,
            visual_check_error: directVisualError,
        });
    }

    const mergedIssues = dedupeIssues(filterIssuesByTransition(
        structuralResults
            .concat(audioResults)
            .concat(quickUngradedMetadataResults)
            .concat(backendResult.issues || [])
            .concat(quickVisualReport ? quickVisualReport.issues || [] : [])
            .concat(directVisualReport ? directVisualReport.issues || [] : []),
        transitionProtection,
        options
    ));
    let markerResult = { count: 0 };
    if (options.add_markers) {
        if (isAnalysisCancelled(analysisSession)) return cancelledReport();
        markerResult = await addMarkers(mergedIssues, analysisSession);
        if (markerResult.cancelled || isAnalysisCancelled(analysisSession)) return cancelledReport();
    }

    const merged = Object.assign({}, backendResult);
    if (!merged.check_time && structuralReport && structuralReport.check_time) {
        merged.check_time = structuralReport.check_time;
    }
    if (!merged.options) {
        merged.options = options;
    }
    if (!merged.report_file && structuralReport && structuralReport.report_file) {
        merged.report_file = structuralReport.report_file;
    }
    merged.scenario = "short_drama";
    merged.timeline = timelineInfo;
    if (renderResult.work_dir) {
        merged.render = cleanRenderResult(renderResult);
    }
    if (renderResult.error) {
        merged.render_error = renderResult.error;
    }
    if (renderResult.render_status) {
        merged.render_status = renderResult.render_status;
    }
    if (quickVisualReport) {
        merged.quick_visual = {
            sample_count: quickVisualReport.capture ? quickVisualReport.capture.sample_count : 0,
            requested_sample_count: quickVisualReport.capture ? quickVisualReport.capture.requested_sample_count : 0,
            source_counts: quickVisualReport.capture ? quickVisualReport.capture.source_counts : {},
            errors: quickVisualReport.capture ? quickVisualReport.capture.errors : [],
            plan: quickVisualReport.capture ? quickVisualReport.capture.plan : {},
            error: quickVisualReport.capture ? quickVisualReport.capture.error : "",
            preflight: quickVisualReport.capture ? quickVisualReport.capture.preflight : null,
        };
    }
    if (directVisualReport) {
        merged.direct_visual = {
            sample_count: directVisualReport.capture ? directVisualReport.capture.sample_count : 0,
            requested_sample_count: directVisualReport.capture ? directVisualReport.capture.requested_sample_count : 0,
            source_counts: directVisualReport.capture ? directVisualReport.capture.source_counts : {},
            errors: directVisualReport.capture ? directVisualReport.capture.errors : [],
            plan: directVisualReport.capture ? directVisualReport.capture.plan : {},
            error: directVisualReport.capture ? directVisualReport.capture.error : "",
            preflight: directVisualReport.capture ? directVisualReport.capture.preflight : null,
        };
    }
    if (directVisualError) {
        merged.visual_check_error = directVisualError;
    }
    merged.issues = mergedIssues;
    merged.total_issues = mergedIssues.length;
    merged.issues_by_type = summarizeIssues(mergedIssues, "type");
    merged.issues_by_severity = summarizeIssues(mergedIssues, "severity");
    merged.marker_count = markerResult.count || 0;
    merged.transition_protection = transitionProtection.summary;
    if (markerResult.error) {
        merged.marker_error = markerResult.error;
    }

    if (options.cleanup_frames && renderResult.work_dir) {
        cleanupWorkDir(renderResult.work_dir);
    }

    return merged;
}

async function runBatchCheck(params = {}, analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error };
    }
    if (isAnalysisCancelled(analysisSession)) return cancelledReport();

    const requestedFolderId = String(params.folder_id || ALL_TIMELINES_FOLDER_ID);
    const options = Object.assign({}, params.options || {});
    options.render_enabled = false;
    options.check_mode = "quick";
    options.add_markers = true;
    if (options.quick_transition_probe_limit === undefined) {
        options.quick_transition_probe_limit = 40;
    }

    const data = await getTimelineListData(true);
    const folderScope = data.folderScope || { folders: [], refs_by_folder: {} };
    const timelineLookup = data.timelineLookup || { timelines: [] };
    const selectedFolderId = requestedFolderId === ALL_TIMELINES_FOLDER_ID || folderScope.refs_by_folder[requestedFolderId]
        ? requestedFolderId
        : ALL_TIMELINES_FOLDER_ID;
    const folderRefs = selectedFolderId === ALL_TIMELINES_FOLDER_ID
        ? null
        : (folderScope.refs_by_folder[selectedFolderId] || null);
    const timelineItems = Array.isArray(folderRefs)
        ? timelineLookup.timelines.filter((item) => timelineMatchesFolderRefs(item, folderRefs))
        : timelineLookup.timelines.slice();
    const batchIssueSampleLimit = Math.max(1, safeInt(options.batch_issue_sample_limit, 120));

    if (!timelineItems.length) {
        return { error: "当前文件夹没有可检查的时间线。" };
    }

    const selectedFolder = folderScope.folders.find((folder) => folder && folder.id === selectedFolderId) || {
        id: ALL_TIMELINES_FOLDER_ID,
        name: "全部时间线",
        path: "全部时间线",
    };
    const originalTimeline = timelineObj;
    const batchReport = createBatchReportSummary(options, selectedFolder, timelineItems.length);
    let totalIssues = 0;

    try {
        for (const item of timelineItems) {
            if (isAnalysisCancelled(analysisSession)) {
                return cancelledReport();
            }
            try {
                const switched = await switchTimelineByIndex(item.index, true);
                if (switched.error) {
                    throw new Error(switched.error);
                }
                await sleep(160);

                const report = await runAnalysisPipeline(options, analysisSession);
                if (report && report.cancelled) {
                    return cancelledReport();
                }
                if (report && report.error && !(report.issues && report.issues.length)) {
                    batchReport.failed_timelines += 1;
                    batchReport.timeline_reports.push({
                        index: item.index,
                        name: item.name || "未命名时间线",
                        error: report.error,
                        total_issues: 0,
                    });
                    continue;
                }

                const normalized = normalizeBatchReportItem(report || {}, item);
                totalIssues += normalized.total_issues;
                batchReport.marker_count += normalized.marker_count;
                mergeCountMap(batchReport.issues_by_type, normalized.issues_by_type);
                mergeCountMap(batchReport.issues_by_severity, normalized.issues_by_severity);
                if (batchReport.issues.length < batchIssueSampleLimit && normalized.issues && normalized.issues.length) {
                    const remainingSlots = batchIssueSampleLimit - batchReport.issues.length;
                    batchReport.issues.push(...normalized.issues.slice(0, remainingSlots));
                }
                batchReport.timeline_reports.push(normalized.summary);
            } catch (error) {
                if (isAnalysisCancelled(analysisSession)) {
                    return cancelledReport();
                }
                batchReport.failed_timelines += 1;
                batchReport.timeline_reports.push({
                    index: item.index,
                    name: item.name || "未命名时间线",
                    error: error.message || String(error),
                    total_issues: 0,
                });
            }
        }
    } finally {
        if (originalTimeline) {
            await safeCall(() => projectObj.SetCurrentTimeline(originalTimeline), false);
            await sleep(120);
            timelineObj = originalTimeline;
        }
    }

    batchReport.checked_timelines = timelineItems.length;
    batchReport.completed = true;
    batchReport.total_timelines = timelineItems.length;
    batchReport.success_timelines = timelineItems.length - batchReport.failed_timelines;
    batchReport.total_issues = totalIssues;
    batchReport.issue_sample_count = batchReport.issues.length;
    return batchReport;
}

function createBatchReportSummary(options, folder, totalTimelines) {
    return {
        batch: true,
        options,
        folder_id: folder ? folder.id : ALL_TIMELINES_FOLDER_ID,
        folder_name: folder ? (folder.name || "全部时间线") : "全部时间线",
        folder_path: folder ? (folder.path || folder.name || "全部时间线") : "全部时间线",
        total_timelines: totalTimelines || 0,
        checked_timelines: 0,
        success_timelines: 0,
        failed_timelines: 0,
        total_issues: 0,
        issue_sample_count: 0,
        marker_count: 0,
        issues: [],
        issues_by_type: {},
        issues_by_severity: {},
        timeline_reports: [],
        check_time: new Date().toLocaleString(),
    };
}

function normalizeBatchReportItem(report, item) {
    const issues = (report && report.issues) || [];
    const previewIssues = issues.slice(0, 20);
    const normalizedIssues = [];
    for (const issue of previewIssues) {
        const copy = Object.assign({}, issue);
        copy.timeline_name = item.name || "未命名时间线";
        copy.timeline_index = item.index;
        copy.note = copy.note ? `【${copy.timeline_name}】${copy.note}` : `【${copy.timeline_name}】`;
        normalizedIssues.push(copy);
    }

    return {
        issues: normalizedIssues,
        total_issues: report.total_issues || issues.length || 0,
        marker_count: report.marker_count || 0,
        issues_by_type: report.issues_by_type || summarizeIssues(issues, "type"),
        issues_by_severity: report.issues_by_severity || summarizeIssues(issues, "severity"),
        summary: {
            index: item.index,
            name: item.name || "未命名时间线",
            total_issues: report.total_issues || issues.length || 0,
            marker_count: report.marker_count || 0,
            error: report.error || "",
        },
    };
}

function mergeCountMap(target, source) {
    const map = source || {};
    for (const key of Object.keys(map)) {
        target[key] = (target[key] || 0) + (map[key] || 0);
    }
}

async function addMarkers(issues, analysisSession = activeAnalysisState) {
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error, count: 0 };
    }

    let count = 0;
    for (const issue of issues) {
        if (isAnalysisCancelled(analysisSession)) {
            return { cancelled: true, count };
        }
        const issueType = canonicalIssueType(issue.type || "");
        const meta = {
            black_frame: { label: "黑帧", color: "Red" },
            black_screen: { label: "黑场", color: "Purple" },
            flash_frame: { label: "夹帧", color: "Sand", fallbackColor: "Yellow" },
            ungraded: { label: "未调色", color: "Yellow" },
            overexposure: { label: "过曝", color: "Green" },
            mono_audio: { label: "单声道", color: "Pink" },
            micro_clip: { label: "夹帧", color: "Sand", fallbackColor: "Yellow" },
            format_warning: { label: "格式", color: "Cyan" },
        }[issueType] || { label: issueType || "QC", color: "Red" };
        const frame = safeInt(issue.frame, 0);
        const duration = markerDurationForIssue(issue);
        const note = issue.confidence ? `${issue.note || ""}；置信度 ${Math.round(issue.confidence * 100)}%` : (issue.note || "");
        const customData = `MoteLine:${issueType}:${frame}`;
        const colors = Array.from(new Set([meta.color, meta.fallbackColor || "Yellow"].filter(Boolean)));
        let added = false;
        for (const color of colors) {
            if (added) break;
            if (isAnalysisCancelled(analysisSession)) {
                return { cancelled: true, count };
            }
            try {
                await timelineObj.AddMarker(frame, color, `${APP_DISPLAY_NAME}: ${meta.label}`, `[${APP_DISPLAY_NAME}][短剧] ${note}`, duration, customData);
                count += 1;
                added = true;
            } catch (_) {
                try {
                    await timelineObj.AddMarker(frame, color, `${APP_DISPLAY_NAME}: ${meta.label}`, `[${APP_DISPLAY_NAME}][短剧] ${note}`, duration);
                    count += 1;
                    added = true;
                } catch (_) {
                    // try next supported color
                }
            }
        }
    }

    return { count };
}

async function clearMarkers() {
    const ready = await ensureResolveObjects();
    if (!ready.ok) {
        return { error: ready.error };
    }

    try {
        const timelineStart = safeInt(await safeCall(() => timelineObj.GetStartFrame(), 0), 0);
        let attempted = 0;
        let remaining = 0;

        for (let pass = 0; pass < 2; pass += 1) {
            const markers = await safeCall(() => timelineObj.GetMarkers(), {});
            const targets = [];
            if (markers && typeof markers === "object") {
                for (const [frameKey, markerData] of Object.entries(markers)) {
                    if (isTimelineQcMarker(markerData)) {
                        targets.push({ frameKey, markerData });
                    }
                }
            }

            if (pass === 0) {
                attempted = targets.length;
            }
            if (!targets.length) {
                remaining = 0;
                break;
            }

            for (const target of targets) {
                await deleteTimelineQcMarker(target.frameKey, target.markerData, timelineStart);
            }

            const remainingMarkers = await safeCall(() => timelineObj.GetMarkers(), {});
            remaining = countTimelineQcMarkers(remainingMarkers);
            if (remaining === 0) break;
        }

        const cleared = Math.max(0, attempted - remaining);
        return {
            status: "ok",
            message: `${APP_DISPLAY_NAME} markers cleared`,
            attempted,
            cleared,
            remaining,
        };
    } catch (error) {
        return { error: error.message || String(error) };
    }
}

async function deleteTimelineQcMarker(frameKey, markerData, timelineStart) {
    const customData = markerCustomData(markerData);
    let deleted = false;

    if (customData && typeof timelineObj.DeleteMarkerByCustomData === "function") {
        const byCustomData = await safeCall(() => timelineObj.DeleteMarkerByCustomData(customData), false);
        if (byCustomData !== false) {
            deleted = true;
        }
    }

    if (typeof timelineObj.DeleteMarkerAtFrame === "function") {
        for (const frame of markerFrameCandidates(frameKey, timelineStart)) {
            const byFrame = await safeCall(() => timelineObj.DeleteMarkerAtFrame(frame), false);
            if (byFrame !== false) {
                deleted = true;
            }
        }
    }

    return deleted;
}

function markerFrameCandidates(frameKey, timelineStart) {
    const base = Number(frameKey);
    const candidates = [];
    const seen = new Set();
    const add = (value) => {
        if (!Number.isFinite(value)) return;
        const frame = Math.max(0, Math.round(value));
        if (seen.has(frame)) return;
        seen.add(frame);
        candidates.push(frame);
    };

    add(base);
    add(Math.floor(base));
    add(Math.ceil(base));
    if (timelineStart) {
        add(base + timelineStart);
        add(base - timelineStart);
    }
    return candidates;
}

function countTimelineQcMarkers(markers) {
    if (!markers || typeof markers !== "object") {
        return 0;
    }
    return Object.values(markers).reduce((count, markerData) => count + (isTimelineQcMarker(markerData) ? 1 : 0), 0);
}

function markerCustomData(markerData) {
    if (!markerData || typeof markerData !== "object") {
        return "";
    }
    return String(markerData.customData || markerData.customdata || markerData.custom_data || "").trim();
}

function isTimelineQcMarker(markerData) {
    if (!markerData || typeof markerData !== "object") {
        return false;
    }

    const name = String(markerData.name || "").trim();
    const note = String(markerData.note || "").trim();
    const customData = markerCustomData(markerData);
    const haystack = `${name} ${note} ${customData}`.toLowerCase();

    if (name.startsWith("QC:")) return true;
    if (haystack.includes("timelineqc")) return true;
    if (haystack.includes("moteline")) return true;
    if (haystack.includes("鸡腿快助手")) return true;
    if (haystack.includes("鸡腿大人")) return true;
    if (haystack.includes("[qc]")) return true;
    if (note.includes("短剧") && note.includes("Marker")) return true;
    return false;
}

ipcMain.handle("timelineqc:invoke", async (_event, action, params) => {
    if (action === "get_timeline_info") {
        return getTimelineInfo();
    }
    if (action === "get_timeline_list") {
        return getTimelineList(params || {});
    }
    if (action === "select_timeline") {
        return selectTimeline(params && params.index);
    }
    if (action === "cancel_check") {
        return cancelActiveAnalysis();
    }
    if (action === "run_check") {
        const session = beginAnalysisSession("run_check");
        try {
            return await runAnalysisPipeline(params, session);
        } finally {
            endAnalysisSession(session);
        }
    }
    if (action === "run_batch_check") {
        const session = beginAnalysisSession("run_batch_check");
        try {
            return await runBatchCheck(params || {}, session);
        } finally {
            endAnalysisSession(session);
        }
    }
    if (action === "clear_markers") {
        return clearMarkers();
    }
    if (action === "window_minimize") {
        if (mainWindow) mainWindow.minimize();
        return { status: "ok" };
    }
    if (action === "window_toggle_maximize") {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
        return { status: "ok" };
    }
    if (action === "window_close") {
        if (mainWindow) mainWindow.close();
        return { status: "ok" };
    }
    if (action === "check_update") {
        return checkForUpdates(params || {});
    }
    return runBackend(action, params);
});

app.whenReady().then(async () => {
    if (typeof app.setName === "function") {
        app.setName(APP_DISPLAY_NAME);
    }
    if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
        app.setAppUserModelId(PLUGIN_ID);
    }
    initWorkflowIntegration();
    createWindow();
    startUpdateMonitor();
});

app.on("window-all-closed", () => {
    cleanupWorkflowIntegration();
    if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
    }
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function safeInt(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function safeNumber(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function makeEven(value) {
    return value % 2 === 0 ? value : value + 1;
}

async function safeCall(fn, fallback) {
    try {
        return await Promise.resolve(fn());
    } catch (_) {
        return fallback;
    }
}

function normalizeResolveList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") {
        return Object.values(value).filter(Boolean);
    }
    return [];
}

function normalizeTimelineFrame(frame, timelineStartFrame) {
    const value = safeInt(frame, 0);
    return value >= timelineStartFrame ? value - timelineStartFrame : value;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function yieldToEventLoop(analysisSession = activeAnalysisState) {
    if (isAnalysisCancelled(analysisSession)) {
        return false;
    }
    await new Promise((resolve) => {
        if (typeof setImmediate === "function") {
            setImmediate(resolve);
        } else {
            setTimeout(resolve, 0);
        }
    });
    return !isAnalysisCancelled(analysisSession);
}

function cleanupWorkDir(workDir) {
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {
        // ignore
    }
}

function cleanRenderResult(renderResult) {
    return {
        rendered_file: renderResult.rendered_file || "",
        frames_dir: renderResult.frames_dir || "",
        error: renderResult.error || "",
        settings_mode: renderResult.render_settings_mode || "",
        attempts: renderResult.attempts || [],
        skipped: !!renderResult.skipped,
        sample_count: renderResult.sample_count || 0,
        requested_sample_count: renderResult.requested_sample_count || 0,
        source_counts: renderResult.source_counts || {},
        capture_dir: renderResult.capture_dir || "",
        quick_visual_error: renderResult.error || "",
        quick_visual_plan: renderResult.plan || {},
        quick_visual_errors: renderResult.errors || [],
        quick_visual_preflight: renderResult.preflight || null,
    };
}

function timelineFrameOffsetToTimecode(timelineInfo, frameOffset) {
    const fpsInfo = parseFrameRate(timelineInfo.frame_rate);
    const startTimecode = timelineInfo.start_timecode || "00:00:00:00";
    const startFrames = timecodeToFrames(startTimecode, fpsInfo);
    return framesToTimecode(startFrames + safeInt(frameOffset, 0), fpsInfo);
}

function parseFrameRate(value) {
    const raw = String(value || "25");
    const numeric = parseFloat(raw.replace(",", "."));
    const fps = Number.isFinite(numeric) && numeric > 0 ? numeric : 25;
    const dropFrame = /\bDF\b|drop/i.test(raw);
    const nominal = dropFrame ? Math.round(fps) : Math.max(1, Math.round(fps));
    return {
        fps,
        nominal,
        dropFrame,
        dropFrames: nominal >= 50 ? 4 : 2,
    };
}

function parseTimecode(timecode) {
    const match = String(timecode || "00:00:00:00").trim().match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
    if (!match) {
        return { hours: 0, minutes: 0, seconds: 0, frames: 0 };
    }
    return {
        hours: safeInt(match[1], 0),
        minutes: safeInt(match[2], 0),
        seconds: safeInt(match[3], 0),
        frames: safeInt(match[4], 0),
    };
}

function timecodeToFrames(timecode, fpsInfo) {
    const tc = parseTimecode(timecode);
    const nominal = fpsInfo.nominal;
    const baseFrames = ((tc.hours * 3600 + tc.minutes * 60 + tc.seconds) * nominal) + tc.frames;
    if (!fpsInfo.dropFrame) {
        return baseFrames;
    }
    const totalMinutes = tc.hours * 60 + tc.minutes;
    const dropped = fpsInfo.dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return baseFrames - dropped;
}

function framesToTimecode(frameNumber, fpsInfo) {
    const nominal = fpsInfo.nominal;
    let frames = Math.max(0, safeInt(frameNumber, 0));

    if (fpsInfo.dropFrame) {
        const dropFrames = fpsInfo.dropFrames;
        const framesPer10Minutes = nominal * 60 * 10 - dropFrames * 9;
        const framesPerMinute = nominal * 60 - dropFrames;
        const tenMinuteChunks = Math.floor(frames / framesPer10Minutes);
        const remainder = frames % framesPer10Minutes;
        const dropped = dropFrames * 9 * tenMinuteChunks + dropFrames * Math.floor(Math.max(0, remainder - dropFrames) / framesPerMinute);
        frames += dropped;
    }

    const framesPerHour = nominal * 3600;
    const hours = Math.floor(frames / framesPerHour);
    frames %= framesPerHour;
    const minutes = Math.floor(frames / (nominal * 60));
    frames %= nominal * 60;
    const seconds = Math.floor(frames / nominal);
    const frame = frames % nominal;
    const sep = fpsInfo.dropFrame ? ";" : ":";

    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${sep}${pad2(frame)}`;
}

function pad2(value) {
    return String(safeInt(value, 0)).padStart(2, "0");
}

function summarizeIssues(issues, field) {
    const counts = {};
    for (const issue of issues || []) {
        const rawKey = issue && issue[field] ? issue[field] : "unknown";
        const key = field === "type" ? canonicalIssueType(rawKey) : rawKey;
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

function dedupeIssues(issues) {
    const out = [];
    const blackRanges = [];
    const blackScreenRanges = [];
    const normalized = (issues || [])
        .filter(Boolean)
        .map((issue) => {
            const type = canonicalIssueType(issue.type || "");
            return type === (issue.type || "") ? issue : Object.assign({}, issue, { type });
        })
        .sort((a, b) => {
            const frameDiff = safeInt(a.frame, 0) - safeInt(b.frame, 0);
            if (frameDiff) return frameDiff;
            return issuePreferenceScore(b) - issuePreferenceScore(a);
        });

    for (const issue of normalized) {
        const type = canonicalIssueType(issue && issue.type ? issue.type : "");
        if (type !== "black_frame" && type !== "black_screen") continue;
        const range = issueRange(issue);
        blackRanges.push(range);
        if (type === "black_screen") {
            blackScreenRanges.push(range);
        }
    }

    for (const issue of normalized) {
        const type = canonicalIssueType(issue.type || "");
        const range = issueRange(issue);
        if (type === "black_frame" && blackScreenRanges.some((item) => rangesOverlap(range, item))) {
            continue;
        }
        if (type === "flash_frame" && blackRanges.some((item) => rangesOverlapOrNear(range, item, 1))) {
            continue;
        }

        const existingIndex = out.findIndex((existing) => shouldMergeIssue(existing, issue));
        if (existingIndex >= 0) {
            out[existingIndex] = choosePreferredIssue(out[existingIndex], issue);
        } else {
            out.push(issue);
        }
    }

    return out.sort((a, b) => safeInt(a.frame, 0) - safeInt(b.frame, 0) || issuePreferenceScore(b) - issuePreferenceScore(a));
}

function shouldMergeIssue(a, b) {
    const type = canonicalIssueType(a && a.type ? a.type : "");
    if (!type || type !== canonicalIssueType(b && b.type ? b.type : "")) return false;

    const rangeA = issueRange(a);
    const rangeB = issueRange(b);
    if (type === "flash_frame" || type === "black_frame") {
        return rangesOverlapOrNear(rangeA, rangeB, 1);
    }
    return rangesOverlap(rangeA, rangeB) && overlapRatio(rangeA, rangeB) >= 0.5;
}

function choosePreferredIssue(a, b) {
    return issuePreferenceScore(b) > issuePreferenceScore(a) ? b : a;
}

function issuePreferenceScore(issue) {
    const mode = String(issue && issue.detection_mode ? issue.detection_mode : "");
    const modeScore = {
        precise_visual: 90,
        quick_visual: 80,
        timeline_structure: 70,
        timeline_metadata: 66,
        timeline_audio: 70,
        stack_preflight: 40,
    }[mode] || 60;
    const confidence = Number.isFinite(parseFloat(issue && issue.confidence)) ? parseFloat(issue.confidence) * 10 : 0;
    return modeScore + confidence;
}

function issueRange(issue) {
    const start = safeInt(issue && issue.frame, 0);
    const duration = Math.max(1, safeInt(issue && issue.duration_frames, safeInt(issue && issue.duration, 1)));
    return [start, start + duration];
}

function rangesOverlap(a, b) {
    return a[0] < b[1] && b[0] < a[1];
}

function overlapRatio(a, b) {
    const overlap = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
    const shortest = Math.max(1, Math.min(a[1] - a[0], b[1] - b[0]));
    return overlap / shortest;
}

function rangesOverlapOrNear(a, b, tolerance) {
    if (rangesOverlap(a, b)) return true;
    const distance = a[1] <= b[0] ? (b[0] - a[1]) : (a[0] - b[1]);
    return distance <= safeInt(tolerance, 0);
}

function filterIssuesByTransition(issues, transitionProtection, options) {
    const intervals = normalizeTransitionProtectionIntervals(transitionProtection);
    if (!intervals.length) return (issues || []).filter(Boolean);
    return (issues || []).filter((issue) => !shouldSuppressTransitionFalsePositive(issue, intervals, options || {}));
}

function normalizeTransitionProtectionIntervals(transitionProtection) {
    const source = Array.isArray(transitionProtection)
        ? transitionProtection
        : (transitionProtection && Array.isArray(transitionProtection.intervals) ? transitionProtection.intervals : []);
    return source
        .map((item) => ({
            start: safeInt(item.start, 0),
            end: Math.max(safeInt(item.start, 0) + 1, safeInt(item.end, safeInt(item.start, 0) + 1)),
            confidence: safeNumber(item.confidence, 0.6),
            reason: item.reason || "",
        }))
        .filter((item) => item.end > item.start);
}

function shouldSuppressTransitionFalsePositive(issue, transitionIntervals, options) {
    if (!issue) return false;
    const type = canonicalIssueType(issue.type || "");
    if (!["black_frame", "black_screen", "flash_frame", "ungraded", "overexposure"].includes(type)) {
        return false;
    }
    if (issue.reason === "stack_gap") {
        return false;
    }
    if (
        issue.detection_mode === "timeline_structure" ||
        ["legacy_short_clip", "short_visible_segment", "sandwiched_short_segment"].includes(issue.reason)
    ) {
        return false;
    }

    const range = issueRange(issue);
    const duration = Math.max(1, range[1] - range[0]);
    const hit = transitionIntervals.find((interval) => {
        const intervalRange = [interval.start, interval.end];
        return rangesOverlapOrNear(range, intervalRange, 1) && interval.confidence >= 0.55;
    });
    if (!hit) return false;

    const maxBlackFrames = Math.max(1, safeInt(options.transition_black_ignore_max_frames, 12));
    const maxFlashFrames = Math.max(1, safeInt(options.transition_flash_ignore_max_frames, 6));
    const maxExposureFrames = Math.max(1, safeInt(options.transition_overexposure_ignore_max_frames, 4));
    const overlap = overlapRatio(range, [hit.start, hit.end]);

    if (type === "flash_frame") {
        return duration <= maxFlashFrames;
    }
    if (type === "black_frame") {
        return duration <= maxBlackFrames;
    }
    if (type === "black_screen") {
        return duration <= maxBlackFrames && overlap >= 0.45;
    }
    if (type === "overexposure") {
        return duration <= maxExposureFrames && overlap >= 0.45;
    }
    if (type === "ungraded") {
        return overlap >= 0.55;
    }
    return false;
}

function canonicalIssueType(type) {
    return type === "micro_clip" ? "flash_frame" : type;
}

function markerDurationForIssue(issue) {
    const type = canonicalIssueType(issue && issue.type ? issue.type : "");
    const duration = Math.max(1, safeInt(issue && issue.duration_frames, safeInt(issue && issue.duration, 1)));
    if (type === "flash_frame" || type === "black_frame") {
        return 1;
    }
    if (["black_screen", "ungraded", "overexposure", "mono_audio"].includes(type)) {
        return duration;
    }
    return duration >= 10 ? duration : 1;
}

