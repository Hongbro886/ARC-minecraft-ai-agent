const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class DropItemAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 要丢弃的物品名称
        this.itemName = params.item_name;
        // 要丢弃的数量，-1 表示全部丢弃
        this.targetCount = params.count !== undefined ? params.count : 1;
        
        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const itemData = mcData.itemsByName[this.itemName];

            if (!itemData) {
                sendToOwner(this.bot, `❌ 无法识别的物品: ${this.itemName}`);
                return this.stop('invalid_item');
            }

            // 1. 查找背包中所有该类型的物品
            const itemsInInventory = this.bot.inventory.items().filter(i => i.name === this.itemName);
            
            if (itemsInInventory.length === 0) {
                sendToOwner(this.bot, `⚠️ 背包中没有【${this.itemName}】，无法丢弃。`);
                return this.stop('no_item_in_inventory');
            }

            // 2. 计算总拥有量和实际需要丢弃的数量
            const totalAvailable = itemsInInventory.reduce((sum, item) => sum + item.count, 0);
            let remainingToDrop = this.targetCount === -1 ? totalAvailable : Math.min(this.targetCount, totalAvailable);

            if (this.targetCount !== -1 && this.targetCount > totalAvailable) {
                sendToOwner(this.bot, `⚠️ 背包中的【${this.itemName}】数量不足，只有 ${totalAvailable} 个，将全部丢弃。`);
            }

            console.log(`[DropItemAction] 准备丢弃 ${remainingToDrop} 个 ${this.itemName}`);

            // 3. 遍历物品堆并逐个丢弃
            for (const item of itemsInInventory) {
                if (!this.isExecuting) break;
                while (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                if (remainingToDrop <= 0) break;

                // 计算当前这堆物品需要丢弃的数量
                const dropCount = Math.min(item.count, remainingToDrop);

                try {
                    // 使用 bot.toss 丢弃指定数量的物品
                    await this.bot.toss(item.type, item.metadata, dropCount);
                    remainingToDrop -= dropCount;
                    console.log(`[DropItemAction] 成功丢弃了 ${dropCount} 个 ${this.itemName}，还需丢弃 ${remainingToDrop} 个`);
                    
                    // 稍微等待，防止发包过快
                    await new Promise(resolve => setTimeout(resolve, 400));
                } catch (tossErr) {
                    if (!this.isExecuting) return;
                    console.error(`[DropItemAction] 丢弃物品失败:`, tossErr.message);
                    sendToOwner(this.bot, `❌ 丢弃【${this.itemName}】时发生错误。`);
                    return this.stop('toss_error');
                }
            }

            if (!this.isExecuting) return;

            const droppedTotal = (this.targetCount === -1 ? totalAvailable : Math.min(this.targetCount, totalAvailable)) - remainingToDrop;
            sendToOwner(this.bot, `✅ 已成功丢弃 ${droppedTotal} 个【${this.itemName}】！`);
            this.stop('success');

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[DropItemAction] 执行异常:`, err.message);
            sendToOwner(this.bot, `❌ 丢弃异常: ${err.message}`);
            this.stop('execute_error');
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        console.log(`[DropItemAction] 动作已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[DropItemAction] 动作已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;

        console.log(`[DropItemAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = DropItemAction;
