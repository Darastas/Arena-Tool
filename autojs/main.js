/**
 * 暗区商店监控 - AutoJs6 主流程（base64 上传版）
 *
 * 路径建议：/sdcard/脚本/arena_shop/main.js（与 config.js 同目录）
 *
 * 模式（在 config.js 切换）：
 *   - DEBUG_DRY_RUN: 仅截当前屏 + 上传，验证手机到服务器链路
 *   - DEBUG_RECON:   启动游戏 → 每隔 RECON_INTERVAL_SEC 秒截一帧
 *   - 正常模式（两者都 false）: 启动 → 关弹窗 → 进商店 → 截各 tab → 退出
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

    // 多重杀进程：force-stop + kill + 清理后台
    let pkg = CFG.GAME_PACKAGE;
    let attempts = [
        "am force-stop " + pkg,
        "am kill " + pkg,
        "am stopservice " + pkg + "/.MainService",
    ];
    for (let i = 0; i < attempts.length; i++) {
        try {
            let r = shell(attempts[i], false);
            logMsg("kill 命令: " + attempts[i] + " -> rc=" + (r && r.code));
        } catch (e) {
            logMsg("kill 命令异常（忽略）：" + e);
        }
    }

    // 通过最近任务移除（API 21+）
    try {
        let am = context.getSystemService(android.content.Context.ACTIVITY_SERVICE);
        let tasks = am.getAppTasks();
        if (tasks) {
            for (let i = 0; i < tasks.size(); i++) {
                try {
                    let t = tasks.get(i);
                    let info = t.getTaskInfo();
                    if (info && info.baseActivity &&
                        String(info.baseActivity.getPackageName()) === pkg) {
                        t.finishAndRemoveTask();
                        logMsg("已通过 AppTask.finishAndRemoveTask 移除暗区");
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        logMsg("AppTask 清理失败（忽略）：" + e);
    }

    sleepMs(500);
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

// ======== 截图（带自动重申请权限） ========
var _captureReady = false;
function ensureCaptureReady() {
    if (_captureReady) return;
    let ok = false;
    try {
        // 第二个参数 true 表示横屏，不会弹"选择屏幕"对话框
        // 部分 AutoJs6 版本签名不同，回退到无参版本
        if (device.width > device.height) {
            ok = requestScreenCapture(true);
        } else {
            ok = requestScreenCapture();
        }
    } catch (e) {
        logMsg("requestScreenCapture(landscape) 异常，回退普通模式：" + e);
        try { ok = requestScreenCapture(); } catch (e2) {
            logMsg("requestScreenCapture() 仍异常：" + e2);
        }
    }
    if (!ok) {
        toast("用户拒绝截图权限或已取消");
        logMsg("截图权限被拒绝，退出");
        exit();
    }
    _captureReady = true;
    sleepMs(500);
}

function reacquireCapture() {
    logMsg("MediaProjection token 失效，重新申请截图权限");
    _captureReady = false;
    try {
        if (typeof stopScreenCapture !== "undefined") stopScreenCapture();
    } catch (e) {}
    sleepMs(500);
    ensureCaptureReady();
}

// 主动停止屏幕录制（流程结束后调用，去掉系统"录屏中"通知）
function releaseCapture() {
    // 先等 1.5 秒：防止截图数据还在传，同时给系统状态刷新的时间
    sleepMs(1500);
    // 尝试多种停止方式（不同 AutoJs6 版本 API 命名不同）
    let stopped = false;
    try {
        if (typeof stopScreenCapture !== "undefined") {
            stopScreenCapture();
            stopped = true;
            logMsg("已释放截图权限（方式A: stopScreenCapture）");
        }
    } catch (e) { logMsg("方式A停止失败：" + e); }

    if (!stopped) {
        try {
            if (typeof stopScreen !== "undefined") {
                stopScreen();
                stopped = true;
                logMsg("已释放截图权限（方式B: stopScreen）");
            }
        } catch (e) { logMsg("方式B停止失败：" + e); }
    }

    if (!stopped) {
        try {
            // 终极手段：反射调用内部 API 停
            let runtime = $runtime;
            let screencap = runtime.getScreenCaptureRequester();
            if (screencap && screencap.stopScreenCapture) {
                screencap.stopScreenCapture();
                logMsg("已释放截图权限（方式C: 反射）");
            }
        } catch (e) {
            logMsg("方式C反射停止失败（忽略）：" + e);
        }
    }
    _captureReady = false;
    sleepMs(500);
}

function tryCaptureScreen() {
    let img = null;
    try { img = captureScreen(); } catch (e) {
        logMsg("captureScreen 第 1 次异常：" + e);
        try {
            reacquireCapture();
            img = captureScreen();
        } catch (e2) {
            logMsg("captureScreen 第 2 次仍异常：" + e2);
        }
    }
    return img;
}

function captureToFile(tag) {
    let img = tryCaptureScreen();
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

// ======== 上传（base64+JSON 方案，100% 兼容） ========
function uploadImage(filePath, tabName) {
    logMsg("上传 " + filePath + " tab=" + tabName);
    let res;
    try {
        // 读文件转 base64
        let bytes = files.readBytes(filePath);
        let b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
        logMsg("图片 base64 长度: " + b64.length);

        res = http.postJson(CFG.SERVER_URL + "/upload_b64", {
            tab: tabName,
            token: CFG.AUTH_TOKEN,
            image_b64: b64,
        }, {
            headers: { "X-Auth-Token": CFG.AUTH_TOKEN },
            timeout: CFG.UPLOAD_TIMEOUT_MS,
        });
    } catch (e) {
        logMsg("上传异常：" + e);
        return false;
    }
    if (!res || res.statusCode !== 200) {
        let body = "";
        try { body = res && res.body && res.body.string(); } catch(e) {}
        logMsg("上传失败 status=" + (res && res.statusCode) + " body=" + body);
        return false;
    }
    let body = "";
    try { body = res.body.string(); } catch(e) {}
    logMsg("上传成功：" + body);
    try { files.remove(filePath); } catch (e) {}
    return true;
}

// ======== 商店流程（坐标版） ========
function gotoShop() {
    if (!CFG.SHOP_ENTRY_XY) {
        logMsg("未配置 SHOP_ENTRY_XY，无法进商店");
        return false;
    }
    tapPt(CFG.SHOP_ENTRY_XY, "商店入口");
    sleepSec(CFG.AFTER_TAP_WAIT_SEC || 4);
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
        let item = CFG.SHOP_TAB_XYS[i];
        logMsg("切换 tab：" + item.name);
        tapPt(item.xy, "tab[" + item.name + "]");
        sleepSec(CFG.TAB_WAIT_SEC || 4);

        let p = captureToFile(item.name + "_top");
        if (p) uploadImage(p, item.name + "_top");

        if (CFG.SCROLL_AND_RECAPTURE) {
            let cx = device.width * 0.4;
            swipe(cx, device.height * 0.65, cx, device.height * 0.35, 600);
            sleepSec(2);
            let p2 = captureToFile(item.name + "_bottom");
            if (p2) uploadImage(p2, item.name + "_bottom");
        }
    }
}

// ======== 侦察模式 ========
function reconMode() {
    let frames = CFG.RECON_FRAMES || 8;
    let interval = CFG.RECON_INTERVAL_SEC || 5;
    logMsg("侦察模式：每 " + interval + "s 截一帧，共 " + frames + " 帧");
    if (CFG.CLOSE_BUTTONS && CFG.CLOSE_BUTTONS.length > 0) {
        dismissPopups();
    }
    for (let i = 0; i < frames; i++) {
        sleepSec(interval);
        let p = captureToFile("recon_" + (i + 1));
        if (p) uploadImage(p, "recon_" + (i + 1));
    }
}

// ======== 主流程 ========
function runOnce() {
    logMsg("=========== runOnce 开始 ===========");
    try {
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
    } finally {
        // 无论流程是否成功，都释放屏幕录制权限，去掉系统"录屏中"通知
        releaseCapture();
    }
}

// ======== 入口 ========
// 注意：本脚本只执行一次，然后退出。
// 定时请使用 AutoJs6 自带“定时任务/闹钟”分别设置 05:01、05:30 运行 main.js。
// 不要在脚本内部长循环等待，否则 AutoJs6 会在重启脚本时重置倒计时。
logMsg("脚本启动：执行一次 runOnce");
try {
    runOnce();
} catch (e) {
    logMsg("runOnce 异常：" + e);
} finally {
    logMsg("脚本结束，退出");
    toast("Arena Shop Monitor 执行完成");
    exit();
}
