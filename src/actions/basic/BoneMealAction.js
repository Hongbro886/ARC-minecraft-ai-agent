const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../../utils/chat');

class BoneMealAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 扫描半径，默认 16 格
        this.radius = params.radius || 16;
        
        this.isPaused = false;
        this.isExecuting = false;

        // 支持催熟的农作物方块及其成熟年龄
        this.cropMapping = {
            'wheat': { maxAge: 7 },
            'carrots': { maxAge: 7 },
            'potatoes': { maxAge: 7 },
            'beetroots': { maxAge: 3 }
        };
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const boneMealItem = mcData.itemsByName['bone_meal'];

            if (!boneMealItem) {
                sendToOwner(this.bot, '❌ 当前版本无法识别骨粉(bone_meal)物品');
                return this.stop('no_bonemeal_item');
            }

            // 获取所有支持的作物方块 ID
            const cropIds = Object.keys(this.cropMapping)
                .map(name => mcData.blocksByName[name]?.id)
                .filter(id => id !== undefined);

            if (cropIds.length === 0) {
                sendToOwner(this.bot, '❌ 无法识别任何支持的农作物方块');
                return this.stop('no_crop_blocks');
            }

            sendToOwner(this.bot, `✨ 开始在 ${this.radius} 格范围内使用骨粉催熟作物...`);

            // 外层循环：不断扫描直到没有需要催熟的作物或骨粉耗尽
            while (this.isExecuting) {
                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 检查背包中是否有骨粉
                const hasBoneMeal = this.bot.inventory.items().find(i => i.name === 'bone_meal');
                if (!hasBoneMeal) {
                    sendToOwner(this.bot, '⚠️ 背包中没有【骨粉】了，停止催熟作业！');
                    return this.stop('no_bone_meal');
                }

                // 1. 扫描周边所有的作物方块
                const crops = this.bot.findBlocks({
                    matching: cropIds,
                    maxDistance: this.radius,
                    count: 1024
                });

                if (crops.length === 0) {
                    sendToOwner(this.bot, '✅ 附近没有找到任何农作物。');
                    return this.stop('no_crops');
                }

                // 按距离从近到远排序，优化移动路径
                crops.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b));

                let actionTaken = false;

                for (const cropPos of crops) {
                    if (!this.isExecuting) break;
                    while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

                    const cropBlock = this.bot.blockAt(cropPos);
                    if (!cropBlock) continue;

                    const cropInfo = this.cropMapping[cropBlock.name];
                    if (!cropInfo) continue;

                    // 2. 状态判断：是否未成熟
                    const age = this._getCropAge(cropBlock);
                    if (age >= cropInfo.maxAge) {
                        // 已经成熟，跳过
                        continue;
                    }

                    actionTaken = true;
                    
                    // 3. 距离校验与移动 (如果距离超过 4 格)
                    const distance = this.bot.entity.position.distanceTo(cropPos);
                    if (distance > 4) {
                        if (this.bot.pathfinder) {
                            const { goals } = require('mineflayer-pathfinder');
                            try {
                                // 走到距离目标 2 格以内
                                await this.bot.pathfinder.goto(new goals.GoalNear(cropPos.x, cropPos.y, cropPos.z, 2));
                            } catch (moveErr) {
                                console.log(`[BoneMealAction] 无法到达目标位置: ${cropPos}, 跳过`);
                                continue;
                            }
                        } else {
                            console.log(`[BoneMealAction] 目标太远且未安装 pathfinder，跳过: ${cropPos}`);
                            continue;
                        }
                    }

                    // 4. 执行催熟
                    // 再次检查骨粉，防止在移动过程中被丢弃或消耗
                    let boneMealObj = this.bot.inventory.items().find(i => i.name === 'bone_meal');
                    if (!boneMealObj) {
                        sendToOwner(this.bot, '⚠️ 骨粉已耗尽，停止作业！');
                        return this.stop('no_bone_meal');
                    }

                    try {
                        await this.bot.equip(boneMealObj, 'hand');
                        if (!this.isExecuting) return;

                        await this.bot.lookAt(cropPos.offset(0.5, 0.5, 0.5), true);
                        
                        // 对着作物方块使用物品 (相当于玩家拿着骨粉右键作物)
                        // 使用 activateBlock 或 placeBlock 模拟右键
                        await this.bot.activateBlock(cropBlock);
                        console.log(`[BoneMealAction] 成功对 ${cropBlock.name} 使用骨粉 @ ${cropPos}`);
                        
                        // 等待服务器处理骨粉效果和植物生长更新
                        await new Promise(resolve => setTimeout(resolve, 300));
                    } catch (useErr) {
                        console.log(`[BoneMealAction] 催熟失败: ${useErr.message}`);
                    }
                }

                // 如果遍历完一圈发现没有任何需要催熟的作物，则结束任务
                if (!actionTaken) {
                    sendToOwner(this.bot, '✅ 周边农作物已全部成熟（或没有需要催熟的作物）！');
                    return this.stop('success');
                }
                
                // 稍微等待后进行下一轮扫描，因为骨粉可能需要多次使用才能让作物完全成熟
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[BoneMealAction] 作业异常:`, err.message);
            sendToOwner(this.bot, `❌ 作业异常: ${err.message}`);
            this.stop('bonemeal_error');
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

        console.log(`[BoneMealAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = BoneMealAction;
