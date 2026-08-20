// 可移植的数据根目录。默认 ~/.king-ppt；Skill 场景可用 KING_PPT_HOME 指向
// 工作区 / scratch 目录，让会话、资源、上传模板随项目走而非落在用户家目录。
const os = require('os');
const path = require('path');

const HOME = process.env.KING_PPT_HOME
  ? path.resolve(process.env.KING_PPT_HOME)
  : path.join(os.homedir(), '.king-ppt');

const SESSIONS_DIR = path.join(HOME, 'sessions');
const ASSETS_DIR = path.join(HOME, 'assets');
const MATERIALS_DIR = path.join(HOME, 'materials'); // 阶段0：用户拖入的参考素材（保留原文件名，供 Agent 直读）
const TEMPLATES_DIR = path.join(HOME, 'templates'); // 上传/自定义模板
const RUNTIME_FILE = path.join(HOME, 'server.json'); // serve 写入 { port, pid }，供 CLI 子命令定位
const CONFIG_FILE = path.join(HOME, 'config.json'); // 单 provider 配置（含 API Key；.gitignore 已排除 .king-ppt/）

module.exports = { HOME, SESSIONS_DIR, ASSETS_DIR, MATERIALS_DIR, TEMPLATES_DIR, RUNTIME_FILE, CONFIG_FILE };
