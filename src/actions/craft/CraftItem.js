const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class CraftItem extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.itemName = params.item_name;
        this.count = params.count || 1;

        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;
        const mcData = require('minecraft-data')(this.bot.version);
        const tableId = mcData.blocksByName['crafting_table'].id;

        // 【核心修复】：临时劫持 bot.findBlock，欺骗 Agent 框架的距离检测
        const originalFindBlock = this.bot.findBlock;
        this.bot.findBlock = (options) => {
            let isSearchingTable = false;
            if (options && options.matching !== undefined) {
                if (options.matching === tableId) isSearchingTable = true;
                else if (Array.isArray(options.matching) && options.matching.includes(tableId)) isSearchingTable = true;
                else if (typeof options.matching === 'function' && options.matching({ type: tableId })) isSearchingTable = true;
            }

            // 如果框架在找工作台，直接返回一个在玩家脚下的虚拟工作台
            if (isSearchingTable) {
                return {
                    type: tableId,
                    name: 'crafting_table',
                    position: this.bot.entity.position.clone(), // 伪造在脚下，距离为 0
                    isValid: true
                };
            }
            // 找其他方块则走原有逻辑
            return originalFindBlock.call(this.bot, options);
        };

        try {
            const item = mcData.itemsByName[this.itemName];

            if (!item) {
                sendToOwner(this.bot, `❌ 无法识别的物品: ${this.itemName}`);
                this.stop('invalid_item');
                return;
            }

            // 1. 检查游戏内是否存在该物品的配方
            const allRecipes = this.bot.recipesAll(item.id, null, true);
            if (!allRecipes || allRecipes.length === 0) {
                sendToOwner(this.bot, `❌ 游戏内不存在【${this.itemName}】的合成配方！`);
                this.stop('no_recipe');
                return;
            }

            // 2. 判断是否需要工作台
            const needsCraftingTable = allRecipes[0].requiresTable;
            let craftingWindow = null;
            let fakeBlock = null;

            if (needsCraftingTable) {
                craftingWindow = await this._openVirtualCraftingTable();
                if (!craftingWindow) {
                    sendToOwner(this.bot, '无法打开虚拟工作台');
                    this.stop('no_crafting_table');
                    return;
                }
                
                fakeBlock = {
                    type: tableId,
                    name: 'crafting_table',
                    position: this.bot.entity.position.clone(),
                    isValid: true
                };
            }

            // 3. 检查背包材料是否充足
            const availableRecipes = this.bot.recipesFor(item.id, null, 1, fakeBlock);
            if (!availableRecipes || availableRecipes.length === 0) {
                sendToOwner(this.bot, `材料不足，无法合成【${this.itemName}】`);
                if (craftingWindow) this.bot.closeWindow(craftingWindow);
                this.stop('insufficient_materials');
                return;
            }

            // 4. 开始合成
            const recipeToUse = availableRecipes[0];
            console.log(`[CraftItem] 开始合成 ${this.count} 个 ${this.itemName}`);

            await this._craftWithVirtualTable(recipeToUse, this.count, fakeBlock, craftingWindow);

            console.log(`[CraftItem] 成功合成 ${this.count} 个 ${this.itemName}`);
            sendToOwner(this.bot, `✅ 成功合成 ${this.count} 个【${this.itemName}】！`);

            // 5. 合成完毕，关闭窗口
            if (craftingWindow) {
                this.bot.closeWindow(craftingWindow);
            }

            this.stop('success');

        } catch (err) {
            if (!this.isExecuting) return;

            console.error(`[CraftItem] 合成失败:`, err);
            sendToOwner(this.bot, `❌ 合成【${this.itemName}】失败: ${err.message}`);
            this.stop('craft_error');
        } finally {
            // 【核心修复】：无论成功还是失败，务必还原 findBlock，避免影响后续其他任务
            this.bot.findBlock = originalFindBlock;
        }
    }

    async _craftWithVirtualTable(recipe, count, fakeBlock, craftingWindow) {
        if (!craftingWindow) {
            await this.bot.craft(recipe, count, null);
            return;
        }

        const self = this;
        const originalActivateBlock = this.bot.activateBlock;
        this.bot.activateBlock = function () {
            setTimeout(() => self.bot.emit('windowOpen', craftingWindow), 0);
            return Promise.resolve();
        };

        try {
            await this.bot.craft(recipe, count, fakeBlock);
        } finally {
            this.bot.activateBlock = originalActivateBlock;
        }
    }

    async _openVirtualCraftingTable() {
        return new Promise((resolve) => {
            let settled = false;

            const onWindowOpen = (window) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.bot.removeListener('windowOpen', onWindowOpen);
                console.log(`[CraftItem] 虚拟合成台已打开，type=${window.type}, id=${window.id}`);
                resolve(window);
            };

            const timer = setTimeout(() => {
                if (settled) return;
                this.bot.removeListener('windowOpen', onWindowOpen);
                console.warn('[CraftItem] /workbench 超时（3s），未能打开合成台');
                resolve(null);
            }, 3000);

            this.bot.on('windowOpen', onWindowOpen);
            sendToOwner(this.bot, '/workbench');
        });
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        console.log('[CraftItem] 合成动作已暂停');
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log('[CraftItem] 合成动作已恢复');
    }
    
    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;

        console.log(`[CraftItem] 动作结束，原因: ${reason}`);
        
        // 👇 新增：强制关闭可能打开的窗口，打断 bot.craft() 的内部等待
        const currentWindow = this.bot.currentWindow;
        if (currentWindow) {
            this.bot.closeWindow(currentWindow);
        }
        
        // 👇 新增：清空可能存在的寻路和按键状态（防止 craft 内部触发了移动）
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null);
        }
        this.bot.clearControlStates();

        this.emit('stop', reason);
    }

}

module.exports = CraftItem;
