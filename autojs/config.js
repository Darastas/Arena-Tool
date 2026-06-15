/**
 * AutoJs6 端配置 - 部署到手机后修改
 * 路径建议：/sdcard/脚本/arena_shop/config.js
 *
 * 坐标系说明：
 *   绝对像素 [x, y]：手机屏幕的实际像素坐标，例如 [1080, 1920]
 *   相对比例 [0.5, 0.5]：屏幕百分比，0~1 之间视为比例，自动乘以 device.width/height
 *     - [0.5, 0.5] = 屏幕正中心
 *     - [0.5, 0.1] = 横向居中、纵向 10% 处
 *     强烈推荐用相对比例，分辨率变了不用改
 *
 * 调试流程（推荐）：
 *   1. DEBUG_RECON = true → 跑一次 main.js → 8 张侦察图传到服务器
 *   2. 去服务器 uploads 目录看 recon_*.png，记下"商店按钮""枪械 tab"等位置
 *   3. 把坐标填到下方对应字段（推荐用相对比例）
 *   4. DEBUG_RECON = false, DEBUG_DRY_RUN = false → 正式跑
 */
module.exports = {
    // ====== 服务器 ======
    SERVER_URL: "http://你的服务器IP:8848",
    AUTH_TOKEN: "和服务器config.yaml保持一致的token",
    UPLOAD_TIMEOUT_MS: 60000,

    // ====== 游戏包名 ======
    // 用 ADB 查：adb shell pm list packages | grep -i bm
    GAME_PACKAGE: "com.tencent.cd.bm",

    // ====== 调度 ======
    SCHEDULE_TIMES: ["05:01", "05:30"],
    // 启动脚本立即跑一次（测试用），验证通过后改 false
    RUN_ON_START: true,

    // ====== 调试模式（三选一：DRY_RUN / RECON / 都 false = 正常） ======
    // 第一个 true 测试都关掉，调成 false 才开始真实扫描
    DEBUG_DRY_RUN: false,    // 仅截当前屏 + 上传，验证链路
    DEBUG_RECON: true,       // 启动游戏后每 5 秒截一帧，共 8 帧（用于标定坐标）

    // 侦察模式参数
    RECON_FRAMES: 8,         // 连拍多少帧
    RECON_INTERVAL_SEC: 5,   // 帧间隔秒数

    // ====== 启动 / 加载等待 ======
    GAME_LAUNCH_TIMEOUT_SEC: 90,  // 启动超时
    MAIN_MENU_WAIT_SEC: 8,        // 启动后等多久算进主菜单
    AFTER_TAP_WAIT_SEC: 3,        // 每次点击后等多久（页面加载）
    TAB_WAIT_SEC: 3,              // 切换 tab 后等多久截图

    // ====== 弹窗关闭按钮坐标 ======
    // 游戏启动后一般有 1-2 个公告/签到弹窗，每个右上角有个"X"叉叉
    // 大多数游戏公告 X 都在屏幕右上角（约 95% 横向, 15% 纵向）
    // ⚠️ 先填一个右上角坐标跑一次 RECON 看实际位置，再回来微调
    CLOSE_BUTTONS: [
        [0.92, 0.12],  // 第一个弹窗叉叉（右上角偏内）
    ],
    // 每个弹窗可能有两层（如"知道了""领取"），多点击几次
    CLOSE_POPUP_ROUNDS: 3,

    // ====== 商店入口坐标 ======
    // ⚠️ 必须先用 RECON 模式看清楚再填！
    // 暗区主菜单底部通常有任务/仓库/商店/市场等 tab 按钮
    // 假设"商店"在底部靠右，约 [0.85, 0.93]
    SHOP_ENTRY_XY: [0.85, 0.93],

    // ====== 商店内分类 tab 坐标 ======
    // 进入商店后顶部通常有：枪械/护甲/弹药/医疗/其它 等分类
    // ⚠️ 必须用 RECON 模式确认实际位置后填！
    // 假设 5 个 tab 平均分布，y 约 0.15，x 从 0.1 到 0.9
    SHOP_TAB_XYS: [
        { name: "枪械", xy: [0.2, 0.15] },
        { name: "护甲", xy: [0.4, 0.15] },
        { name: "弹药", xy: [0.6, 0.15] },
        { name: "医疗", xy: [0.8, 0.15] },
    ],

    // 每个 tab 截图后再上滑一次截下半场（看到更多物品）
    // 如果上滑被识别为系统手势，可关闭
    SCROLL_AND_RECAPTURE: false,

    // 执行结束后是否锁屏
    LOCK_SCREEN_AFTER: false,  // 调试时先 false，测试通过再 true
};
