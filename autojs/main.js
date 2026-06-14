/**
 * 暗区商店监控 - AutoJs6 主流程
 *
 * 部署：
 *   1. 安装 AutoJs6 (https://github.com/SuperMonster003/AutoJs6)
 *   2. 授予无障碍服务、悬浮窗、截图、电池保活、自启动 等权限
 *   3. 把 main.js 与 config.js 放入同一目录（如 /sdcard/脚本/arena_shop/）
 *   4. 在 AutoJs6 中长按 main.js -> 设置定时任务 -> 启用 "开机启动 + 守护进程"
 *
 * 也可以把 SCHEDULE_TIMES 留空，改用 AutoJs6 自带的定时任务系统。
 */
"ui";

const CFG = require("./config.js");

// ======== 工具函数 ========
function ts() { return new Date().toLocaleString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function sleep(sec) { sleep_ms(sec * 1000); }
function sleep_ms(ms) { java.lang.Thread.sleep(ms); }

function ensureScreenOn() {
    if (!device.isScreenOn()) {
        device.wakeUp();
        sleep(1);
    }
    // 简单上滑解锁（无密码场景）。如有密码，手动设为脸/指纹解锁后开屏即停留在桌面
    swipe(device.width / 2, device.height * 0.85, device.width / 2, device.height * 0.2, 400);
    sleep(1);
}

function lockScreen() {
    try { device.cancelKeepingAwake(); } catch (e) {}
    try {
        // 需要无障碍开启
        if (typeof lockNow !== "undefined") {
            lockNow();
        }
    } catch (e) {
        log("锁屏失败（忽略）：" + e);
    }
}

function launchGame() {
    log("启动暗区突围 " + CFG.GAME_PACKAGE);
    let ok = launch(CFG.GAME_PACKAGE);
    if (!ok) {
        log("launch() 失败，尝试 app.launchPackage");
        app.launchPackage(CFG.GAME_PACKAGE);
    }
}

function waitGameReady() {
    let deadline = Date.now() + CFG.GAME_LAUNCH_TIMEOUT_SEC * 1000;
    while (Date.now() < deadline) {
        if (currentPackage() === CFG.GAME_PACKAGE) {
            // 简单：再等几秒确保画面加载
            sleep(CFG.MAIN_MENU_WAIT_SEC);
            return true;
        }
        sleep(1);
    }
    return false;
}

function exitGame() {
    log("退出游戏");
    home();
    sleep(1);
    try {
        // 后台清理：模拟最近任务键 + 上滑（不同 ROM 操作不一样，这里仅尝试 force-stop）
        shell("am force-stop " + CFG.GAME_PACKAGE, true);
    } catch (e) {
        log("force-stop 失败（非 root 设备会失败，但 home 已生效）：" + e);
    }
}

// ======== 截图 ========
function ensureCaptureReady() {
    if (!requestScreenCapture()) {
        toast("用户拒绝截图权限");
        log("截图权限被拒绝");
        exit();
    }
}

function captureToFile(tag) {
    let img = captureScreen();
    if (!img) {
        log("截图失败 tag=" + tag);
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
    log("上传 " + filePath + " tab=" + tabName);
    let res;
    try {
        res = http.postMultipart(CFG.SERVER_URL + "/upload", {
            file: ["image", open(filePath)],
            tab: tabName,
            token: CFG.AUTH_TOKEN,
        }, {
            headers: { "X-Auth-Token": CFG.AUTH_TOKEN },
            timeout: CFG.UPLOAD_TIMEOUT_MS,
        });
    } catch (e) {
        log("上传异常：" + e);
        return false;
    }
    if (!res || res.statusCode !== 200) {
        log("上传失败 status=" + (res && res.statusCode));
        return false;
    }
    log("上传成功：" + res.body.string());
    // 上传成功后删除本地缓存，节省手机空间
    try { files.remove(filePath); } catch (e) {}
    return true;
}

// 注意：postMultipart 在不同 AutoJs6 版本 API 略不同。
// 这里提供 open 的 helper，避免外层报错。
function open(p) {
    // AutoJs6 的 http.postMultipart 接收 [filename, java.io.File] 或 path 字符串
    // 直接传字符串路径在多数版本可用
    return new java.io.File(p);
}

// ======== 商店流程 ========
function clickShopEntry() {
    // 商店入口在主菜单不同位置，常见 tab/按钮文字："商店" / "Shop"
    let candidates = ["商店", "Shop", "商铺"];
    for (let kw of candidates) {
        let v = textContains(kw).findOne(2000);
        if (v) {
            log("点击主菜单：" + kw);
            v.click();
            sleep(3);
            return true;
        }
    }
    log("未找到商店入口，尝试盲点（需自行用坐标补充）");
    return false;
}

function captureEachTab() {
    for (let tab of CFG.SHOP_TABS) {
        log("处理 tab：" + tab);
        let v = textContains(tab).findOne(3000);
        if (!v) {
            log("找不到 tab " + tab + "，跳过");
            continue;
        }
        v.click();
        sleep(CFG.TAB_WAIT_SEC);

        let p = captureToFile(tab + "_top");
        if (p) uploadImage(p, tab + "_top");

        if (CFG.SCROLL_AND_RECAPTURE) {
            swipe(device.width / 2, device.height * 0.75, device.width / 2, device.height * 0.25, 600);
            sleep(2);
            let p2 = captureToFile(tab + "_bottom");
            if (p2) uploadImage(p2, tab + "_bottom");
        }
    }
}

// ======== 主流程 ========
function runOnce() {
    log("=========== runOnce 开始 ===========");
    ensureCaptureReady();
    ensureScreenOn();

    if (CFG.DEBUG_DRY_RUN) {
        log("DEBUG_DRY_RUN：仅截当前屏并上传");
        let p = captureToFile("dryrun");
        if (p) uploadImage(p, "dryrun");
        return;
    }

    launchGame();
    if (!waitGameReady()) {
        log("游戏启动超时，发送告警截图");
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
    log("=========== runOnce 完成 ===========");
}

function nextScheduleDelayMs() {
    // 计算到下一个 SCHEDULE_TIMES 的毫秒数
    let now = new Date();
    let best = null;
    for (let t of CFG.SCHEDULE_TIMES) {
        let [hh, mm] = t.split(":").map(Number);
        let target = new Date(now);
        target.setHours(hh, mm, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
        if (best === null || target.getTime() < best.getTime()) best = target;
    }
    return best.getTime() - now.getTime();
}

function main() {
    log("脚本启动，调度时间：" + CFG.SCHEDULE_TIMES.join(", "));
    while (true) {
        let delay = nextScheduleDelayMs();
        log("下次执行倒计时（毫秒）：" + delay);
        sleep_ms(delay);
        try {
            runOnce();
        } catch (e) {
            log("runOnce 异常：" + e);
        }
        // 防止极小的时钟漂移导致同一分钟反复触发
        sleep(70);
    }
}

main();
