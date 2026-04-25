const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class TakeItemsAction extends EventEmitter {
    constructor(bot, params = {}) {
        super();
        this.bot = bot;
        // 要取出的物品名称列表；留空=全取
        this.itemNames = params.item_names || [];
        this.radius = params.radius || 20;

        // 需要保留的背包空格数量（默认 5）
        // 当 item_names 为空（全取模式）时生效
        this.keepEmptySlots = Number.isInteger(params.keep_empty_slots) ? params.keep_empty_slots : 5;

        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);

            const containerNames = ['chest', 'trapped_chest', 'barrel'];
            const containerIds = containerNames
                .map(name => mcData.blocksByName[name] ? mcData.blocksByName[name].id : null)
                .filter(id => id !== null);

            if (containerIds.length === 0) {
                sendToOwner(this.bot, '❌ 当前版本无法识别任何箱子或木桶方块。');
                return this.stop('no_container_blocks');
            }

            // 1. 寻找附近所有箱子
            const chests = this.bot.findBlocks({
                matching: containerIds,
                maxDistance: this.radius,
                count: 64
            });

            if (chests.length === 0) {
                sendToOwner(this.bot, `⚠️ 在 ${this.radius} 格范围内没有找到任何箱子或木桶！`);
                return this.stop('no_chests_found');
            }

            // 2. 排序并只取最近的一个箱子
            chests.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));
            const closestChestPos = chests[0];

            const isTakeAll = this.itemNames.length === 0;
            if (isTakeAll) {
                sendToOwner(this.bot, `📥 全取模式：将从最近的箱子取物，直到背包仅剩 ${this.keepEmptySlots} 个空格。`);
            } else {
                sendToOwner(this.bot, `📥 准备从最近的箱子取出【${this.itemNames.join(', ')}】...`);
            }

            // 3. 全取模式下，先检查初始空格阈值
            if (isTakeAll && this._getEmptyInventorySlots() <= this.keepEmptySlots) {
                sendToOwner(this.bot, `🛑 动作取消：当前背包空格已达到或低于保留阈值（<= ${this.keepEmptySlots}）。`);
                return this.stop('reach_keep_empty_slots');
            }

            // 4. 寻路到最近的箱子
            const distance = this.bot.entity.position.distanceTo(closestChestPos);
            if (distance > 3) {
                if (this.bot.pathfinder) {
                    const { goals } = require('mineflayer-pathfinder');
                    try {
                        await this.bot.pathfinder.goto(new goals.GoalNear(closestChestPos.x, closestChestPos.y, closestChestPos.z, 1.5));
                    } catch (err) {
                        sendToOwner(this.bot, `⚠️ 无法到达最近的箱子位置，路径被阻挡。`);
                        return this.stop('pathfind_failed');
                    }
                } else {
                    sendToOwner(this.bot, `⚠️ 最近的箱子太远且未安装 pathfinder 插件，无法前往。`);
                    return this.stop('too_far');
                }
            }

            if (!this.isExecuting) return;

            // 5. 打开箱子
            const chestBlock = this.bot.blockAt(closestChestPos);
            let chestWindow;
            try {
                chestWindow = await this.bot.openContainer(chestBlock);
            } catch (err) {
                sendToOwner(this.bot, `❌ 无法打开最近的箱子: ${err.message}`);
                return this.stop('open_chest_failed');
            }

            console.log(`[TakeItemsAction] 成功打开最近的箱子 @ ${closestChestPos}`);
            let takenAny = false;

            // 6. 提取物品逻辑
            try {
                // 兼容不同版本的 mineflayer API
                const containerItems = typeof chestWindow.containerItems === 'function'
                    ? chestWindow.containerItems()
                    : chestWindow.items();

                const targetItems = this._filterTargetItems(containerItems);
                
                if (targetItems.length === 0) {
                    sendToOwner(this.bot, '⚠️ 最近的箱子中没有你需要的目标物品。');
                    return this.stop('no_target_items_in_chest');
                }

                for (const item of targetItems) {
                    if (!this.isExecuting) break;
                    while (this.isPaused) await this._sleep(500);

                    // 每次取之前都检查（全取模式）
                    if (isTakeAll && this._getEmptyInventorySlots() <= this.keepEmptySlots) {
                        sendToOwner(this.bot, `🛑 背包空格已达到保留阈值（<= ${this.keepEmptySlots}），停止取物。`);
                        break;
                    }

                    // 计算本次最多可取数量，避免一次把背包塞爆
                    let withdrawCount = item.count;
                    if (isTakeAll) {
                        const safeCount = this._calcSafeWithdrawCount(item);
                        if (safeCount <= 0) {
                            sendToOwner(this.bot, `🛑 背包可用空间不足（需保留 ${this.keepEmptySlots} 空格），停止取物。`);
                            break;
                        }
                        withdrawCount = Math.min(item.count, safeCount);
                    }

                    if (withdrawCount <= 0) continue;

                    try {
                        await chestWindow.withdraw(item.type, item.metadata, withdrawCount);
                        console.log(`[TakeItemsAction] 成功取出了 ${withdrawCount} 个 ${item.name}`);
                        takenAny = true;
                        await this._sleep(350); // 适度延迟，防止发包过快被服务器踢出
                    } catch (err) {
                        console.log(`[TakeItemsAction] 取出 ${item.name} 失败: ${err.message}`);
                        if (/full|inventory|空间|slot/i.test(err.message || '')) {
                            sendToOwner(this.bot, '⚠️ 背包空间已满，停止取物。');
                            break;
                        }
                    }
                }
            } finally {
                // 无论发生什么，确保箱子被关闭
                try { 
                    await chestWindow.close(); 
                    console.log(`[TakeItemsAction] 箱子已关闭`);
                } catch (_) {}
            }

            if (!this.isExecuting) return;

            if (takenAny) {
                sendToOwner(this.bot, '✅ 取物完成！');
                return this.stop('success');
            } else {
                return this.stop('no_items_taken');
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[TakeItemsAction] 执行异常:`, err.message);
            sendToOwner(this.bot, `❌ 取物异常: ${err.message}`);
            this.stop('execute_error');
        }
    }

    _filterTargetItems(containerItems) {
        const isTakeAll = this.itemNames.length === 0;
        if (isTakeAll) return containerItems;
        return containerItems.filter(item => this.itemNames.includes(item.name));
    }

    // 获取背包空格数，使用原生 API 更加健壮
    _getEmptyInventorySlots() {
        const inv = this.bot.inventory;
        if (!inv) return 0;
        return inv.emptySlotCount();
    }

    // 估算当前物品最多还能安全取多少（保证空格 > keepEmptySlots）
    _calcSafeWithdrawCount(item) {
        const emptySlots = this._getEmptyInventorySlots();
        const allowedNewSlots = emptySlots - this.keepEmptySlots;
        
        // 先看现有同类堆叠还能塞多少（即使没有新槽位，填满现有堆叠也是安全的）
        const inventoryItems = this.bot.inventory.items();
        let stackRoom = 0;
        for (const invItem of inventoryItems) {
            if (
                invItem.type === item.type &&
                invItem.metadata === item.metadata &&
                invItem.count < invItem.stackSize
            ) {
                stackRoom += (invItem.stackSize - invItem.count);
            }
        }

        if (allowedNewSlots <= 0) {
            return stackRoom; 
        }

        // 允许新增槽位可容纳的数量
        const perStack = item.stackSize || 64;
        const newSlotsRoom = allowedNewSlots * perStack;

        return stackRoom + newSlotsRoom;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
        console.log(`[TakeItemsAction] 动作已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[TakeItemsAction] 动作已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
        console.log(`[TakeItemsAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = TakeItemsAction;
