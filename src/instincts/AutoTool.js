/**
 * 被动本能：工具状态监控
 * 监控工具耐久，在工具即将损坏时提前预警并自动切换备用工具。
 */

// 工具类型定义
const TOOL_TYPES = {
    pickaxe: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'],
    axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'],
    shovel: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'],
    sword: ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'],
    hoe: ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe', 'golden_hoe'],
    shears: ['shears'],
    flint_and_steel: ['flint_and_steel'],
    fishing_rod: ['fishing_rod'],
    bow: ['bow'],
    crossbow: ['crossbow'],
    trident: ['trident'],
};

// 耐久预警阈值
const DURABILITY_THRESHOLDS = {
    CRITICAL: 5,    // 极危险（红色预警）
    WARNING: 20,    // 危险（黄色预警）
    CAUTION: 50,    // 注意（提示）
};

const { sendToOwner } = require('../utils/chat');

// 检查间隔
const CHECK_INTERVAL = 2000; // 2秒检查一次

class AutoTool {
    constructor(bot) {
        this.bot = bot;
        this.warnedItems = new Map(); // 记录已预警的物品和预警级别
        this.checkInterval = null;
        this.autoSwitch = true; // 是否自动切换工具
    }

    mount() {
        // 定期检查工具耐久
        this.checkInterval = setInterval(() => {
            this._checkDurability();
        }, CHECK_INTERVAL);

        // 监听物品使用（实时检查正在使用的工具）
        this.bot.on('physicsTick', () => {
            this._checkHeldItem();
        });

        // 监听背包变化（可能捡到新工具或工具被修复）
        this.bot.on('playerCollect', () => {
            this._updateWarningCache();
        });

        console.log('[AutoTool] 工具耐久监控已挂载');
    }

    unmount() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        console.log('[AutoTool] 工具耐久监控已卸载');
    }

    _checkDurability() {
        const tools = this._getAllTools();
        const toolsByType = this._groupToolsByType(tools);

        for (const [type, typeTools] of Object.entries(toolsByType)) {
            this._checkToolType(type, typeTools);
        }
    }

    _checkHeldItem() {
        const heldItem = this.bot.heldItem;
        if (!heldItem) return;

        // 检查手持物品是否是工具
        if (!this._isTool(heldItem)) return;

        const durability = this._getDurabilityInfo(heldItem);
        if (!durability) return;

        // 如果手持工具快坏了，立即预警并尝试切换
        if (durability.remaining <= DURABILITY_THRESHOLDS.CRITICAL) {
            this._handleCriticalTool(heldItem, durability);
        }
    }

    _checkToolType(type, tools) {
        if (tools.length === 0) return;

        // 按耐久排序（从高到低）
        tools.sort((a, b) => {
            const durA = this._getDurabilityInfo(a);
            const durB = this._getDurabilityInfo(b);
            return (durB?.remaining || 0) - (durA?.remaining || 0);
        });

        for (const tool of tools) {
            const durability = this._getDurabilityInfo(tool);
            if (!durability) continue;

            this._checkToolDurability(tool, durability, type, tools);
        }
    }

    _checkToolDurability(tool, durability, type, allToolsOfType) {
        const { remaining, percentage } = durability;
        const itemKey = this._getItemKey(tool);
        const lastWarningLevel = this.warnedItems.get(itemKey) || 0;

        // 判断预警级别
        let warningLevel = 0;
        let warningMessage = '';
        let emoji = '';

        if (remaining <= DURABILITY_THRESHOLDS.CRITICAL) {
            warningLevel = 3;
            emoji = '🔴';
            warningMessage = `极度危险！【${this._getToolDisplayName(tool)}】耐久只剩 ${remaining}/${tool.maxDurability} (${percentage}%)`;
        } else if (remaining <= DURABILITY_THRESHOLDS.WARNING) {
            warningLevel = 2;
            emoji = '🟡';
            warningMessage = `警告！【${this._getToolDisplayName(tool)}】耐久剩余 ${remaining}/${tool.maxDurability} (${percentage}%)`;
        } else if (remaining <= DURABILITY_THRESHOLDS.CAUTION) {
            warningLevel = 1;
            emoji = '🟢';
            warningMessage = `提示：【${this._getToolDisplayName(tool)}】耐久剩余 ${remaining}/${tool.maxDurability} (${percentage}%)`;
        }

        // 只在预警级别提升时才发送消息（避免重复）
        if (warningLevel > lastWarningLevel && warningLevel > 0) {
            this.warnedItems.set(itemKey, warningLevel);
            
            // 检查是否有备用工具
            const backupTools = allToolsOfType.filter(t => 
                this._getItemKey(t) !== itemKey && 
                this._getDurabilityInfo(t)?.remaining > DURABILITY_THRESHOLDS.WARNING
            );

            if (backupTools.length > 0) {
                warningMessage += ` | 已检测到 ${backupTools.length} 个备用工具`;
            } else {
                warningMessage += ` | ⚠️ 没有备用工具！请及时补充！`;
            }

            sendToOwner(this.bot, `${emoji} ${warningMessage}`);
            console.log(`[AutoTool] ${warningMessage}`);

            // 如果是极危险级别，尝试自动切换
            if (warningLevel === 3 && this.autoSwitch && backupTools.length > 0) {
                this._switchToBetterTool(tool, backupTools);
            }
        }

        // 如果耐久恢复了，清除预警记录
        if (remaining > DURABILITY_THRESHOLDS.CAUTION) {
            this.warnedItems.delete(itemKey);
        }
    }

    async _handleCriticalTool(tool, durability) {
        const itemKey = this._getItemKey(tool);
        const lastWarning = this.warnedItems.get(itemKey) || 0;

        // 避免频繁预警（至少间隔5秒）
        const now = Date.now();
        if (now - lastWarning < 5000) return;

        this.warnedItems.set(itemKey, now);

        console.log(`[AutoTool] 手持工具即将损坏: ${tool.name} (${durability.remaining} 耐久)`);
        sendToOwner(this.bot, `🚨 紧急！手持的【${this._getToolDisplayName(tool)}】即将损坏！`);

        // 尝试切换到备用工具
        if (this.autoSwitch) {
            const toolType = this._getToolType(tool);
            if (toolType) {
                const backupTools = this._getAllTools()
                    .filter(t => 
                        this._getToolType(t) === toolType && 
                        this._getItemKey(t) !== itemKey &&
                        this._getDurabilityInfo(t)?.remaining > DURABILITY_THRESHOLDS.WARNING
                    );

                if (backupTools.length > 0) {
                    await this._switchToBetterTool(tool, backupTools);
                }
            }
        }
    }

    async _switchToBetterTool(currentTool, backupTools) {
        try {
            // 选择耐久最高的备用工具
            const bestTool = backupTools.reduce((best, current) => {
                const bestDur = this._getDurabilityInfo(best)?.remaining || 0;
                const currentDur = this._getDurabilityInfo(current)?.remaining || 0;
                return currentDur > bestDur ? current : best;
            });

            await this.bot.equip(bestTool, 'hand');
            
            const durability = this._getDurabilityInfo(bestTool);
            console.log(`[AutoTool] 已切换到备用工具: ${bestTool.name} (${durability.remaining} 耐久)`);
            sendToOwner(this.bot, `✅ 已切换到备用【${this._getToolDisplayName(bestTool)}】(${durability.remaining} 耐久)`);
        } catch (err) {
            console.error('[AutoTool] 切换工具失败:', err.message);
        }
    }

    _updateWarningCache() {
        // 清理已经不存在的物品的预警记录
        const currentTools = this._getAllTools();
        const currentKeys = new Set(currentTools.map(t => this._getItemKey(t)));

        for (const key of this.warnedItems.keys()) {
            if (!currentKeys.has(key)) {
                this.warnedItems.delete(key);
            }
        }
    }

    _getAllTools() {
        return this.bot.inventory.items().filter(item => this._isTool(item));
    }

    _isTool(item) {
        if (!item || !item.name) return false;
        
        for (const tools of Object.values(TOOL_TYPES)) {
            if (tools.includes(item.name)) return true;
        }
        
        return false;
    }

    _getToolType(item) {
        if (!item || !item.name) return null;
        
        for (const [type, tools] of Object.entries(TOOL_TYPES)) {
            if (tools.includes(item.name)) return type;
        }
        
        return null;
    }

    _groupToolsByType(tools) {
        const grouped = {};
        
        for (const tool of tools) {
            const type = this._getToolType(tool);
            if (type) {
                if (!grouped[type]) grouped[type] = [];
                grouped[type].push(tool);
            }
        }
        
        return grouped;
    }

    _getDurabilityInfo(item) {
        if (!item || item.maxDurability === undefined) return null;
        
        const used = item.durabilityUsed || 0;
        const max = item.maxDurability;
        const remaining = max - used;
        const percentage = Math.round((remaining / max) * 100);
        
        return { remaining, max, percentage, used };
    }

    _getItemKey(item) {
        // 使用物品的唯一标识（名称 + 槽位 + 耐久）
        const durability = this._getDurabilityInfo(item);
        return `${item.name}_${item.slot}_${durability?.remaining || 0}`;
    }

    _getToolDisplayName(item) {
        // 将内部名称转换为更友好的显示名称
        return item.displayName || item.name.replace(/_/g, ' ');
    }

    // 获取工具状态报告（供外部调用）
    getToolReport() {
        const tools = this._getAllTools();
        const report = {
            total: tools.length,
            byType: {},
            warnings: [],
        };

        const grouped = this._groupToolsByType(tools);
        
        for (const [type, typeTools] of Object.entries(grouped)) {
            report.byType[type] = {
                count: typeTools.length,
                tools: typeTools.map(tool => {
                    const durability = this._getDurabilityInfo(tool);
                    return {
                        name: tool.name,
                        durability: durability,
                        status: this._getToolStatus(durability),
                    };
                }),
            };

            // 收集需要预警的工具
            for (const tool of typeTools) {
                const durability = this._getDurabilityInfo(tool);
                if (durability && durability.remaining <= DURABILITY_THRESHOLDS.WARNING) {
                    report.warnings.push({
                        name: tool.name,
                        durability: durability,
                    });
                }
            }
        }

        return report;
    }

    _getToolStatus(durability) {
        if (!durability) return 'unknown';
        
        if (durability.remaining <= DURABILITY_THRESHOLDS.CRITICAL) return 'critical';
        if (durability.remaining <= DURABILITY_THRESHOLDS.WARNING) return 'warning';
        if (durability.remaining <= DURABILITY_THRESHOLDS.CAUTION) return 'caution';
        return 'good';
    }

    // 设置是否自动切换工具
    setAutoSwitch(enabled) {
        this.autoSwitch = enabled;
        console.log(`[AutoTool] 自动切换工具: ${enabled ? '启用' : '禁用'}`);
    }

    // 手动切换到最佳工具（供外部调用）
    async switchToBestTool(toolType) {
        const tools = this._getAllTools().filter(t => this._getToolType(t) === toolType);
        
        if (tools.length === 0) {
            console.log(`[AutoTool] 没有找到类型为 ${toolType} 的工具`);
            return false;
        }

        // 选择耐久最高的
        const bestTool = tools.reduce((best, current) => {
            const bestDur = this._getDurabilityInfo(best)?.remaining || 0;
            const currentDur = this._getDurabilityInfo(current)?.remaining || 0;
            return currentDur > bestDur ? current : best;
        });

        try {
            await this.bot.equip(bestTool, 'hand');
            const durability = this._getDurabilityInfo(bestTool);
            console.log(`[AutoTool] 已切换到最佳工具: ${bestTool.name} (${durability.remaining} 耐久)`);
            return true;
        } catch (err) {
            console.error('[AutoTool] 切换工具失败:', err.message);
            return false;
        }
    }
}

module.exports = AutoTool;
