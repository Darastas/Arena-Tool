/**
 * 暗区商店监控 - AutoJs6 主流程
 *
 * 部署：
 *   1. 安装 AutoJs6 (https://github.com/SuperMonster003/AutoJs6)
 *   2. 授予无障碍服务、悬浮窗、截图、电池保活、自启动 等权限
 *   3. 把 main.js 与 config.js 放入同一目录（如 /sdcard/脚本/arena_shop/）
 *   4. 在 AutoJs6 里直接运行 main.js（不要选"以 UI 模式运行"）
 *
 * 改动说明：
 *   - 不再使用 "ui" 模式，避免主线程 sleep 数小时导致 ANR
 *   - 调度循环放到 threads.start() 里跑
 *   - 提供 RUN_ON_START 配置，启动脚本立即跑一次，便于测试
 */

const CFG = require("./config.js");

// ======== 工具函数 ========
function ts() { return new Date().toLocaleString(); }
function logMsg(msg) { console.log("[" + ts() + "] " + msg); }
function sleepSec(sec) { java.lang.Thread.sleep(sec * 1000); }
function sleepMs(ms) { java.lang.Thread.sleep(ms); }

// ======== 屏幕 / 锁屏 ========
function ensureScreenOn() {
    if (!device.isScreenOn()) {
        logMsg("屏幕熄灭，唤醒中...");
        device.wakeUp();
        sleepSec(1);
    }
    // 简单上滑解锁（无密码场景）。如有密码，请用脸/指纹解锁
    swipe(device.width / 2, device.height * 0.85, device.width / 2, device.height * 0.2, 400);
    sleepSec(1);
}

function lockScreen() {
    try { device.cancelKeepingAwake(); } catch (e) {}
    try {
        if (typeof lockNow !== "undefined") {
            lockNow();
        }
    } catch (e) {
        logMsg("锁屏失败（忽略）：" + e);
    }
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

// ======== 截图 ========
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

// ======== 上传 ========
function uploadImage(filePath, tabName) {
    logMsg("上传 " + filePath + " tab=" + tabName);
    let res;
    try {
        // AutoJs6 多版本兼容写法：直接传文件路径字符串
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

function open(p) {
    return new java.io.File(p);
}

// ======== 商店流程 ========
function clickShopEntry() {
    let candidates = ["商店", "Shop", "商铺", "商城"];
    for (let i = 0; i < candidates.length; i++) {
        let kw = candidates[i];
        let v = textContains(kw).findOne(2000);
        if (v) {
            logMsg("点击主菜单：" + kw);
            v.click();
            sleepSec(3);
            return true;
        }
    }
    logMsg("未找到商店入口");
    return false;
}

function captureEachTab() {
    for (let i = 0; i < CFG.SHOP_TABS.length; i++) {
        let tab = CFG.SHOP_TABS[i];
        logMsg("处理 tab：" + tab);
        let v = textContains(tab).findOne(3000);
        if (!v) {
            logMsg("找不到 tab " + tab + "，跳过");
            continue;
        }
        v.click();
        sleepSec(CFG.TAB_WAIT_SEC);

        let p = captureToFile(tab + "_top");
        if (p) uploadImage(p, tab + "_top");

        if (CFG.SCROLL_AND_RECAPTURE) {
            swipe(device.width / 2, device.height * 0.75, device.width / 2, device.height * 0.25, 600);
            sleepSec(2);
            let p2 = captureToFile(tab + "_bottom");
            if (p2) uploadImage(p2, tab + "_bottom");
        }
    }
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

    if (!clickShopEntry()) {
        let p = captureToFile("no_shop_entry");
        if (p) uploadImage(p, "no_shop_entry");
        exitGame();
        return;
    }

    captureEachTab();

    exitGame();
    if (CFG.LOCK_SCREEN_AFTER) {
        lockScreen();
    }
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

// ======== 入口：用子线程跑循环，主线程立刻返回，避免 ANR ========
function startScheduler() {
    threads.start(function () {
        logMsg("调度子线程启动，调度时间：" + CFG.SCHEDULE_TIMES.join(", "));

        // 启动时立即跑一次（用于测试和首次部署）
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
            logMsg("下次执行约 " + mins + " 分钟后（" + delay + " ms）");
            // 最多 sleep 10 分钟一段，便于日志可观察 + 退出时反应快
            let chunk = 10 * 60 * 1000;
            while (delay > 0) {
                let s = Math.min(delay, chunk);
                sleepMs(s);
                delay -= s;
            }
            try {
                runOnce();
            } catch (e) {
                logMsg("runOnce 异常：" + e);
            }
            sleepSec(70); // 防止同一分钟重复触发
        }
    });
}

// 启动调度（不在主线程做任何 sleep，避免 ANR）
logMsg("脚本入口加载完成，准备启动调度子线程");
startScheduler();
logMsg("主线程返回；后台调度已运行。可以从悬浮窗或控制台查看日志。");

// 给一个简单提示
toast("Arena Shop Monitor 已启动\nRUN_ON_START=" + CFG.RUN_ON_START);
