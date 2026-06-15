/**
 * AutoJs6 端配置 - 部署到手机后修改
 * 路径建议：/sdcard/脚本/arena_shop/config.js
 *
 * 坐标系：[x, y] 0~1 之间视为相对屏幕百分比，自动乘以 device.width/height
 *   [0.5, 0.5] = 屏幕正中心；[0.95, 0.33] = 横向 95%、纵向 33%
 */
module.exports = {
    // ====== 服务器（必填） ======
    SERVER_URL: "http://101.33.228.81:8848",
    AUTH_TOKEN: "你的真实token",            // 改成 config.yaml 里那串
    UPLOAD_TIMEOUT_MS: 60000,

    // ====== 游戏包名 ======
    GAME_PACKAGE: "com.tencent.cd.bm",       // 你已确认过的暗区包名

    // ====== 调度 ======
    SCHEDULE_TIMES: ["05:01", "05:30"],
    RUN_ON_START: true,                      // 启动后立即跑一次（测试期开）

    // ====== 调试模式（都 false = 正式模式） ======
    DEBUG_DRY_RUN: false,
    DEBUG_RECON: false,

    RECON_FRAMES: 8,
    RECON_INTERVAL_SEC: 5,

    // ====== 启动 / 加载等待 ======
    GAME_LAUNCH_TIMEOUT_SEC: 90,
    MAIN_MENU_WAIT_SEC: 12,                  // 暗区主菜单加载，给足 12s
    AFTER_TAP_WAIT_SEC: 4,                   // 点击后等待页面切换
    TAB_WAIT_SEC: 4,

    // ====== 关弹窗坐标 ======
    // 暗区启动后可能有公告弹窗，叉叉一般在右上角
    CLOSE_BUTTONS: [
        [0.97, 0.07],     // 通用右上角叉叉
    ],
    CLOSE_POPUP_ROUNDS: 2,

    // ====== 商城入口（图一红圈：右侧中部） ======
    SHOP_ENTRY_XY: [0.95, 0.33],

    // ====== 商城内分类（图二红圈：左侧"每日商店"） ======
    SHOP_TAB_XYS: [
        { name: "每日商店", xy: [0.08, 0.53] },
        // 想监控更多分类就加（左侧菜单各项）：
        // { name: "当期热卖", xy: [0.08, 0.20] },
        // { name: "时装近战", xy: [0.08, 0.28] },
        // { name: "盲盒活动", xy: [0.08, 0.36] },
        // { name: "枪械涂装", xy: [0.08, 0.44] },
        // { name: "装扮券理财", xy: [0.08, 0.62] },
    ],

    // 商店内一屏看不全时，再上滑截一次。商品横排 4 件，一般不需要
    SCROLL_AND_RECAPTURE: false,

    // 执行结束后是否锁屏
    LOCK_SCREEN_AFTER: false,                // 调试时先 false
};
