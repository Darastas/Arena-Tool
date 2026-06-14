/**
 * AutoJs6 端配置 - 部署到手机后修改
 * 路径建议：/sdcard/脚本/arena_shop/config.js
 */
module.exports = {
    // 服务器地址（你的 2GB 云服务器公网 IP / 域名 + 端口）
    SERVER_URL: "http://你的服务器IP:8848",

    // 鉴权 token，必须与 server/config.yaml 一致
    AUTH_TOKEN: "请改成与服务器一致的随机长字符串",

    // 暗区突围包名（如官方包名变更，自行替换）
    GAME_PACKAGE: "com.tencent.cd.bm",

    // 调度时间（24h），数组允许多次。脚本启动后会保持运行直到执行完所有时间点
    SCHEDULE_TIMES: ["05:01", "05:30"],

    // 启动游戏后等待加载的最长秒数
    GAME_LAUNCH_TIMEOUT_SEC: 90,

    // 进入主菜单后到能点击商店的等待秒数（保守一点）
    MAIN_MENU_WAIT_SEC: 8,

    // 商店各分类 tab（按你实际游戏内的中文/英文 tab 文字调整）
    // 脚本会用 textContains 查找这些文字并依次点击+截图
    SHOP_TABS: ["枪械", "护甲", "弹药", "医疗", "其它"],

    // 每个 tab 截图前等待秒数（确保加载完成）
    TAB_WAIT_SEC: 3,

    // 每个 tab 是否做"上滑刷出更多"（true 会上滑 1 次再补一张图）
    SCROLL_AND_RECAPTURE: true,

    // 是否在执行结束后锁屏
    LOCK_SCREEN_AFTER: true,

    // 上传超时（毫秒）
    UPLOAD_TIMEOUT_MS: 60000,

    // 调试：true 时不真正启动游戏，仅截当前屏验证链路
    DEBUG_DRY_RUN: false,
};
