const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class StoreItemsAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 要存放的物品名称列表，例如 ['cobblestone', 'dirt']。如果为空数组或未定义，则存放所有物品
        this.itemNames = params.item_names || [];
        // 扫描半径，默认 20 格
        this.radius = params.radius || 20;
        
        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            
            // 1. 获取所有可能的容器方块 ID
            const containerNames = ['chest', 'trapped_chest', 'barrel'];
            const containerIds = containerNames
                .map(name => mcData.blocksByName[name] ? mcData.blocksByName[name].id : null)
                .filter(id => id !== null);

            if (containerIds.length === 0) {
                sendToOwner(this.bot, '❌ 当前版本无法识别任何箱子或木桶方块。');
                return this.stop('no_container_blocks');
            }

            // 2. 扫描附近的容器
            const chests = this.bot.findBlocks({
                matching: containerIds,
                maxDistance: this.radius,
                count: 64 // 最多找 64 个箱子备用
            });

            if (chests.length === 0) {
                sendToOwner(this.bot, `⚠️ 在 ${this.radius} 格范围内没有找到任何箱子或木桶！`);
                return this.stop('no_chests_found');
            }

            // 按距离从近到远排序
            chests.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));

            const isStoreAll = this.itemNames.length === 0;
            if (isStoreAll) {
                sendToOwner(this.bot, '📦 准备将背包中【所有物品】存入最近的箱子...');
            } else {
                sendToOwner(this.bot, `📦 准备将【${this.itemNames.join(', ')}】存入最近的箱子...`);
            }

            // 3. 遍历找到的箱子，直到物品存完
            for (const chestPos of chests) {
                if (!this.isExecuting) break;
                while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

                // 每次尝试新箱子前，重新检查背包里是否还有需要存放的物品
                let itemsToStore = this._getItemsToStore();
                if (itemsToStore.length === 0) {
                    sendToOwner(this.bot, '✅ 物品已全部存放完毕！');
                    return this.stop('success');
                }

                // 寻路到箱子附近
                const distance = this.bot.entity.position.distanceTo(chestPos);
                if (distance > 3) {
                    if (this.bot.pathfinder) {
                        const { goals } = require('mineflayer-pathfinder');
                        try {
                            // 走到距离箱子 1.5 格以内
                            await this.bot.pathfinder.goto(new goals.GoalNear(chestPos.x, chestPos.y, chestPos.z, 1.5));
                        } catch (moveErr) {
                            console.log(`[StoreItemsAction] 无法到达箱子位置: ${chestPos}, 尝试下一个`);
                            continue;
                        }
                    } else {
                        console.log(`[StoreItemsAction] 箱子太远且未安装 pathfinder，跳过: ${chestPos}`);
                        continue;
                    }
                }

                if (!this.isExecuting) break;

                // 4. 打开箱子并存放物品
                const chestBlock = this.bot.blockAt(chestPos);
                let chestWindow;
                try {
                    chestWindow = await this.bot.openContainer(chestBlock);
                } catch (openErr) {
                    console.log(`[StoreItemsAction] 无法打开箱子 (可能被方块挡住): ${openErr.message}`);
                    continue; // 打不开就尝试下一个箱子
                }

                console.log(`[StoreItemsAction] 成功打开箱子 @ ${chestPos}`);
                let isChestFull = false;

                // 逐个存放物品
                for (const item of itemsToStore) {
                    if (!this.isExecuting) break;
                    while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

                    try {
                        // 使用 deposit 存入指定类型和数量的物品
                        await chestWindow.deposit(item.type, item.metadata, item.count);
                        console.log(`[StoreItemsAction] 存入了 ${item.count} 个 ${item.name}`);
                        
                        // 稍微等待，防止发包过快
                        await new Promise(resolve => setTimeout(resolve, 400));
                    } catch (depositErr) {
                        // deposit 抛出错误通常是因为箱子满了
                        console.log(`[StoreItemsAction] 存入 ${item.name} 失败，箱子可能已满。`);
                        isChestFull = true;
                        break; // 跳出当前箱子的存放循环
                    }
                }

                // 关上箱子
                try {
                    await chestWindow.close();
                } catch (closeErr) {
                    console.log(`[StoreItemsAction] 关闭箱子异常: ${closeErr.message}`);
                }

                if (!this.isExecuting) return;

                // 再次检查是否还有剩余物品
                itemsToStore = this._getItemsToStore();
                if (itemsToStore.length === 0) {
                    sendToOwner(this.bot, '✅ 物品已全部存放完毕！');
                    return this.stop('success');
                } else if (isChestFull) {
                    sendToOwner(this.bot, '⚠️ 当前箱子已满，正在寻找下一个箱子...');
                    // 稍微等待后走向下一个箱子
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // 如果遍历了所有箱子还是没存完
            if (this.isExecuting) {
                const remaining = this._getItemsToStore();
                if (remaining.length > 0) {
                    sendToOwner(this.bot, '⚠️ 附近所有的箱子都满了（或无法到达），还有部分物品未存放！');
                    return this.stop('all_chests_full');
                }
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[StoreItemsAction] 执行异常:`, err.message);
            sendToOwner(this.bot, `❌ 存放异常: ${err.message}`);
            this.stop('execute_error');
        }
    }

    // 辅助方法：获取背包中需要存放的物品列表
    _getItemsToStore() {
        const allItems = this.bot.inventory.items();
        const isStoreAll = this.itemNames.length === 0;

        if (isStoreAll) {
            return allItems;
        } else {
            return allItems.filter(item => this.itemNames.includes(item.name));
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 暂停时停止移动
        }
        console.log(`[StoreItemsAction] 动作已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[StoreItemsAction] 动作已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 停止时打断寻路
        }

        console.log(`[StoreItemsAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = StoreItemsAction;
