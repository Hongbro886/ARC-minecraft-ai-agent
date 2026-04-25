const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class FishAction extends EventEmitter {
    constructor(bot, params = {}) {
        super();
        this.bot = bot;
        // 扫描水源的半径，默认 16 格
        this.radius = params.radius || 16;
        
        this.isPaused = false;
        this.isExecuting = false;
        
        this.failCount = 0; // 连续失败次数计数器
        this.maxFails = 5;  // 最大连续失败次数
        this.fishingTimeout = 40000; // 钓鱼超时时间（毫秒），40秒不上钩则重试
    }

    async execute() {
        this.isExecuting = true;
        this.failCount = 0;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const waterBlock = mcData.blocksByName.water;

            if (!waterBlock) {
                sendToOwner(this.bot, '❌ 当前版本无法识别水(water)方块');
                return this.stop('no_water_block');
            }

            sendToOwner(this.bot, `🎣 开始在 ${this.radius} 格范围内寻找水源并自动钓鱼...`);

            // 1. 寻找附近的水源
            const waterBlocks = this.bot.findBlocks({
                matching: waterBlock.id,
                maxDistance: this.radius,
                count: 128
            });

            if (waterBlocks.length === 0) {
                sendToOwner(this.bot, '❌ 附近没有找到任何水源。');
                return this.stop('no_water');
            }

            // 按距离排序，找到最近的水源
            waterBlocks.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));
            const targetWaterPos = waterBlocks[0];

            // 2. 移动到水边
            const distance = this.bot.entity.position.distanceTo(targetWaterPos);
            if (distance > 4) {
                if (this.bot.pathfinder) {
                    const { goals } = require('mineflayer-pathfinder');
                    try {
                        sendToOwner(this.bot, `🚶 正在前往水源...`);
                        // 走到距离水源 3 格的位置，避免掉进水里
                        await this.bot.pathfinder.goto(new goals.GoalNear(targetWaterPos.x, targetWaterPos.y, targetWaterPos.z, 3));
                    } catch (moveErr) {
                        console.log(`[FishAction] 无法到达水源位置: ${targetWaterPos}`);
                        sendToOwner(this.bot, `❌ 无法到达水源位置。`);
                        return this.stop('pathfinding_failed');
                    }
                } else {
                    console.log(`[FishAction] 水源太远且未安装 pathfinder。`);
                    sendToOwner(this.bot, `❌ 水源太远，请将我移动到水边。`);
                    return this.stop('too_far');
                }
            }

            sendToOwner(this.bot, `✅ 已到达水边，开始挂机钓鱼！`);

            // 3. 钓鱼主循环
            while (this.isExecuting) {
                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 检查背包是否有钓鱼竿
                const fishingRod = this.bot.inventory.items().find(item => item.name === 'fishing_rod');
                if (!fishingRod) {
                    sendToOwner(this.bot, '❌ 背包中没有钓鱼竿了，停止钓鱼！');
                    return this.stop('no_fishing_rod');
                }

                try {
                    // 装备钓鱼竿
                    await this.bot.equip(fishingRod, 'hand');
                    if (!this.isExecuting) break;

                    // 优化抛竿视角：不直接看水方块中心，而是计算水平朝向(Yaw)并微微抬起视角(Pitch)抛物线扔出
                    const dx = targetWaterPos.x + 0.5 - this.bot.entity.position.x;
                    const dz = targetWaterPos.z + 0.5 - this.bot.entity.position.z;
                    const yaw = Math.atan2(-dx, -dz);
                    const pitch = -0.15; // 微微向上看（负数代表向上），防止勾到脚下的地板
                    await this.bot.look(yaw, pitch, true);
                    
                    if (!this.isExecuting) break;

                    console.log(`[FishAction] 抛出鱼竿...`);
                    
                    // 设置超时强制收杆机制
                    let isTimeout = false;
                    const timeoutId = setTimeout(() => {
                        if (this.isExecuting) {
                            console.log(`[FishAction] 钓鱼等待超时 (${this.fishingTimeout/1000}s)，准备重新抛竿...`);
                            isTimeout = true;
                            this.bot.activateItem(); // 强制右键收回鱼竿，这会打断 bot.fish() 的 Promise
                        }
                    }, this.fishingTimeout);

                    // 执行钓鱼动作
                    try {
                        await this.bot.fish();
                        clearTimeout(timeoutId); // 成功钓到后清除超时定时器
                        
                        console.log(`[FishAction] 成功钓到物品！`);
                        this.failCount = 0; // 成功一次就重置失败计数器
                        
                        // 稍微停顿，等待掉落物飞过来并被拾取
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (fishErr) {
                        clearTimeout(timeoutId); // 发生异常也必须清除定时器
                        throw fishErr; // 抛给外层 catch 处理
                    }

                } catch (err) {
                    if (!this.isExecuting) break; 
                    
                    // 如果是因为超时打断，或者是鱼漂卡在方块上导致的取消
                    if (err.message === 'Fishing cancelled') {
                        this.failCount++;
                        console.log(`[FishAction] 钓鱼失败或超时重试 (${this.failCount}/${this.maxFails})`);
                        
                        if (this.failCount >= this.maxFails) {
                            sendToOwner(this.bot, `❌ 连续 ${this.maxFails} 次钓鱼失败（可能卡在方块上或没有水），结束钓鱼。`);
                            return this.stop('too_many_failures');
                        }
                        
                        // 失败后稍微等待再重试，给服务器一点反应时间
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    } else {
                        console.log(`[FishAction] 钓鱼过程出现异常: ${err.message}`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[FishAction] 作业异常:`, err.message);
            sendToOwner(this.bot, `❌ 钓鱼异常: ${err.message}`);
            this.stop('fish_error');
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null);
        }
        // 如果正在钓鱼，激活鱼竿来取消当前钓鱼状态
        if (this.bot.entity.equipment[0]?.name === 'fishing_rod') {
            this.bot.activateItem(); 
        }
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null);
        }

        // 如果手里拿着鱼竿，尝试收回
        if (this.bot.entity.equipment[0]?.name === 'fishing_rod') {
            this.bot.activateItem();
        }

        console.log(`[FishAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = FishAction;
