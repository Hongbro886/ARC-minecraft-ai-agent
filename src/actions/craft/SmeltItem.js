const { EventEmitter } = require('events');
const GoTo = require('../move/GoTo'); // ⚠️ 确保路径正确，引入你写的健壮的 GoTo 类
const { sendToOwner } = require('../../utils/chat');

// 常用燃料燃烧 ticks 表（每200 ticks烧1个物品）
const FUEL_BURN_TICKS = {
    coal: 1600, charcoal: 1600, coal_block: 16000,
    blaze_rod: 2400, lava_bucket: 20000, dried_kelp_block: 4000,
    oak_log: 300, spruce_log: 300, birch_log: 300,
    jungle_log: 300, acacia_log: 300, dark_oak_log: 300,
    mangrove_log: 300, cherry_log: 300,
    oak_planks: 300, spruce_planks: 300, birch_planks: 300,
    jungle_planks: 300, acacia_planks: 300, dark_oak_planks: 300,
    mangrove_planks: 300, cherry_planks: 300,
    bamboo: 50, bamboo_block: 2500, stick: 100,
    wooden_pickaxe: 200, wooden_axe: 200, wooden_shovel: 200,
    wooden_sword: 200, wooden_hoe: 200,
    bowl: 200, crafting_table: 300, bookshelf: 300,
    chest: 300, trapped_chest: 300, fence: 300, fence_gate: 300,
};

const TICKS_PER_ITEM = 200;

function calcFuelNeeded(fuelName, count) {
    const burnTicks = FUEL_BURN_TICKS[fuelName];
    if (!burnTicks) return -1;
    return Math.ceil((count * TICKS_PER_ITEM) / burnTicks);
}

class SmeltItem extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.inputItem = params.input_item;
        this.fuelItem = params.fuel_item;
        this.count = params.count || 1;
        this.searchRadius = params.radius || 32;

        this.isPaused = false;
        this.isExecuting = false;
        this.furnaceBlock = null;
        this.furnaceWindow = null;
        
        this.gotoTask = null; // 用于保存当前的 GoTo 任务实例
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);

            // 1. 在 radius 范围内搜索熔炉
            const furnacePos = this.bot.findBlock({
                matching: mcData.blocksByName.furnace.id,
                maxDistance: this.searchRadius,
            });

            if (!furnacePos) {
                sendToOwner(this.bot, `⚠️ ${this.searchRadius} 格内找不到熔炉！`);
                this.stop('no_furnace');
                return;
            }

            this.furnaceBlock = this.bot.blockAt(furnacePos.position);
            console.log(`[SmeltItem] 找到熔炉: ${furnacePos.position}`);

            // 2. 使用健壮的 GoTo 类寻路前往熔炉
            const reached = await this._walkToFurnace(furnacePos.position);
            if (!reached) {
                sendToOwner(this.bot, `⚠️ 无法到达熔炉！`);
                this.stop('cannot_reach_furnace');
                return;
            }

            if (!this.isExecuting) return;

            // 3. 打开熔炉界面
            this.furnaceWindow = await this.bot.openFurnace(this.furnaceBlock);

            // 4. 检查背包中的原料数量
            const inputItemObj = this.bot.inventory.items().find(i => i.name === this.inputItem);
            if (!inputItemObj) {
                sendToOwner(this.bot, `⚠️ 背包中没有【${this.inputItem}】！`);
                this._closeWindow();
                this.stop('no_input_item');
                return;
            }

            const putAmount = Math.min(this.count, inputItemObj.count);

            // 5. 计算所需燃料数量
            const fuelNeeded = calcFuelNeeded(this.fuelItem, putAmount);
            if (fuelNeeded === -1) {
                sendToOwner(this.bot, `⚠️ 不支持的燃料类型【${this.fuelItem}】！`);
                this._closeWindow();
                this.stop('unsupported_fuel');
                return;
            }

            // 6. 检查背包中的燃料数量是否充足
            const fuelItemObj = this.bot.inventory.items().find(i => i.name === this.fuelItem);
            if (!fuelItemObj) {
                sendToOwner(this.bot, `⚠️ 背包中没有燃料【${this.fuelItem}】！`);
                this._closeWindow();
                this.stop('no_fuel');
                return;
            }

            if (fuelItemObj.count < fuelNeeded) {
                sendToOwner(this.bot, 
                    `⚠️ 燃料不足！烧制 ${putAmount} 个【${this.inputItem}】需要 ${fuelNeeded} 个【${this.fuelItem}】，` +
                    `但背包中只有 ${fuelItemObj.count} 个。`
                );
                this._closeWindow();
                this.stop('insufficient_fuel');
                return;
            }

            // 7. 放入原料
            await this.furnaceWindow.putInput(inputItemObj.type, null, putAmount);
            
            // 8. 放入燃料（精确数量）
            await this.furnaceWindow.putFuel(fuelItemObj.type, null, fuelNeeded);

            sendToOwner(this.bot, 
                `🔥 已放入 ${putAmount} 个【${this.inputItem}】和 ${fuelNeeded} 个【${this.fuelItem}】，开始烧制...`
            );

            // 9. 等待烧制完成
            let lastOutputCount = 0;
            await new Promise((resolve) => {
                const checkOutput = setInterval(() => {
                    if (!this.isExecuting) {
                        clearInterval(checkOutput);
                        resolve();
                        return;
                    }

                    if (this.isPaused) return;

                    const outputSlot = this.furnaceWindow.outputItem();
                    const currentOutputCount = outputSlot ? outputSlot.count : 0;

                    if (currentOutputCount > lastOutputCount) {
                        console.log(`[SmeltItem] 烧制进度: ${currentOutputCount}/${putAmount}`);
                        lastOutputCount = currentOutputCount;
                    }

                    if (currentOutputCount >= putAmount) {
                        clearInterval(checkOutput);
                        resolve();
                    }
                }, 1000);
            });

            // 10. 取出成品
            if (this.isExecuting) {
                await this.furnaceWindow.takeOutput();
                this._closeWindow();
                console.log(`[SmeltItem] 烧制完成，已取出成品`);
                sendToOwner(this.bot, `✅ 烧制完成，已取出 ${putAmount} 个成品！`);
                this.stop('success');
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[SmeltItem] 烧制失败:`, err);
            sendToOwner(this.bot, `❌ 烧制失败: ${err.message}`);
            this._closeWindow();
            this.stop('smelt_error');
        }
    }

    /**
     * 调用健壮的 GoTo 类前往熔炉
     */
    async _walkToFurnace(pos) {
        return new Promise((resolve) => {
            sendToOwner(this.bot, `🚶 正在前往熔炉 (${pos.x}, ${pos.y}, ${pos.z})...`);
            
            // 实例化你的 GoTo 类
            this.gotoTask = new GoTo(this.bot, {
                coords: [pos.x, pos.y, pos.z],
                range: 2 // 走到距离熔炉2格以内即可
            });

            // 监听 GoTo 任务的结束事件
            this.gotoTask.once('stop', (reason) => {
                this.gotoTask = null; // 清理实例
                
                if (reason === 'success') {
                    console.log('[SmeltItem] 已成功到达熔炉');
                    resolve(true);
                } else {
                    console.log(`[SmeltItem] 寻路到熔炉失败，原因: ${reason}`);
                    resolve(false);
                }
            });

            // 开始执行寻路
            this.gotoTask.execute();
        });
    }

    /** 安全关闭熔炉窗口 */
    _closeWindow() {
        if (this.furnaceWindow) {
            try { this.furnaceWindow.close(); } catch (e) {}
            this.furnaceWindow = null;
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        
        // 如果正在寻路，连同寻路一起暂停
        if (this.gotoTask) {
            this.gotoTask.pause();
        } else {
            this.bot.clearControlStates();
        }
        console.log('[SmeltItem] 烧制动作已暂停');
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        
        // 如果之前在寻路，恢复寻路
        if (this.gotoTask) {
            this.gotoTask.resume();
        }
        console.log('[SmeltItem] 烧制动作已恢复');
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        // 如果正在寻路，强制停止寻路子任务
        if (this.gotoTask) {
            this.gotoTask.stop(reason);
            this.gotoTask = null;
        }

        this._closeWindow();
        this.bot.clearControlStates();

        console.log(`[SmeltItem] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = SmeltItem;
