const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../../utils/chat');

class FarmAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 接收种子名称，默认小麦种子
        this.seedName = params.seed_name || 'wheat_seeds';
        // 扫描半径，默认 16 格
        this.radius = params.radius || 16;
        
        this.isPaused = false;
        this.isExecuting = false;

        // 种子与农作物方块的映射关系及成熟年龄
        this.cropMapping = {
            'wheat_seeds': { block: 'wheat', maxAge: 7 },
            'carrot': { block: 'carrots', maxAge: 7 },
            'potato': { block: 'potatoes', maxAge: 7 },
            'beetroot_seeds': { block: 'beetroots', maxAge: 3 }
        };
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const seedItem = mcData.itemsByName[this.seedName];

            if (!seedItem) {
                sendToOwner(this.bot, `❌ 无法识别的种子: ${this.seedName}`);
                return this.stop('invalid_seed');
            }

            const cropInfo = this.cropMapping[this.seedName];
            if (!cropInfo) {
                sendToOwner(this.bot, `❌ 暂不支持该种子的自动种植: ${this.seedName}`);
                return this.stop('unsupported_seed');
            }

            const farmlandBlock = mcData.blocksByName.farmland;
            if (!farmlandBlock) {
                sendToOwner(this.bot, '❌ 当前版本无法识别耕地(farmland)方块');
                return this.stop('no_farmland_block');
            }

            sendToOwner(this.bot, `🚜 开始在 ${this.radius} 格范围内进行种田/收割作业...`);

            // 外层循环：不断扫描直到所有农田都处理完毕
            while (this.isExecuting) {
                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 1. 扫描周边所有耕地
                const farmlands = this.bot.findBlocks({
                    matching: farmlandBlock.id,
                    maxDistance: this.radius,
                    count: 1024
                });

                if (farmlands.length === 0) {
                    sendToOwner(this.bot, '✅ 附近没有找到任何耕地。');
                    return this.stop('no_farmland');
                }

                // 按距离从近到远排序，优化移动路径
                farmlands.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));

                let actionTaken = false;

                for (const farmlandPos of farmlands) {
                    if (!this.isExecuting) break;
                    while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

                    const blockAbovePos = farmlandPos.offset(0, 1, 0);
                    const blockAbove = this.bot.blockAt(blockAbovePos);
                    
                    let needsPlanting = false;
                    let needsHarvesting = false;

                    // 2. 状态判断：是否为空，或是否已成熟
                    if (!blockAbove || blockAbove.name === 'air' || blockAbove.name === 'cave_air') {
                        needsPlanting = true;
                    } else if (blockAbove.name === cropInfo.block) {
                        const age = this._getCropAge(blockAbove);
                        if (age >= cropInfo.maxAge) {
                            needsHarvesting = true;
                            needsPlanting = true; // 收割后需要补种
                        }
                    } else {
                        // 上方是其他方块（比如杂草或其他作物），跳过
                        continue; 
                    }

                    if (needsHarvesting || needsPlanting) {
                        actionTaken = true;
                        
                        // 3. 距离校验与移动 (如果距离超过 4 格)
                        const distance = this.bot.entity.position.distanceTo(farmlandPos);
                        if (distance > 4) {
                            if (this.bot.pathfinder) {
                                const { goals } = require('mineflayer-pathfinder');
                                try {
                                    // 走到距离目标 2 格以内
                                    await this.bot.pathfinder.goto(new goals.GoalNear(farmlandPos.x, farmlandPos.y, farmlandPos.z, 2));
                                } catch (moveErr) {
                                    console.log(`[FarmAction] 无法到达目标位置: ${farmlandPos}, 跳过`);
                                    continue;
                                }
                            } else {
                                console.log(`[FarmAction] 目标太远且未安装 pathfinder，跳过: ${farmlandPos}`);
                                continue;
                            }
                        }

                        // 4. 执行收割
                        if (needsHarvesting) {
                            try {
                                await this.bot.lookAt(blockAbovePos.offset(0.5, 0.5, 0.5), true);
                                if (!this.isExecuting) return;
                                await this.bot.dig(blockAbove);
                                console.log(`[FarmAction] 成功收割: ${cropInfo.block} @ ${blockAbovePos}`);
                                // 稍微等待掉落物生成和吸附
                                await new Promise(resolve => setTimeout(resolve, 300));
                            } catch (digErr) {
                                console.log(`[FarmAction] 收割失败: ${digErr.message}`);
                                continue;
                            }
                        }

                        // 5. 执行种植
                        if (needsPlanting) {
                            // 检查背包是否有种子，如果没有，等待一下看看刚才收割的是否捡到了
                            let seedItemObj = this.bot.inventory.items().find(i => i.name === this.seedName);
                            if (!seedItemObj) {
                                await new Promise(resolve => setTimeout(resolve, 800)); // 再次等待拾取
                                seedItemObj = this.bot.inventory.items().find(i => i.name === this.seedName);
                            }

                            if (!seedItemObj) {
                                sendToOwner(this.bot, `⚠️ 背包中没有【${this.seedName}】了，停止作业！`);
                                return this.stop('no_seeds');
                            }

                            try {
                                await this.bot.equip(seedItemObj, 'hand');
                                if (!this.isExecuting) return;

                                const targetFarmland = this.bot.blockAt(farmlandPos);
                                await this.bot.lookAt(farmlandPos.offset(0.5, 1, 0.5), true);
                                
                                // 向耕地的上方(0, 1, 0)放置种子
                                await this.bot.placeBlock(targetFarmland, new Vec3(0, 1, 0));
                                console.log(`[FarmAction] 成功种植: ${this.seedName} @ ${blockAbovePos}`);
                            } catch (placeErr) {
                                console.log(`[FarmAction] 种植失败: ${placeErr.message}`);
                            }
                        }
                        
                        // 每次操作后稍微停顿，防止发包过快被服务器踢出
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }
                }

                // 如果遍历完一圈发现没有任何需要处理的农田，则结束任务
                if (!actionTaken) {
                    sendToOwner(this.bot, '✅ 周边农田已全部处理完毕（已种满且无成熟作物）！');
                    return this.stop('success');
                }
                
                // 稍微等待后进行下一轮扫描，确保漏掉的方块被处理
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[FarmAction] 作业异常:`, err.message);
            sendToOwner(this.bot, `❌ 作业异常: ${err.message}`);
            this.stop('farm_error');
        }
    }

    _getCropAge(block) {
        // 兼容高版本 (如 1.16+) 的 properties 和低版本 (如 1.12) 的 metadata
        if (block.getProperties && block.getProperties().age !== undefined) {
            return parseInt(block.getProperties().age, 10);
        }
        return block.metadata || 0;
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 暂停时停止移动
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
            this.bot.pathfinder.setGoal(null); // 停止时打断寻路
        }

        console.log(`[FarmAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = FarmAction;
