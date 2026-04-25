class ConditionParser {
    /**
     * 校验当前状态是否满足 condition
     * @param {Object} bot - Mineflayer bot 实例
     * @param {Object} condition - 条件对象
     * @returns {Array} 缺失的条件描述列表（空数组表示全部满足）
     */
    static evaluate(bot, condition) {
        // 参数校验
        if (!bot) {
            console.error('[ConditionParser] bot 实例不能为空');
            return ['系统错误：bot 实例未初始化'];
        }

        if (!condition) {
            return [];
        }

        // 类型校验
        if (typeof condition !== 'object' || Array.isArray(condition)) {
            console.error('[ConditionParser] condition 必须是对象类型');
            return ['系统错误：条件格式不正确'];
        }

        const missing = [];

        try {
            // 1. 校验消耗品 (items)
            if (condition.items) {
                this._validateItems(bot, condition.items, missing);
            }

            // 2. 校验工具 (tools)
            if (condition.tools) {
                this._validateTools(bot, condition.tools, missing);
            }

            // 3. 校验背包空位 (empty_slots)
            if (condition.empty_slots !== undefined && condition.empty_slots !== null) {
                this._validateEmptySlots(bot, condition.empty_slots, missing);
            }

            // 4. 校验环境 (environment)
            if (condition.environment) {
                this._validateEnvironment(bot, condition.environment, missing);
            }

            // 5. 扩展：校验装备 (equipment)
            if (condition.equipment) {
                this._validateEquipment(bot, condition.equipment, missing);
            }

            // 6. 扩展：校验等级/经验 (level)
            if (condition.level !== undefined && condition.level !== null) {
                this._validateLevel(bot, condition.level, missing);
            }

        } catch (error) {
            console.error('[ConditionParser] 评估过程发生错误:', error);
            missing.push(`系统错误：${error.message}`);
        }

        return missing;
    }

    /**
     * 校验物品数量
     * @private
     */
    static _validateItems(bot, items, missing) {
        if (!items || typeof items !== 'object') {
            console.warn('[ConditionParser] items 格式不正确');
            return;
        }

        try {
            for (const [itemName, requiredCount] of Object.entries(items)) {
                // 校验 requiredCount 是否为有效数字
                const required = parseInt(requiredCount, 10);
                if (isNaN(required) || required < 0) {
                    console.warn(`[ConditionParser] 物品 ${itemName} 的数量无效: ${requiredCount}`);
                    continue;
                }

                const count = this._getItemCount(bot, itemName);
                if (count < required) {
                    missing.push(`【${itemName}】(缺 ${required - count} 个)`);
                }
            }
        } catch (error) {
            console.error('[ConditionParser] 校验物品时出错:', error);
            missing.push('物品校验失败');
        }
    }

    /**
     * 校验工具
     * @private
     */
    static _validateTools(bot, tools, missing) {
        if (!Array.isArray(tools)) {
            console.warn('[ConditionParser] tools 必须是数组类型');
            return;
        }

        if (!bot.inventory || typeof bot.inventory.items !== 'function') {
            console.error('[ConditionParser] bot.inventory 不可用');
            missing.push('系统错误：无法访问背包');
            return;
        }

        try {
            for (const toolType of tools) {
                if (typeof toolType !== 'string' || !toolType.trim()) {
                    console.warn('[ConditionParser] 工具类型无效:', toolType);
                    continue;
                }

                const hasTool = bot.inventory.items().some(item => 
                    item && item.name && item.name.includes(`_${toolType}`)
                );

                if (!hasTool) {
                    missing.push(`【${toolType}类工具】`);
                }
            }
        } catch (error) {
            console.error('[ConditionParser] 校验工具时出错:', error);
            missing.push('工具校验失败');
        }
    }

    /**
     * 校验背包空位
     * @private
     */
    static _validateEmptySlots(bot, requiredSlots, missing) {
        const required = parseInt(requiredSlots, 10);
        if (isNaN(required) || required < 0) {
            console.warn('[ConditionParser] empty_slots 必须是非负整数:', requiredSlots);
            return;
        }

        if (!bot.inventory || typeof bot.inventory.emptySlotCount !== 'function') {
            console.error('[ConditionParser] bot.inventory.emptySlotCount 不可用');
            missing.push('系统错误：无法检查背包空位');
            return;
        }

        try {
            const emptyCount = bot.inventory.emptySlotCount();
            if (emptyCount < required) {
                missing.push(`【背包空位】(需要 ${required} 格，当前 ${emptyCount} 格)`);
            }
        } catch (error) {
            console.error('[ConditionParser] 校验背包空位时出错:', error);
            missing.push('背包空位校验失败');
        }
    }

    /**
     * 校验环境
     * @private
     */
    static _validateEnvironment(bot, environment, missing) {
        if (!environment || typeof environment !== 'object') {
            console.warn('[ConditionParser] environment 格式不正确');
            return;
        }

        if (!environment.block) {
            console.warn('[ConditionParser] environment.block 未指定');
            return;
        }

        try {
            const mcData = require('minecraft-data')(bot.version);
            if (!mcData || !mcData.blocksByName) {
                console.error('[ConditionParser] minecraft-data 加载失败');
                missing.push('系统错误：无法加载方块数据');
                return;
            }

            const blockType = mcData.blocksByName[environment.block];
            if (!blockType) {
                console.warn(`[ConditionParser] 未知方块类型: ${environment.block}`);
                missing.push(`【未知方块：${environment.block}】`);
                return;
            }

            const radius = parseInt(environment.radius, 10) || 5;
            if (!bot.findBlock || typeof bot.findBlock !== 'function') {
                console.error('[ConditionParser] bot.findBlock 不可用');
                missing.push('系统错误：无法搜索方块');
                return;
            }

            const block = bot.findBlock({ 
                matching: blockType.id, 
                maxDistance: radius 
            });

            if (!block) {
                missing.push(`【附近 ${radius} 格内需要有 ${environment.block}】`);
            }
        } catch (error) {
            console.error('[ConditionParser] 校验环境时出错:', error);
            missing.push('环境校验失败');
        }
    }

    /**
     * 校验装备（扩展功能）
     * @private
     */
    static _validateEquipment(bot, equipment, missing) {
        if (!equipment || typeof equipment !== 'object') {
            console.warn('[ConditionParser] equipment 格式不正确');
            return;
        }

        try {
            const slots = ['head', 'torso', 'legs', 'feet', 'hand', 'off-hand'];
            
            for (const [slot, itemName] of Object.entries(equipment)) {
                if (!slots.includes(slot)) {
                    console.warn(`[ConditionParser] 未知装备槽位: ${slot}`);
                    continue;
                }

                const equipped = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
                if (!equipped || equipped.name !== itemName) {
                    missing.push(`【需要装备 ${itemName} 在 ${slot} 槽位】`);
                }
            }
        } catch (error) {
            console.error('[ConditionParser] 校验装备时出错:', error);
            missing.push('装备校验失败');
        }
    }

    /**
     * 校验等级（扩展功能）
     * @private
     */
    static _validateLevel(bot, requiredLevel, missing) {
        const required = parseInt(requiredLevel, 10);
        if (isNaN(required) || required < 0) {
            console.warn('[ConditionParser] level 必须是非负整数:', requiredLevel);
            return;
        }

        try {
            if (!bot.experience || bot.experience.level === undefined) {
                console.error('[ConditionParser] bot.experience 不可用');
                missing.push('系统错误：无法获取等级信息');
                return;
            }

            if (bot.experience.level < required) {
                missing.push(`【等级】(需要 ${required} 级，当前 ${bot.experience.level} 级)`);
            }
        } catch (error) {
            console.error('[ConditionParser] 校验等级时出错:', error);
            missing.push('等级校验失败');
        }
    }

    /**
     * 获取物品数量
     * @private
     */
    static _getItemCount(bot, itemName) {
        if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') {
            console.error('[ConditionParser] bot.inventory 不可用');
            return 0;
        }

        if (!itemName || typeof itemName !== 'string') {
            console.warn('[ConditionParser] itemName 无效:', itemName);
            return 0;
        }

        try {
            return bot.inventory.items().reduce((acc, item) => {
                if (!item || !item.name) return acc;
                return item.name === itemName ? acc + (item.count || 0) : acc;
            }, 0);
        } catch (error) {
            console.error('[ConditionParser] 获取物品数量时出错:', error);
            return 0;
        }
    }

    /**
     * 批量校验多个条件（工具方法）
     * @param {Object} bot - Mineflayer bot 实例
     * @param {Array} conditions - 条件数组
     * @returns {Object} { allMissing: [], conditionResults: [] }
     */
    static evaluateMultiple(bot, conditions) {
        if (!Array.isArray(conditions)) {
            console.error('[ConditionParser] conditions 必须是数组');
            return { allMissing: ['条件格式错误'], conditionResults: [] };
        }

        const results = conditions.map((condition, index) => {
            const missing = this.evaluate(bot, condition);
            return { index, condition, missing };
        });

        const allMissing = results.flatMap(r => r.missing);

        return {
            allMissing,
            conditionResults: results,
            allSatisfied: allMissing.length === 0
        };
    }
}

module.exports = ConditionParser;
