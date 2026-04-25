require('dotenv').config();
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const MineBlocks = require('./actions/resource/MineBlocks');
const AutoEat = require('./instincts/AutoEat');
const AutoDefend = require('./instincts/AutoDefend');
const AutoTool = require('./instincts/AutoTool');
const StateMachine = require('./core/StateMachine');
const AutoDump = require('./instincts/AutoDump'); // 新增
const AutoTeleportAndLogin = require('./instincts/autoTeleportAndLogin');
const LLMService = require('./services/LLMService'); // 新增

const fs = require('fs');
const path = require('path');
const pluginsDir = path.join(__dirname, '../plugins');
let PLUGIN_ACTIONS_PROMPT = "";
let pluginIndex = 24;
global.registeredPlugins = {};

if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
}

fs.readdirSync(pluginsDir).forEach(file => {
    if (file.endsWith('.js')) {
        try {
            const plugin = require(path.join(pluginsDir, file));
            if (plugin.actionName && plugin.description) {
                PLUGIN_ACTIONS_PROMPT += `${pluginIndex}. ${plugin.actionName} (${plugin.description})\n`;
                if (plugin.params) PLUGIN_ACTIONS_PROMPT += `   - params: ${JSON.stringify(plugin.params)}\n`;
                if (plugin.condition) PLUGIN_ACTIONS_PROMPT += `   - condition: ${JSON.stringify(plugin.condition)}\n`;
                if (plugin.objective) PLUGIN_ACTIONS_PROMPT += `   - objective: ${JSON.stringify(plugin.objective)}\n`;
                
                global.registeredPlugins[plugin.actionName] = plugin.actionClass;
                console.log(`[Plugin] 成功加载技能插件: ${plugin.actionName}`);
                pluginIndex++;
            }
        } catch (err) {
            console.error(`[Plugin] 加载插件 ${file} 失败:`, err);
        }
    }
});

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const toolPlugin = require('mineflayer-tool').plugin;
const GoTo = require('./actions/move/GoTo');
const { sendToOwner } = require('./utils/chat');
const readline = require('readline');

// 调试日志函数
function debugLog(...args) {
    if (process.env.DEBUG_MODE === 'true') {
        console.log('[Debug]', ...args);
    }
}

const bot = mineflayer.createBot({
    host: process.env.MC_HOST,
    port: parseInt(process.env.MC_PORT),
    username: process.env.MC_USERNAME,
    auth: process.env.MC_AUTH_TYPE || 'offline',
    version: process.env.MC_VERSION || '1.20.1',
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    if (bot && bot.entity) {
        bot.chat(text);
        console.log(`[Console] 机器人已发送: ${text}`);
    } else {
        console.log(`[Console] 机器人尚未登录，无法发送: ${text}`);
    }
});
console.log(`[System] 正在连接到 ${process.env.MC_HOST || 'localhost'}:${process.env.MC_PORT || 25565} as ${process.env.MC_USERNAME}...`);

bot.loadPlugin(pathfinder);
bot.loadPlugin(toolPlugin);
bot.loadPlugin(collectBlockPlugin);

// ============================================
// 挂载被动本能（在 spawn 之前初始化以捕获登录事件）
// ============================================

// 1. 自动传送与登录 (必须在 spawn 之前挂载)
if (process.env.INSTINCT_AUTO_TP_LOGIN === 'true') {
    const autoTPLogin = new AutoTeleportAndLogin(bot, {
        ownerName: process.env.MC_OWNER_NAME,
        loginPassword: process.env.MC_LOGIN_PASSWORD,
        loginDelay: 5000,
        freezeBeforeAccept: 300,
        freezeAfterAccept: 1200,
        backDelay: 2000,
        acceptCommand: '/tpaccept',
        backCommand: '/back',
        debug: true,
    });
    autoTPLogin.mount();
}

let isThinking = false; 
let currentAction = null;
let stateMachine = null;
const chatHistory = []; // 存储最近10条对话历史 {user, summary}

const SYSTEM_PROMPT = `# Role
你是一个运行在 Minecraft 服务器上的 AI 机器人助手。你的核心任务是将玩家的自然语言指令转化为严格的 JSON 自动化执行计划。

# Constraints (严格约束)
1. 你的唯一输出格式是 JSON。
2. 绝对禁止输出任何解释性文字、问候语或 Markdown 代码块标记。
3. 你的回复必须直接以 "{" 开头，以 "}" 结尾。
4. 绝对禁止编造不存在的动作类型（Action）或物品 ID，现有action做不到请对玩家说做不到。

# Output Format (输出数据结构)
{
  "reply": "对玩家说的话（必填，不能为空，简短回应）",
  "action": "none | modify_plan | replace_plan | stop",
  "todo_list": [
    {
      "task_name": "中文描述",
      "action": "动作类型（严格从下方列表中选择）",
      "params": {},
      "condition": {},
      "objective": {}
    }
  ]
}

- action 字段说明：
  - none：只回答，不改计划，todo_list 必须为 []
  - modify_plan：在未执行计划末尾追加任务
  - replace_plan：丢弃所有未执行任务，重新规划
  - stop：仅当玩家明确说"停止/取消/别干了"时使用，清空计划，todo_list 必须为 []

# Actions Dictionary (支持的动作库)
1. GoTo (移动到坐标。禁止用于移动到玩家位置)
   - params: { "coords": [x, y, z], "range": 2 }
2. MineBlocks (挖掘方块)
   - params: { "block_name": "方块ID", "count": 数量, "radius": 32 }
   - objective: { "gather_items": { "掉落物ID": 数量 } }
3. CraftItem (合成物品)
   - params: { "item_name": "物品ID", "count": 数量 }
   - condition: { "has_items": { "所需材料ID": 数量 } }
   - objective: { "craft_items": { "物品ID": 数量 } }
4. SmeltItem (烧制物品)
   - params: { "input_item": "原料ID", "fuel_item": "燃料ID", "count": 数量 }
   - condition: { "has_items": { "原料ID": 数量, "燃料ID": 数量 } }
   - objective: { "gather_items": { "产物ID": 数量 } }
5. PlaceBlock (放置方块)
   - params: { "block_name": "方块ID", "coords": "player_feet", "facing": "up" }
   - condition: { "has_items": { "方块ID": 1 } }
   - objective: {}
6. ClearArea (挖空区域)
   - params: { "pos1": {"x":0,"y":64,"z":0}, "pos2": {"x":10,"y":70,"z":10} }
   - objective: {}
7. FillArea (填充区域)
   - params: { "block_name": "方块ID", "pos1": {"x":0,"y":64,"z":0}, "pos2": {"x":10,"y":64,"z":10} }
   - condition: { "has_items": { "方块ID": 区域体积总数 } }
   - objective: {}
8. Command (发送消息或执行指令)
   - params: { "command": "内容" } (以 / 开头为指令，否则为聊天)
   - objective: {}
9. TeleportRequest (向玩家发起 TPA)
   - params: { "target": "玩家ID", "timeout": 60000 }
   - objective: {}
10. FarmAction (种植作物)
   - params: { "crop_name": "作物ID" }
   - condition: { "has_items": { "种子ID": 1 } }
11. DropItemAction (丢弃物品)
   - params: { "item_name": "物品ID", "count": 数量(-1为全部扔出) }
   - condition: { "has_items": { "物品ID": 数量 } }
12. BreedAnimalAction (繁殖动物)
   - params: { "animal_name": "动物ID" }
   - condition: { "has_items": { "该动物的食物ID": 2 } }
13. KillEntityAction (击杀实体)
   - params: { "entity_name": "实体ID" }
   - objective: {}
14. PvpAction (PVP)
   - params: { "target_name": "玩家ID" }
   - objective: {}
15. StoreItemAction (存储物品)
   - params: { "item_names": ["物品ID1", "物品ID2"], "radius": 20 } (留空item_names为清空背包存储)
   - objective: {}
16. PatrolAction (巡逻)
   - params: { "radius": 30, "timeout": 15000 }
   - objective: {}
17. ShearSheepAction（剪羊毛）
   - params: { "radius": 16, "collect_radius": 10, "loop": false, "loop_interval": 2500, "approach_distance": 2, "sheep_cooldown_ms": 30000, "debug": false }
18. BuildGediaoAction（建玩家口中的“格调”）
   - params: {}
   - objective: {}
19. TakeItemsAction（从最近的箱子取物品）
   - params: { "item_names": ["物品ID1", "物品ID2"], "radius": 20, "keep_empty_slots": 5 } (留空item_names为全取模式)
   - objective: {}
20. FollowPlayer（跟随玩家）
   - params: { "player_name": "${process.env.MC_OWNER_NAME}", "min_distance": 2, "max_distance": 5 }
   - objective: {}
21. DelayAction（延迟）
   - params: { "seconds": 1000 }
   - objective: {}
22. BoneMealAction（骨粉催熟附近作物）
   - params: { "radius": 20 }
   - condition: { "has_items": { "bone_meal": 1 } }
   - objective: {}
23. FishAction（挂机钓鱼）
   - params: {}
   - condition: { "has_items": { "fishing_rod": 1 } }
${PLUGIN_ACTIONS_PROMPT}
# Planning Rules (规划原则)
1. 前置依赖逻辑：
   - 合成需要工作台的物品前，必须先 [PlaceBlock] 放置工作台。
   - 烧制物品前，必须先 [PlaceBlock] 放置熔炉。
2. 矿物掉落物映射表（MineBlocks 的 objective 必须写掉落物）：
   - iron_ore -> raw_iron
   - coal_ore -> coal
   - gold_ore -> raw_gold
   - diamond_ore -> diamond
   - oak_log -> oak_log
   - cobblestone -> cobblestone
3. 特殊触发器：
   - 当玩家说“过来”、“来我这”时，必须使用 TeleportRequest。当玩家说“跟随我”的时候再考虑使用FollowPlayer。你的主人默认是 "${process.env.MC_OWNER_NAME}"。

# Reply Style (回复风格约束)
${process.env.AI_STYLE_PROMPT || "直接以助手身份回答，保持简洁。"}

# Examples (学习示例)

User: "过来一下"
{
  "reply": "好的主人，正在发送传送请求！",
  "action": "replace_plan",
  "todo_list": [
    {
      "task_name": "传送到主人身边",
      "action": "TeleportRequest",
      "params": { "target": "${process.env.MC_OWNER_NAME}", "timeout": 60000 },
      "condition": {},
      "objective": {}
    }
  ]
}

User: "帮我弄3个铁锭"
{
  "reply": "收到，我这就去挖铁矿并烧制3个铁锭。",
  "action": "replace_plan",
  "todo_list": [
    {
      "task_name": "挖掘3个铁矿石",
      "action": "MineBlocks",
      "params": { "block_name": "iron_ore", "count": 3, "radius": 32 },
      "condition": {},
      "objective": { "gather_items": { "raw_iron": 3 } }
    },
    {
      "task_name": "挖掘1个煤炭作为燃料",
      "action": "MineBlocks",
      "params": { "block_name": "coal_ore", "count": 1, "radius": 32 },
      "condition": {},
      "objective": { "gather_items": { "coal": 1 } }
    },
    {
      "task_name": "放置熔炉",
      "action": "PlaceBlock",
      "params": { "block_name": "furnace", "coords": "player_feet", "facing": "up" },
      "condition": { "has_items": { "furnace": 1 } },
      "objective": {}
    },
    {
      "task_name": "烧制铁锭",
      "action": "SmeltItem",
      "params": { "input_item": "raw_iron", "fuel_item": "coal", "count": 3 },
      "condition": { "has_items": { "raw_iron": 3, "coal": 1 } },
      "objective": { "gather_items": { "iron_ingot": 3 } }
    }
  ]
}

User: "停下，别干了"
{
  "reply": "好的，已停止所有任务。",
  "action": "stop",
  "todo_list": []
}

只要玩家说出“来”，”过来“之类的词，就先使用 TeleportRequest 发送传送请求。
现在，请接收玩家指令并严格输出 JSON：

`;

bot.on('login', () => {
    console.log(`[System] ${bot.username} 已登录 (Login event)`);
});

bot.on('connect', () => {
    console.log(`[System] 已成功连接到服务器！`);
});

bot.on('error', (err) => {
    console.error('[Bot] 发生错误:', err);
});

bot.once('spawn', () => {
    console.log(`[System] ${bot.username} 已加入服务器！`);
    // 启动时打印实际协商到的版本，方便调试
    stateMachine = new StateMachine(bot);
    console.log(`[System] 协议版本: ${bot.version}`);
    sendToOwner(bot, '主人好，底层框架已启动，等待指令！');
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);
    bot.physics.stepHeight = 2.0; //千万不要改这里，不是笔误
        // ============================================
    // 挂载被动本能（传入获取当前 Action 的函数）
    // ============================================
    const getAction = () => currentAction;
    
    // 2. 自动进食
    if (process.env.INSTINCT_AUTO_EAT === 'true') {
        const autoEat = new AutoEat(bot, getAction);
        autoEat.mount();
    }

    // 3. 自动防御
    if (process.env.INSTINCT_AUTO_DEFEND === 'true' || process.env.AUTO_DEFEND_ENABLED === 'true') {
        const autoDefend = new AutoDefend(bot, getAction);
        autoDefend.mount();
    }

    // 4. 自动工具
    if (process.env.INSTINCT_AUTO_TOOL === 'true') {
        const autoTool = new AutoTool(bot);
        autoTool.mount();
    }

    // 5. 自动清理背包
    if (process.env.INSTINCT_AUTO_DUMP === 'true') {
        const autoDump = new AutoDump(bot, getAction);
        autoDump.mount();
    }

});
bot.on('windowOpen', (window) => {
    console.log('[DEBUG] windowOpen 触发');
    console.log('  window.type  =', window.type);
    console.log('  window.title =', window.title);
    console.log('  window.id    =', window.id);
});

bot.on('kicked', (reason) => {
    console.error('[Bot] 被踢出游戏，原因:', reason);
});

bot.on('end', (reason) => {
    console.error('[Bot] 连接断开，原因:', reason);
});

process.on('unhandledRejection', (err) => {
    console.error('[Bot] 未捕获的异步错误:', err);
});

// 统一的消息处理函数
async function handleMessage(username, message) {
    debugLog(`收到消息来自: ${username}, 内容: ${message}`);
    debugLog(`当前配置的主人: ${process.env.MC_OWNER_NAME}`);

    // 忽略自己发出的消息
    if (username === bot.username) return;

    // 核心限制：只听主人的话（从 .env 中读取的主人 ID）
    // 增加模糊匹配或去空格处理，防止因为前缀或空格导致匹配失败
    const isOwner = username.includes(process.env.MC_OWNER_NAME) || process.env.MC_OWNER_NAME.includes(username);
    if (!isOwner) {
        return;
    }

    // ==========================================
    // 处理硬编码的测试指令
    // ==========================================
    if (message === 'retry') {
        if (stateMachine) {
            stateMachine.retryCurrentTask();
        }
        return;
    }


    if (message === 'skip') {
        if (stateMachine) {
            stateMachine.skipCurrentTask();
        }
        return;
    }


    if (message === 'stop') {
        if (stateMachine) {
            stateMachine.stopAll();
        }
        if (currentAction) {
            currentAction.stop('cancelled_by_user');
            currentAction = null;
        }
        chatHistory.length = 0; // 清空上下文
        console.log(`[Bot] 已从底层停止所有任务并清空上下文。`);
        return;
    }

    // ==========================================
    // 处理 LLM 自然语言对话
    // ==========================================
    const prompt = message;
    if (!prompt) return;

    if (isThinking) {
        return;
    }

    isThinking = true; // 上锁
    console.log(`[LLM] 正在思考: ${prompt}`);

    // 组装当前 todolist
    let currentTask = null;
    let remainingTasks = [];
    if (stateMachine && stateMachine.currentPlan) {
        currentTask = stateMachine.currentPlan.todo_list[stateMachine.currentIndex];
        remainingTasks = stateMachine.currentPlan.todo_list.slice(stateMachine.currentIndex + 1);
    }

    const fullSystemPrompt = `${SYSTEM_PROMPT}\n\n当前正在执行的任务 (不可修改):\n${currentTask ? JSON.stringify(currentTask, null, 2) : "无"}\n\n当前未执行的计划 (将被你的 todo_list 替换):\n${JSON.stringify(remainingTasks, null, 2)}`;

    try {
        const response = await LLMService.generatePlan(fullSystemPrompt, chatHistory, prompt);
        
        // 1. 回复玩家
        if (response.reply) {
            sendToOwner(bot, response.reply);
        }

        // 2. 记录历史
        let summary = "回答了玩家的问题";
        if (response.action === 'modify_plan' || response.action === 'replace_plan') {
            summary = `生成了新计划，共 ${response.todo_list ? response.todo_list.length : 0} 步`;
        } else if (response.action === 'stop') {
            summary = "停止了所有任务";
        }
        
        chatHistory.push({ user: prompt, summary: summary });
        if (chatHistory.length > 10) {
            chatHistory.shift();
        }

        // 3. 处理 action
        if (response.action === 'modify_plan' || response.action === 'replace_plan') {
            if (response.todo_list && Array.isArray(response.todo_list)) {
                stateMachine.replaceRemainingTasks(response.todo_list);
            }
        } else if (response.action === 'stop') {
            stateMachine.stopAll();
        }

    } catch (error) {
        if (error.message === 'INVALID_JSON_RESPONSE') {
            chatHistory.length = 0; // 清空上下文
            console.error('[LLM] DeepSeek 返回了无效的 JSON');
        } else {
            console.error(`[LLM] 思考失败: ${error.message}`);
        }
    } finally {
        isThinking = false; 
    }
}

// 监听所有字符串消息（包含系统消息和插件格式化的聊天）
bot.on('messagestr', async (messageStr, messagePosition, jsonMsg) => {
    const tellMode = process.env.TELL_MODE || 'whisper';
    debugLog(`messagestr 触发: ${messageStr} (Mode: ${tellMode})`);

    if (tellMode !== 'whisper') return; // 非私聊模式不处理 messagestr

    // 兼容英文原版 "whispers to you:" 和中文 "悄悄地对你说:"
    const whisperRegex = /^([a-zA-Z0-9_]+)\s*(?:whispers to you:|悄悄地对你说\s*[:：])\s*(.*)$/;
    const match = messageStr.match(whisperRegex);
    
    // 如果不是悄悄话格式，直接忽略
    if (!match) return;
    
    const username = match[1];
    const message = match[2].trim();

    await handleMessage(username, message);
});

// 监听公屏聊天
bot.on('chat', async (username, message) => {
    const tellMode = process.env.TELL_MODE || 'whisper';
    debugLog(`chat 触发: <${username}> ${message} (Mode: ${tellMode})`);

    if (tellMode !== 'public') return; // 非公屏模式不处理 chat

    await handleMessage(username, message);
});
