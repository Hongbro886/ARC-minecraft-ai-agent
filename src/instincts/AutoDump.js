const { Vec3 } = require('vec3');
const GoTo = require('../actions/move/GoTo'); // 引入你提供的健壮 GoTo 类
const { sendToOwner } = require('../utils/chat');

// 清包时需要保留的非工具物品
const KEEP_ITEMS = [
    'cooked_beef', 'bread', 'apple', 'golden_apple', // 食物
    'torch', 'water_bucket', 'shield'                // 探险必需品
];

// 需要进行“择优保留”的工具类型
const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'];

class AutoDump {
    constructor(bot, getCurrentAction) {
        this.bot = bot;
        this.getCurrentAction = getCurrentAction;
        this.isDumping = false;
        this.checkCooldown = false; // 用于防抖
    }

    mount() {
        this.bot.inventory.on('updateSlot', () => {
            this._debouncedCheck();
        });
        console.log('[AutoDump] 自动清包本能已挂载');
    }

    _debouncedCheck() {
        if (this.isDumping || this.checkCooldown) return;
        
        this.checkCooldown = true;
        setTimeout(() => {
            this.checkCooldown = false;
            this._check();
        }, 1000); 
    }

    async _check() {
        if (this.isDumping) return;
        
        if (this.bot.inventory.emptySlotCount() > 2) return;

        this.isDumping = true;
        
        const action = this.getCurrentAction();
        if (action && typeof action.pause === 'function' && !action.isPaused) {
            action.pause();
        }

        sendToOwner(this.bot, '🎒 我的背包满了！正在执行 /home 回家清理物资...');

        try {
            sendToOwner(this.bot, '/home');
            await this.bot.waitForTicks(60);

            const targetChests = await this._findBotChests();

            if (!targetChests || targetChests.length === 0) {
                sendToOwner(this.bot, '⚠️ 我回到家了，但是附近没有找到贴有 "bot" 告示牌的箱子！');
                return;
            }

            let dumped = false;
            for (const chestBlock of targetChests) {
                if (this.bot.inventory.emptySlotCount() >= 10) break;
                
                await this._goto(chestBlock.position);
                await this._dumpItems(chestBlock);
                dumped = true;
            }

            if (this.bot.inventory.emptySlotCount() <= 2) {
                sendToOwner(this.bot, '⚠️ 所有的 Bot 箱子都满了！我无法完全清理背包，请主人更换箱子。');
            } else if (dumped) {
                sendToOwner(this.bot, '✅ 物资清理完毕，正在执行 /back 返回工作地点...');
                sendToOwner(this.bot, '/back');
                await this.bot.waitForTicks(60); 
            }

        } catch (err) {
            console.error('[AutoDump] 清理背包失败:', err);
            sendToOwner(this.bot, `❌ 清理背包发生异常: ${err.message}`);
        } finally {
            this.isDumping = false;
            if (action && typeof action.resume === 'function' && action.isPaused) {
                action.resume();
            }
        }
    }

    async _goto(targetPos) {
        const distance = this.bot.entity.position.distanceTo(targetPos);
        if (distance <= 3) return;

        return new Promise((resolve) => {
            console.log(`[AutoDump] 正在前往箱子位置: ${targetPos}`);
            
            const gotoAction = new GoTo(this.bot, {
                coords: [targetPos.x, targetPos.y, targetPos.z],
                range: 2 
            });

            gotoAction.on('stop', (reason) => {
                resolve(); 
            });

            gotoAction.execute();
        });
    }

    async _findBotChests() {
        const mcData = require('minecraft-data')(this.bot.version);
        const chestNames = ['chest', 'trapped_chest', 'barrel'];
        const chestIds = chestNames
            .map(name => mcData.blocksByName[name]?.id)
            .filter(id => id !== undefined);

        const chests = this.bot.findBlocks({
            matching: chestIds,
            maxDistance: 15,
            count: 50
        });

        const validChests = [];
        for (const chestPos of chests) {
            if (this._hasBotSignNearby(chestPos)) {
                validChests.push(this.bot.blockAt(chestPos));
            }
        }
        return validChests; 
    }

    _hasBotSignNearby(chestPos) {
        const offsets = [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1),
            new Vec3(0, 1, 0), new Vec3(0, -1, 0)
        ];

        for (const offset of offsets) {
            const pos = chestPos.plus(offset);
            const block = this.bot.blockAt(pos);
            
            if (block && (block.name.includes('sign') || block.name.includes('wall_sign'))) {
                const signText = this._getSignText(block, pos);
                if (signText.toLowerCase().includes('bot')) {
                    return true;
                }
            }
        }
        return false;
    }

    _getSignText(block, pos) {
        if (block.signText) {
            return block.signText;
        }

        let blockEntity = null;
        if (this.bot.blockEntities) {
            blockEntity = Object.values(this.bot.blockEntities).find(
                be => be.x === pos.x && be.y === pos.y && be.z === pos.z
            );
        }

        if (!blockEntity) return '';
        
        let text = '';
        try {
            if (blockEntity.front_text?.messages) {
                text += blockEntity.front_text.messages.map(m => this._parseRawText(m)).join('');
            }
            if (blockEntity.back_text?.messages) {
                text += blockEntity.back_text.messages.map(m => this._parseRawText(m)).join('');
            }
            if (blockEntity.Text1) text += this._parseRawText(blockEntity.Text1);
            if (blockEntity.Text2) text += this._parseRawText(blockEntity.Text2);
            if (blockEntity.Text3) text += this._parseRawText(blockEntity.Text3);
            if (blockEntity.Text4) text += this._parseRawText(blockEntity.Text4);
        } catch (e) {
            text = JSON.stringify(blockEntity);
        }
        return text;
    }

    _parseRawText(rawText) {
        if (!rawText) return '';
        try {
            const parsed = JSON.parse(rawText);
            if (typeof parsed === 'string') return parsed;
            if (parsed.text) return parsed.text;
            if (parsed.extra) return parsed.extra.map(e => e.text || '').join('');
        } catch (e) {
            return rawText; 
        }
        return '';
    }

    /**
     * 评估背包中的所有工具，返回需要保留的最佳工具的 Slot ID 集合
     */
    _getBestToolsSlots() {
        const bestTools = new Map(); // key: 工具类型 (如 pickaxe), value: item 对象

        // 材质评级：下界合金 > 钻石 > 铁 > 金 > 石 > 木
        const getMaterialRank = (itemName) => {
            if (itemName.startsWith('netherite_')) return 6;
            if (itemName.startsWith('diamond_')) return 5;
            if (itemName.startsWith('iron_')) return 4;
            if (itemName.startsWith('golden_')) return 3;
            if (itemName.startsWith('stone_')) return 2;
            if (itemName.startsWith('wooden_')) return 1;
            return 0;
        };

        for (const item of this.bot.inventory.items()) {
            for (const toolType of TOOL_TYPES) {
                if (item.name.endsWith(`_${toolType}`)) {
                    const currentRank = getMaterialRank(item.name);
                    const existingBest = bestTools.get(toolType);
                    
                    if (!existingBest) {
                        bestTools.set(toolType, item);
                    } else {
                        const existingRank = getMaterialRank(existingBest.name);
                        
                        // 1. 优先比较材质
                        if (currentRank > existingRank) {
                            bestTools.set(toolType, item);
                        } 
                        // 2. 如果材质相同，比较损坏程度 (durabilityUsed 越小越好)
                        else if (currentRank === existingRank) {
                            const currentDamage = item.durabilityUsed || 0;
                            const existingDamage = existingBest.durabilityUsed || 0;
                            if (currentDamage < existingDamage) {
                                bestTools.set(toolType, item);
                            }
                        }
                    }
                }
            }
        }
        
        // 将最佳工具的背包格子号 (slot) 存入 Set 并返回
        const keepSlots = new Set();
        for (const item of bestTools.values()) {
            keepSlots.add(item.slot);
        }
        return keepSlots;
    }

    async _dumpItems(chestBlock) {
        let chest;
        try {
            chest = await this.bot.openContainer(chestBlock);
        } catch (err) {
            console.error(`[AutoDump] 无法打开箱子 ${chestBlock.position}:`, err.message);
            return;
        }

        // 获取需要保留的最佳工具的格子号
        const bestToolSlots = this._getBestToolsSlots();

        try {
            for (const item of this.bot.inventory.items()) {
                
                // 判断当前物品是否是工具
                const isTool = TOOL_TYPES.some(type => item.name.endsWith(`_${type}`));
                
                if (isTool) {
                    // 如果是工具，且在最佳工具列表中，则保留不存
                    if (bestToolSlots.has(item.slot)) continue;
                } else {
                    // 如果不是工具，检查是否在常规保留列表中 (食物、火把等)
                    const shouldKeep = KEEP_ITEMS.some(suffix => item.name.endsWith(suffix) || item.name === suffix);
                    if (shouldKeep) continue;
                }

                try {
                    await chest.deposit(item.type, item.metadata, item.count);
                    await this.bot.waitForTicks(5); 
                } catch (err) {
                    if (err.message.includes('full') || err.message.includes('destination full')) {
                        console.log(`[AutoDump] 当前箱子已满，停止存入。`);
                        break; 
                    }
                    console.log(`[AutoDump] 存入 ${item.name} 失败:`, err.message);
                }
            }
        } finally {
            try {
                await chest.close();
            } catch (closeErr) {
                console.error('[AutoDump] 关闭箱子失败:', closeErr.message);
            }
        }
    }
}

module.exports = AutoDump;
