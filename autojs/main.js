/**
 * 暗区商店监控 - AutoJs6 主流程（坐标点击版）
 *
 * 部署：
 *   1. 安装 AutoJs6 (https://github.com/SuperMonster003/AutoJs6)
 *   2. 授予无障碍服务、悬浮窗、截图、电池保活、自启动 等权限
 *   3. 把 main.js 与 config.js 放入同一目录（如 /sdcard/脚本/arena_shop/）
 *   4. 在 AutoJs6 里直接运行 main.js（不要选"以 UI 模式运行"）
 *
 * 模式（在 config.js 切换）：
 *   - DEBUG_DRY_RUN: 仅截当前屏 + 上传，验证手机到服务器链路
 *   - DEBUG_RECON:   启动游戏 → 每隔 RECON_INTERVAL_SEC 秒截一帧，连续 RECON_FRAMES 帧
 *                    用于侦察游戏 UI 流程，标定各按钮坐标
 *   - 正常模式（两者都 false）: 启动 → 关弹窗 → 进商店 → 截各 tab → 退出
 *
 * 坐标系：可以是 [x, y] 绝对像素，也可以是 [0.1, 0.5] 这种相对比例（0~1）
 *
 * 重要：因为暗区是 Unity 游戏，UI 不是 Android 原生 View，
 *      所有点击都必须用 SHOP_ENTRY_XY / SHOP_TAB_XYS 里的坐标，
 *      不能再依赖 textContains 这种文本查找。
 */

const CFG = require("./config.js");

// ======== 工具函数 ========
function ts() { return new Date().toLocaleString(); }
function logMsg(msg) { console.log("[" + ts() + "] " + msg); }
function sleepSec(sec) { java.lang.Thread.sleep(sec * 1000); }
function sleepMs(ms) { java.lang.Thread.sleep(ms); }

// 解析坐标：[x,y] 绝对像素 或 [0.5,0.5] 相对比例
function resolveXY(pt) {
    let x = pt[0], y = pt[1];
    if (x > 0 && x <= 1) x = device.width * x;
    if (y > 0 && y <= 1) y = device.height * y;
    return [Math.round(x), Math.round(y)];
}

function tapPt(pt, label) {
    let xy = resolveXY(pt);
    logMsg("点击 " + (label || "坐标") + " (" + xy[0] + "," + xy[1] + ")");
    click(xy[0], xy[1]);
}

// ======== 屏幕 / 锁屏 ========
function ensureScreenOn() {
    let wasOff = !device.isScreenOn();
    if (wasOff) {
        logMsg("屏幕熄灭，唤醒中...");
        device.wakeUp();
        sleepSec(1);
        // 起点 0.7 终点 0.3，避开屏幕底部系统手势热区
        swipe(device.width / 2, device.height * 0.7, device.width / 2, device.height * 0.3, 400);
        sleepSec(1);
    } else {
        logMsg("屏幕已亮，跳过解锁手势");
    }
}

function lockScreen() {
    try { device.cancelKeepingAwake(); } catch (e) {}
    try {
        if (typeof lockNow !== "undefined") lockNow();
    } catch (e) { logMsg("锁屏失败（忽略）：" + e); }
}

// ======== 游戏控制 ========
function launchGame() {
    logMsg("启动暗区突围 " + CFG.GAME_PACKAGE);
    let ok = false;
    try { ok = launch(CFG.GAME_PACKAGE); } catch (e) { logMsg("launch 异常：" + e); }
    if (!ok) {
        logMsg("launch() 返回 false，尝试 app.launchPackage");
        try { app.launchPackage(CFG.GAME_PACKAGE); } catch (e) { logMsg("launchPackage 异常：" + e); }
    }
}

function waitGameReady() {
    let deadline = Date.now() + CFG.GAME_LAUNCH_TIMEOUT_SEC * 1000;
    while (Date.now() < deadline) {
        if (currentPackage() === CFG.GAME_PACKAGE) {
            logMsg("游戏已置前台，等待 " + CFG.MAIN_MENU_WAIT_SEC + "s 加载");
            sleepSec(CFG.MAIN_MENU_WAIT_SEC);
            return true;
        }
        sleepSec(1);
    }
    return false;
}

function exitGame() {
    logMsg("退出游戏");
    try { home(); } catch (e) {}
    sleepSec(1);
    try { shell("am force-stop " + CFG.GAME_PACKAGE, true); } catch (e) {
        logMsg("force-stop 失败（非 root 设备会失败，已 home）：" + e);
    }
}

// ======== 关弹窗：轮询点 CLOSE_BUTTONS 里的坐标 ========
function dismissPopups() {
    if (!CFG.CLOSE_BUTTONS || CFG.CLOSE_BUTTONS.length === 0) {
        logMsg("未配置 CLOSE_BUTTONS，跳过关弹窗");
        return;
    }
    let rounds = CFG.CLOSE_POPUP_ROUNDS || 3;
    for (let r = 0; r < rounds; r++) {
        logMsg("关弹窗第 " + (r + 1) + "/" + rounds + " 轮");
        for (let i = 0; i < CFG.CLOSE_BUTTONS.length; i++) {
            tapPt(CFG.CLOSE_BUTTONS[i], "关闭按钮[" + i + "]");
            sleepMs(800);
        }
        sleepSec(1);
    }
}

// ======== 截图 / 上传 ========
function ensureCaptureReady() {
    let ok = false;
    try { ok = requestScreenCapture(); } catch (e) {
        logMsg("requestScreenCapture 异常：" + e);
    }
    if (!ok) {
        toast("用户拒绝截图权限或已取消");
        logMsg("截图权限被拒绝，退出");
        exit();
    }
}

function captureToFile(tag) {
    let img = null;
    try { img = captureScreen(); } catch (e) { logMsg("captureScreen 异常：" + e); }
    if (!img) {
        logMsg("截图失败 tag=" + tag);
        return null;
    }
    let dir = "/sdcard/arena_shop_cache/";
    files.ensureDir(dir);
    let path = dir + Date.now() + "_" + tag + ".png";
    images.save(img, path);
    img.recycle();
    return path;
}

function uploadImage(filePath, tabName) {
    logMsg("上传 " + filePath + " tab=" + tabName);
    let res;
    try {
        res = http.postMultipart(CFG.SERVER_URL + "/upload", {
            image: open(filePath),
            tab: tabName,
            token: CFG.AUTH_TOKEN,
        }, {
            headers: { "X-Auth-Token": CFG.AUTH_TOKEN },
            timeout: CFG.UPLOAD_TIMEOUT_MS,
        });
    } catch (e) {
        logMsg("上传异常：" + e);
        return false;
    }
    if (!res || res.statusCode !== 200) {
        logMsg("上传失败 status=" + (res && res.statusCode) + " body=" + (res && res.body && res.body.string()));
        return false;
    }
    logMsg("上传成功：" + res.body.string());
    try { files.remove(filePath); } catch (e) {}
    return true;
}

function open(p) { return new java.io.File(p); }

// ======== 商店流程（坐标版） ========
function gotoShop() {
    if (!CFG.SHOP_ENTRY_XY) {
        logMsg("未配置 SHOP_ENTRY_XY，无法进商店");
        return false;
    }
    tapPt(CFG.SHOP_ENTRY_XY, "商店入口");
    sleepSec(CFG.AFTER_TAP_WAIT_SEC || 3);
    return true;
}

function captureEachTab() {
    if (!CFG.SHOP_TAB_XYS || CFG.SHOP_TAB_XYS.length === 0) {
        logMsg("未配置 SHOP_TAB_XYS，仅截一张当前商店屏");
        let p = captureToFile("shop_default");
        if (p) uploadImage(p, "shop_default");
        return;
    }
    for (let i = 0; i < CFG.SHOP_TAB_XYS.length; i++) {
        let item = CFG.SHOP_TAB_XYS[i]; // {name: "枪械", xy: [x,y]}
        logMsg("切换 tab：" + item.name);
        tapPt(item.xy, "tab[" + item.name + "]");
        sleepSec(CFG.TAB_WAIT_SEC || 3);

        let p = captureToFile(item.name + "_top");
        if (p) uploadImage(p, item.name + "_top");

        if (CFG.SCROLL_AND_RECAPTURE) {
            // 偏左小幅上滑，规避系统手势
            let cx = device.width * 0.4;
            swipe(cx, device.height * 0.65, cx, device.height * 0.35, 600);
            sleepSec(2);
            let p2 = captureToFile(item.name + "_bottom");
            if (p2) uploadImage(p2, item.name + "_bottom");
        }
    }
}

// ======== 侦察模式：连拍上传，看清游戏流程用于标定坐标 ========
function reconMode() {
    let frames = CFG.RECON_FRAMES || 8;
    let interval = CFG.RECON_INTERVAL_SEC || 5;
    logMsg("侦察模式：每 " + interval + "s 截一帧，共 " + frames + " 帧");

    // 先关弹窗（如果你已经知道叉叉坐标可以先点几下）
    if (CFG.CLOSE_BUTTONS && CFG.CLOSE_BUTTONS.length > 0) {
        logMsg("侦察模式：开始前先点 CLOSE_BUTTONS 关闭可能的弹窗");
        dismissPopups();
    }

    for (let i = 0; i < frames; i++) {
        sleepSec(interval);
        let p = captureToFile("recon_" + (i + 1));
        if (p) uploadImage(p, "recon_" + (i + 1));
    }
    logMsg("侦察模式完成。请去服务器 uploads 目录查看 recon_*.png 标定坐标。");
}

// ======== 主流程 ========
function runOnce() {
    logMsg("=========== runOnce 开始 ===========");
    ensureCaptureReady();
    ensureScreenOn();

    if (CFG.DEBUG_DRY_RUN) {
        logMsg("DEBUG_DRY_RUN：仅截当前屏并上传");
        let p = captureToFile("dryrun");
        if (p) uploadImage(p, "dryrun");
        logMsg("=========== runOnce 完成 (dryrun) ===========");
        return;
    }

    launchGame();
    if (!waitGameReady()) {
        logMsg("游戏启动超时，发送告警截图");
        let p = captureToFile("launch_fail");
        if (p) uploadImage(p, "launch_fail");
        return;
    }

    if (CFG.DEBUG_RECON) {
        reconMode();
        exitGame();
        if (CFG.LOCK_SCREEN_AFTER) lockScreen();
        logMsg("=========== runOnce 完成 (recon) ===========");
        return;
    }

    // 正常模式：关弹窗 → 进商店 → 截图 → 退出
    dismissPopups();
    if (!gotoShop()) {
        let p = captureToFile("no_shop_entry");
        if (p) uploadImage(p, "no_shop_entry");
        exitGame();
        return;
    }
    captureEachTab();
    exitGame();
    if (CFG.LOCK_SCREEN_AFTER) lockScreen();
    logMsg("=========== runOnce 完成 ===========");
}

function nextScheduleDelayMs() {
    let now = new Date();
    let best = null;
    for (let i = 0; i < CFG.SCHEDULE_TIMES.length; i++) {
        let parts = CFG.SCHEDULE_TIMES[i].split(":");
        let hh = parseInt(parts[0], 10);
        let mm = parseInt(parts[1], 10);
        let target = new Date(now);
        target.setHours(hh, mm, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
        if (best === null || target.getTime() < best.getTime()) best = target;
    }
    return best.getTime() - now.getTime();
}

// ======== 入口：子线程跑循环，主线程立即返回，避免 ANR ========
function startScheduler() {
    threads.start(function () {
        logMsg("调度子线程启动，调度时间：" + CFG.SCHEDULE_TIMES.join(", "));

        if (CFG.RUN_ON_START) {
            try {
                logMsg("RUN_ON_START=true，立即执行一次 runOnce");
                runOnce();
            } catch (e) {
                logMsg("首次 runOnce 异常：" + e);
            }
            sleepSec(60);
        }

        while (true) {
            let delay = nextScheduleDelayMs();
            let mins = Math.round(delay / 60000);
            logMsg("下次执行约 " + mins + " 分钟后");
            let chunk = 10 * 60 * 1000;
            while (delay > 0) {
                let s = Math.min(delay, chunk);
                sleepMs(s);
                delay -= s;
            }
            try { runOnce(); } catch (e) { logMsg("runOnce 异常：" + e); }
            sleepSec(70);
        }
    });
}

logMsg("脚本入口加载完成，准备启动调度子线程");
startScheduler();
logMsg("主线程返回；后台调度已运行。");
toast("Arena Shop Monitor 已启动\nRUN_ON_START=" + CFG.RUN_ON_START + "\nRECON=" + CFG.DEBUG_RECON);
