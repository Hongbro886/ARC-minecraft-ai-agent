const { EventEmitter } = require('events');
const GoTo = require('../move/GoTo');
const { sendToOwner } = require('../../utils/chat');

class CraftItem extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.itemName = params.item_name;
        this.count = params.count || 1;
        this.searchRadius = params.radius || 32;

        this.isPaused = false;
        this.isExecuting = false;

        this.gotoTask = null;
        this.craftingTableBlock = null;
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const tableId = mcData.blocksByName['crafting_table'].id;

            // ═══════════════════════════════════════════════════════
            // 第一步：查询物品信息，确认物品存在
            // ═══════════════════════════════════════════════════════
            const item = mcData.itemsByName[this.itemName];
            if (!item) {
                sendToOwner(this.bot, `❌ 无法识别的物品: ${this.itemName}`);
                this.stop('invalid_item');
                return;
            }

            // ═══════════════════════════════════════════════════════
            // 第二步：检查游戏内是否存在该物品的合成配方
            // recipesAll() 返回所有配方（包括需要工作台和不需要的）
            // 第三个参数 true 表示包含不同元数据（metadata）变体的配方
            // ═══════════════════════════════════════════════════════
            const allRecipes = this.bot.recipesAll(item.id, null, true);
            if (!allRecipes || allRecipes.length === 0) {
                sendToOwner(this.bot, `❌ 游戏内不存在【${this.itemName}】的合成配方！`);
                this.stop('no_recipe');
                return;
            }

            // ═══════════════════════════════════════════════════════
            // 第三步：判断配方是否需要工作台
            // requiresTable 为 true 表示该配方必须在 3x3 工作台中合成
            // 为 false 表示可以在 2x2 随身合成栏中完成
            // ═══════════════════════════════════════════════════════
            const needsCraftingTable = allRecipes[0].requiresTable;
            let craftingTableRef = null;

            if (needsCraftingTable) {
                // ── 需要工作台：在附近搜索真实的工作台方块 ──
                const tableResult = this.bot.findBlock({
                    matching: tableId,
                    maxDistance: this.searchRadius,
                });

                if (!tableResult) {
                    sendToOwner(this.bot, `⚠️ ${this.searchRadius} 格内找不到工作台！请先放置工作台。`);
                    this.stop('no_crafting_table');
                    return;
                }

                // 获取工作台方块的完整信息（包含位置、类型等）
                this.craftingTableBlock = this.bot.blockAt(tableResult.position);
                console.log(`[CraftItem] 找到工作台: ${tableResult.position}`);

                // ── 寻路前往工作台 ──
                // 必须走到工作台旁边才能右键打开它
                const reached = await this._walkToCraftingTable(tableResult.position);
                if (!reached) {
                    sendToOwner(this.bot, `⚠️ 无法走到工作台旁边！`);
                    this.stop('cannot_reach_table');
                    return;
                }

                // 如果在寻路过程中被外部 stop() 了，直接退出
                if (!this.isExecuting) return;

                // 将真实的工作台方块引用传给 recipesFor，用于筛选需要工作台的配方
                craftingTableRef = this.craftingTableBlock;
            }

            // ═══════════════════════════════════════════════════════
            // 第四步：等待材料并检查背包是否充足
            //
            // 【竞态条件修复】
            // 前一个任务（如 MineBlocks）挖掉方块后立即发出 success，
            // 但掉落物可能还没被 bot 拾取到背包中（Minecraft 拾取有延迟）。
            // 如果 CraftItem 立刻检查 recipesFor()，会发现背包为空而误判材料不足。
            //
            // 解决方案：轮询等待材料进入背包，最多等待 10 秒
            //   - 每 1 秒检查一次 recipesFor()
            //   - 如果材料到了，立即继续合成
            //   - 如果 10 秒后材料仍然不足，才报错退出
            // ═══════════════════════════════════════════════════════
            const WAIT_INTERVAL_MS = 1000;
            const WAIT_MAX_MS = 10000;
            let waitedMs = 0;
            let availableRecipes = this.bot.recipesFor(item.id, null, 1, craftingTableRef);

            while ((!availableRecipes || availableRecipes.length === 0) && waitedMs < WAIT_MAX_MS) {
                if (!this.isExecuting) return;

                if (waitedMs === 0) {
                    console.log(`[CraftItem] 材料暂未到背包，等待拾取中...`);
                }

                await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
                waitedMs += WAIT_INTERVAL_MS;

                // 暂停期间不检查
                while (this.isPaused && this.isExecuting) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!this.isExecuting) return;

                availableRecipes = this.bot.recipesFor(item.id, null, 1, craftingTableRef);
                console.log(`[CraftItem] 等待材料中... (${waitedMs}ms/${WAIT_MAX_MS}ms)`);
            }

            if (!availableRecipes || availableRecipes.length === 0) {
                // 等待超时，材料仍然不足，列出缺少的材料给玩家参考
                const missingInfo = this._getMissingMaterials(allRecipes[0]);
                sendToOwner(this.bot, `❌ 材料不足，无法合成【${this.itemName}】！${missingInfo}`);
                this.stop('insufficient_materials');
                return;
            }

            // ═══════════════════════════════════════════════════════
            // 第五步：计算实际可合成次数
            // 一个配方可能产出多个物品（如 1 个配方产出 4 个木板）
            // 需要根据请求的 count 和配方的单次产出量，计算需要执行几次合成
            // ═══════════════════════════════════════════════════════
            const recipeToUse = availableRecipes[0];
            const resultCount = recipeToUse.result.count || 1;
            const craftTimes = Math.ceil(this.count / resultCount);

            console.log(`[CraftItem] 开始合成 ${this.count} 个 ${this.itemName}（单次产出 ${resultCount}，需合成 ${craftTimes} 次）`);

            // ═══════════════════════════════════════════════════════
            // 第六步：执行合成
            // bot.craft() 是 mineflayer 提供的原版合成 API：
            //   - recipe：要使用的配方对象
            //   - count：合成次数（不是产出数量）
            //   - craftingTable：工作台方块引用，null 表示用随身合成栏
            //
            // 内部流程：
            //   1. 如果需要工作台，先调用 bot.activateBlock(craftingTable) 右键打开工作台
            //   2. 等待 windowOpen 事件，获取工作台的容器窗口
            //   3. 将配方所需的材料放入对应的合成槽位
            //   4. 点击输出槽位取出成品
            //   5. 关闭窗口
            //
            // 这就是原版合成逻辑，完全模拟玩家手动操作
            // ═══════════════════════════════════════════════════════
            await this.bot.craft(recipeToUse, craftTimes, craftingTableRef);

            console.log(`[CraftItem] 成功合成 ${this.count} 个 ${this.itemName}`);
            sendToOwner(this.bot, `✅ 成功合成 ${this.count} 个【${this.itemName}】！`);

            this.stop('success');

        } catch (err) {
            if (!this.isExecuting) return;

            console.error(`[CraftItem] 合成失败:`, err);
            sendToOwner(this.bot, `❌ 合成【${this.itemName}】失败: ${err.message}`);
            this.stop('craft_error');
        }
    }

    /**
     * 使用 GoTo 类寻路前往工作台旁边
     * 必须走到工作台附近（2格以内）才能右键打开它
     * 参考 SmeltItem 中 _walkToFurnace 的实现模式
     *
     * @param {Vec3} pos - 工作台的坐标
     * @returns {Promise<boolean>} 是否成功到达
     */
    async _walkToCraftingTable(pos) {
        return new Promise((resolve) => {
            sendToOwner(this.bot, `🚶 正在前往工作台 (${pos.x}, ${pos.y}, ${pos.z})...`);

            // 实例化 GoTo 类，走到距离工作台 2 格以内
            // range=2 是因为右键交互的最大距离约为 4-5 格，
            // 但走到 2 格内可以确保交互成功
            this.gotoTask = new GoTo(this.bot, {
                coords: [pos.x, pos.y, pos.z],
                range: 2,
            });

            // 监听 GoTo 任务的结束事件
            this.gotoTask.once('stop', (reason) => {
                this.gotoTask = null;

                if (reason === 'success') {
                    console.log('[CraftItem] 已成功到达工作台');
                    resolve(true);
                } else {
                    console.log(`[CraftItem] 寻路到工作台失败，原因: ${reason}`);
                    resolve(false);
                }
            });

            // 开始执行寻路
            this.gotoTask.execute();
        });
    }

    /**
     * 分析配方所需材料与背包现有材料的差异，生成缺少材料的提示信息
     *
     * @param {Object} recipe - 配方对象，包含 delta 数组
     *   delta 数组中每个元素格式：{ id: 物品ID, count: 数量（负数表示消耗） }
     *   只需要关注 count < 0 的条目（即消耗的材料）
     * @returns {string} 缺少材料的提示文本
     */
    _getMissingMaterials(recipe) {
        const mcData = require('minecraft-data')(this.bot.version);
        const parts = [];

        if (!recipe.delta || !Array.isArray(recipe.delta)) {
            return '';
        }

        for (const delta of recipe.delta) {
            // delta.count < 0 表示该材料是被消耗的（正数表示产出）
            if (delta.count >= 0) continue;

            const needed = Math.abs(delta.count);
            const itemData = mcData.items[delta.id];
            const itemName = itemData ? itemData.name : `未知(${delta.id})`;

            // 统计背包中该材料的数量
            const have = this.bot.inventory.items()
                .filter(i => i.type === delta.id)
                .reduce((sum, i) => sum + i.count, 0);

            if (have < needed) {
                parts.push(`【${itemName}】需要 ${needed}，只有 ${have}`);
            }
        }

        return parts.length > 0 ? '缺少: ' + parts.join('、') : '';
    }

    /**
     * 暂停合成动作
     * 如果正在寻路前往工作台，则连同寻路任务一起暂停
     */
    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;

        if (this.gotoTask) {
            this.gotoTask.pause();
        } else {
            this.bot.clearControlStates();
        }
        console.log('[CraftItem] 合成动作已暂停');
    }

    /**
     * 恢复合成动作
     * 如果之前在寻路，则恢复寻路任务
     */
    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;

        if (this.gotoTask) {
            this.gotoTask.resume();
        }
        console.log('[CraftItem] 合成动作已恢复');
    }

    /**
     * 停止合成动作
     * 清理所有资源：停止寻路、关闭窗口、重置状态
     *
     * @param {string} reason - 停止原因
     *   常见值：
     *   - 'success'：合成成功完成
     *   - 'cancelled_by_user'：用户手动取消
     *   - 'no_crafting_table'：找不到工作台
     *   - 'cannot_reach_table'：无法到达工作台
     *   - 'insufficient_materials'：材料不足
     *   - 'craft_error'：合成过程中出错
     */
    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;

        // 如果正在寻路，强制停止寻路子任务
        if (this.gotoTask) {
            this.gotoTask.stop(reason);
            this.gotoTask = null;
        }

        // 强制关闭可能打开的工作台窗口
        // bot.craft() 内部会打开工作台窗口，如果中途被 stop，
        // 需要手动关闭窗口，否则 bot 会卡在窗口打开状态
        const currentWindow = this.bot.currentWindow;
        if (currentWindow) {
            this.bot.closeWindow(currentWindow);
        }

        // 清空寻路目标和按键状态，防止残留
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null);
        }
        this.bot.clearControlStates();

        console.log(`[CraftItem] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = CraftItem;
