class ObjectiveParser {
        /**
     * 校验当前状态是否已达成 objective
     * @param {Object} bot - Mineflayer bot 实例
     * @param {Object} objective - 目标对象
     * @param {Object} snapshot - 任务开始前的背包快照（用于计算增量）
     * @returns {Boolean} 是否达成
     */
    static evaluate(bot, objective, snapshot) {
        // 参数校验
        if (!bot) {
            console.error('[ObjectiveParser] bot 实例不能为空');
            return false;
        }

        // 🌟 核心修复：如果 objective 不存在，或者是一个空对象 {}，直接返回 false
        // 这样就不会往下走，也不会打印警告了。任务的结束将由 Action 内部自己决定。
        if (!objective || Object.keys(objective).length === 0) {
            return false; 
        }

        // 2. 校验到达坐标目标 (reach_coords)
        if (objective.reach_coords) {
            // 这个目标通常由 GoTo 的内部逻辑触发，这里返回 false 让 GoTo 自己控制
            return false;
        }

        // 类型校验
        if (typeof objective !== 'object' || Array.isArray(objective)) {
            console.error('[ObjectiveParser] objective 必须是对象类型');
            return false;
        }

        try {
            // 优先级1: 校验无限目标 (infinite) - 最高优先级
            if (objective.infinite === true) {
                return false; // 永远不主动结束
            }

            // 优先级2: 校验收集目标 (gather_items)
            if (objective.gather_items) {
                return this._evaluateGatherItems(bot, objective.gather_items, snapshot);
            }

            // 优先级3: 校验制作目标 (craft_items)
            if (objective.craft_items) {
                return this._evaluateCraftItems(bot, objective.craft_items, snapshot);
            }

            // 优先级4: 校验清理区域 (clear_area)
            if (objective.clear_area) {
                return this._evaluateClearArea(bot, objective.clear_area);
            }

            // 优先级5: 校验目标死亡 (target_dead)
            if (objective.target_dead) {
                return this._evaluateTargetDead(bot, objective.target_dead);
            }

            // 优先级6: 校验到达位置 (reach_position)
            if (objective.reach_position) {
                return this._evaluateReachPosition(bot, objective.reach_position);
            }

            // 优先级7: 校验时间目标 (duration)
            if (objective.duration) {
                return this._evaluateDuration(objective.duration, snapshot);
            }

            // 优先级8: 校验建造目标 (build_structure)
            if (objective.build_structure) {
                return this._evaluateBuildStructure(bot, objective.build_structure);
            }

            // 没有匹配的目标类型
            console.warn('[ObjectiveParser] 未识别的目标类型:', Object.keys(objective));
            return false;

        } catch (error) {
            console.error('[ObjectiveParser] 评估目标时发生错误:', error);
            return false;
        }
    }


    /**
     * 校验收集物品目标
     * @private
     */
    static _evaluateGatherItems(bot, gatherItems, snapshot) {
        if (!gatherItems || typeof gatherItems !== 'object') {
            console.warn('[ObjectiveParser] gather_items 格式不正确');
            return false;
        }

        if (!snapshot || !snapshot.items) {
            console.warn('[ObjectiveParser] 缺少有效的 snapshot，无法计算增量');
            // 降级方案：直接比较当前数量
            return this._evaluateGatherItemsAbsolute(bot, gatherItems);
        }

        try {
            for (const [itemName, targetAmount] of Object.entries(gatherItems)) {
                // 校验目标数量
                const target = parseInt(targetAmount, 10);
                if (isNaN(target) || target < 0) {
                    console.warn(`[ObjectiveParser] 物品 ${itemName} 的目标数量无效: ${targetAmount}`);
                    continue;
                }

                const currentCount = this._getItemCount(bot, itemName);
                const initialCount = snapshot.items[itemName] || 0;
                const gathered = currentCount - initialCount;

                if (gathered < target) {
                    return false; // 只要有一个物品没达标，就返回 false
                }
            }
            return true;
        } catch (error) {
            console.error('[ObjectiveParser] 校验收集目标时出错:', error);
            return false;
        }
    }

    /**
     * 降级方案：直接比较当前物品数量（不计算增量）
     * @private
     */
    static _evaluateGatherItemsAbsolute(bot, gatherItems) {
        try {
            for (const [itemName, targetAmount] of Object.entries(gatherItems)) {
                const target = parseInt(targetAmount, 10);
                if (isNaN(target) || target < 0) continue;

                const currentCount = this._getItemCount(bot, itemName);
                if (currentCount < target) {
                    return false;
                }
            }
            return true;
        } catch (error) {
            console.error('[ObjectiveParser] 绝对数量校验时出错:', error);
            return false;
        }
    }

    /**
     * 校验制作物品目标
     * @private
     */
    static _evaluateCraftItems(bot, craftItems, snapshot) {
        if (!craftItems || typeof craftItems !== 'object') {
            console.warn('[ObjectiveParser] craft_items 格式不正确');
            return false;
        }

        // 制作目标本质上也是检查物品增量
        return this._evaluateGatherItems(bot, craftItems, snapshot);
    }

    /**
     * 校验清理区域目标
     * @private
     */
    static _evaluateClearArea(bot, clearArea) {
        if (!clearArea || typeof clearArea !== 'object') {
            console.warn('[ObjectiveParser] clear_area 格式不正确');
            return false;
        }

        try {
            const { block, radius = 10, center } = clearArea;

            if (!block) {
                console.warn('[ObjectiveParser] clear_area.block 未指定');
                return false;
            }

            const mcData = require('minecraft-data')(bot.version);
            if (!mcData || !mcData.blocksByName) {
                console.error('[ObjectiveParser] minecraft-data 加载失败');
                return false;
            }

            const blockType = mcData.blocksByName[block];
            if (!blockType) {
                console.warn(`[ObjectiveParser] 未知方块类型: ${block}`);
                return false;
            }

            // 确定搜索中心
            const searchCenter = center || bot.entity.position;
            
            const foundBlock = bot.findBlock({
                matching: blockType.id,
                maxDistance: radius,
                point: searchCenter
            });

            // 如果找不到目标方块，说明已清理完成
            return !foundBlock;

        } catch (error) {
            console.error('[ObjectiveParser] 校验清理区域时出错:', error);
            return false;
        }
    }

    /**
     * 校验目标死亡
     * @private
     */
    static _evaluateTargetDead(bot, targetDead) {
        if (!targetDead || typeof targetDead !== 'object') {
            console.warn('[ObjectiveParser] target_dead 格式不正确');
            return false;
        }

        try {
            const { entityType, entityId, radius = 50 } = targetDead;

            // 如果指定了实体ID，直接查找
            if (entityId) {
                const entity = bot.entities[entityId];
                return !entity || entity.isValid === false;
            }

            // 如果指定了实体类型，检查范围内是否还有该类型实体
            if (entityType) {
                const entities = Object.values(bot.entities).filter(entity => {
                    if (!entity || !entity.position) return false;
                    const distance = entity.position.distanceTo(bot.entity.position);
                    return entity.name === entityType && distance <= radius;
                });

                return entities.length === 0;
            }

            console.warn('[ObjectiveParser] target_dead 缺少 entityType 或 entityId');
            return false;

        } catch (error) {
            console.error('[ObjectiveParser] 校验目标死亡时出错:', error);
            return false;
        }
    }

    /**
     * 校验到达位置目标
     * @private
     */
    static _evaluateReachPosition(bot, reachPosition) {
        if (!reachPosition || typeof reachPosition !== 'object') {
            console.warn('[ObjectiveParser] reach_position 格式不正确');
            return false;
        }

        try {
            const { x, y, z, threshold = 2 } = reachPosition;

            if (x === undefined || y === undefined || z === undefined) {
                console.warn('[ObjectiveParser] reach_position 缺少坐标');
                return false;
            }

            const targetX = parseFloat(x);
            const targetY = parseFloat(y);
            const targetZ = parseFloat(z);

            if (isNaN(targetX) || isNaN(targetY) || isNaN(targetZ)) {
                console.warn('[ObjectiveParser] reach_position 坐标无效');
                return false;
            }

            const pos = bot.entity.position;
            const distance = Math.sqrt(
                Math.pow(pos.x - targetX, 2) +
                Math.pow(pos.y - targetY, 2) +
                Math.pow(pos.z - targetZ, 2)
            );

            return distance <= threshold;

        } catch (error) {
            console.error('[ObjectiveParser] 校验到达位置时出错:', error);
            return false;
        }
    }

    /**
     * 校验持续时间目标
     * @private
     */
    static _evaluateDuration(duration, snapshot) {
        if (!snapshot || !snapshot.startTime) {
            console.warn('[ObjectiveParser] snapshot 缺少 startTime');
            return false;
        }

        try {
            const durationMs = parseInt(duration, 10);
            if (isNaN(durationMs) || durationMs < 0) {
                console.warn('[ObjectiveParser] duration 必须是非负整数:', duration);
                return false;
            }

            const elapsed = Date.now() - snapshot.startTime;
            return elapsed >= durationMs;

        } catch (error) {
            console.error('[ObjectiveParser] 校验持续时间时出错:', error);
            return false;
        }
    }

    /**
     * 校验建造结构目标
     * @private
     */
    static _evaluateBuildStructure(bot, buildStructure) {
        if (!buildStructure || typeof buildStructure !== 'object') {
            console.warn('[ObjectiveParser] build_structure 格式不正确');
            return false;
        }

        try {
            const { blocks, tolerance = 0 } = buildStructure;

            if (!Array.isArray(blocks)) {
                console.warn('[ObjectiveParser] build_structure.blocks 必须是数组');
                return false;
            }

            let placedCount = 0;
            const mcData = require('minecraft-data')(bot.version);

            for (const blockDef of blocks) {
                const { x, y, z, type } = blockDef;
                
                if (x === undefined || y === undefined || z === undefined || !type) {
                    console.warn('[ObjectiveParser] 方块定义不完整:', blockDef);
                    continue;
                }

                const blockType = mcData.blocksByName[type];
                if (!blockType) {
                    console.warn(`[ObjectiveParser] 未知方块类型: ${type}`);
                    continue;
                }

                const block = bot.blockAt(new (require('vec3'))(x, y, z));
                if (block && block.type === blockType.id) {
                    placedCount++;
                }
            }

            const requiredCount = blocks.length - tolerance;
            return placedCount >= requiredCount;

        } catch (error) {
            console.error('[ObjectiveParser] 校验建造结构时出错:', error);
            return false;
        }
    }

    /**
     * 获取物品数量
     * @private
     */
    static _getItemCount(bot, itemName) {
        if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') {
            console.error('[ObjectiveParser] bot.inventory 不可用');
            return 0;
        }

        if (!itemName || typeof itemName !== 'string') {
            console.warn('[ObjectiveParser] itemName 无效:', itemName);
            return 0;
        }

        try {
            return bot.inventory.items().reduce((acc, item) => {
                if (!item || !item.name) return acc;
                return item.name === itemName ? acc + (item.count || 0) : acc;
            }, 0);
        } catch (error) {
            console.error('[ObjectiveParser] 获取物品数量时出错:', error);
            return 0;
        }
    }

    /**
     * 创建背包快照
     * @param {Object} bot - Mineflayer bot 实例
     * @returns {Object} 快照对象
     */
    static takeSnapshot(bot) {
        if (!bot) {
            console.error('[ObjectiveParser] bot 实例不能为空');
            return { items: {}, startTime: Date.now() };
        }

        if (!bot.inventory || typeof bot.inventory.items !== 'function') {
            console.error('[ObjectiveParser] bot.inventory 不可用');
            return { items: {}, startTime: Date.now() };
        }

        const snapshot = {
            items: {},
            startTime: Date.now(),
            position: null,
            health: null,
            food: null
        };

        try {
            // 记录物品
            bot.inventory.items().forEach(item => {
                if (!item || !item.name) return;
                
                if (!snapshot.items[item.name]) {
                    snapshot.items[item.name] = 0;
                }
                snapshot.items[item.name] += item.count || 0;
            });

            // 记录位置
            if (bot.entity && bot.entity.position) {
                snapshot.position = {
                    x: bot.entity.position.x,
                    y: bot.entity.position.y,
                    z: bot.entity.position.z
                };
            }

            // 记录生命值
            if (bot.health !== undefined) {
                snapshot.health = bot.health;
            }

            // 记录饥饿值
            if (bot.food !== undefined) {
                snapshot.food = bot.food;
            }

        } catch (error) {
            console.error('[ObjectiveParser] 创建快照时出错:', error);
        }

        return snapshot;
    }

    /**
     * 获取目标完成进度
     * @param {Object} bot - Mineflayer bot 实例
     * @param {Object} objective - 目标对象
     * @param {Object} snapshot - 快照对象
     * @returns {Object} { progress: 0-1, details: {} }
     */
    static getProgress(bot, objective, snapshot) {
        if (!bot) {
            console.error('[ObjectiveParser] bot 实例不能为空');
            return false;
        }

        // 核心修复：如果目标为空对象 {} 或 null，直接返回 false
        // 这意味着该任务的结束完全由 Action 内部的 this.stop('success') 来控制
        if (!objective || Object.keys(objective).length === 0) {
            return false; 
        }

        try {
            // 无限目标
            if (objective.infinite) {
                return { progress: 0, details: { type: 'infinite' } };
            }

            // 收集物品进度
            if (objective.gather_items) {
                return this._getGatherProgress(bot, objective.gather_items, snapshot);
            }

            // 制作物品进度
            if (objective.craft_items) {
                return this._getGatherProgress(bot, objective.craft_items, snapshot);
            }

            // 持续时间进度
            if (objective.duration && snapshot && snapshot.startTime) {
                const elapsed = Date.now() - snapshot.startTime;
                const progress = Math.min(elapsed / objective.duration, 1);
                return { progress, details: { elapsed, total: objective.duration } };
            }

            return { progress: 0, details: {} };

        } catch (error) {
            console.error('[ObjectiveParser] 获取进度时出错:', error);
            return { progress: 0, details: {} };
        }
    }

    /**
     * 获取收集进度
     * @private
     */
    static _getGatherProgress(bot, gatherItems, snapshot) {
        if (!gatherItems || typeof gatherItems !== 'object') {
            return { progress: 0, details: {} };
        }

        const details = {};
        let totalProgress = 0;
        let itemCount = 0;

        for (const [itemName, targetAmount] of Object.entries(gatherItems)) {
            const target = parseInt(targetAmount, 10);
            if (isNaN(target) || target < 0) continue;

            const currentCount = this._getItemCount(bot, itemName);
            const initialCount = (snapshot && snapshot.items) ? (snapshot.items[itemName] || 0) : 0;
            const gathered = Math.max(0, currentCount - initialCount);

            const itemProgress = Math.min(gathered / target, 1);
            totalProgress += itemProgress;
            itemCount++;

            details[itemName] = {
                current: gathered,
                target: target,
                progress: itemProgress
            };
        }

        const overallProgress = itemCount > 0 ? totalProgress / itemCount : 0;

        return {
            progress: overallProgress,
            details: details
        };
    }

    /**
     * 比较两个快照的差异
     * @param {Object} snapshot1 - 第一个快照
     * @param {Object} snapshot2 - 第二个快照
     * @returns {Object} 差异对象
     */
    static compareSnapshots(snapshot1, snapshot2) {
        if (!snapshot1 || !snapshot2) {
            console.warn('[ObjectiveParser] 快照无效');
            return { items: {} };
        }

        const diff = { items: {} };

        try {
            // 获取所有物品名称
            const allItems = new Set([
                ...Object.keys(snapshot1.items || {}),
                ...Object.keys(snapshot2.items || {})
            ]);

            for (const itemName of allItems) {
                const count1 = snapshot1.items[itemName] || 0;
                const count2 = snapshot2.items[itemName] || 0;
                const change = count2 - count1;

                if (change !== 0) {
                    diff.items[itemName] = change;
                }
            }

        } catch (error) {
            console.error('[ObjectiveParser] 比较快照时出错:', error);
        }

        return diff;
    }
}

module.exports = ObjectiveParser;
