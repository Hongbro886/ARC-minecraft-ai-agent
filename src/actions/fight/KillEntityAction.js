const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class KillEntityAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 目标生物名称，例如 'zombie', 'skeleton', 'pig', 'cow'
        this.entityName = params.entity_name;
        // 扫描半径（以启动时的坐标为中心），默认 20 格
        this.radius = params.radius || 20;
        // 单个目标的最大处理时间（毫秒），超时则放弃，默认 15 秒
        this.timeoutMs = params.timeout || 15000;
        
        this.isPaused = false;
        this.isExecuting = false;
        
        // 记录启动时的中心坐标，防止无限蔓延
        this.anchorPos = null;
        // 记录无法到达或超时的实体 ID
        this.ignoredEntities = new Set();
    }

    async execute() {
        this.isExecuting = true;
        // 锁定作业中心点
        this.anchorPos = this.bot.entity.position.clone();
        this.ignoredEntities.clear();

        sendToOwner(this.bot, `⚔️ 开始清理以我当前位置为中心，${this.radius} 格内的【${this.entityName}】...`);

        try {
            while (this.isExecuting) {
                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 1. 扫描锚点范围内的目标，并过滤掉已忽略的实体
                const entities = Object.values(this.bot.entities).filter(e => 
                    e.name === this.entityName && 
                    e.position.distanceTo(this.anchorPos) <= this.radius &&
                    !this.ignoredEntities.has(e.id)
                );

                if (entities.length === 0) {
                    sendToOwner(this.bot, `✅ 区域内可触达的【${this.entityName}】已清理完毕！`);
                    return this.stop('success');
                }

                // 2. 按距离机器人的远近排序，优先攻击最近的
                entities.sort((a, b) => this.bot.entity.position.distanceTo(a.position) - this.bot.entity.position.distanceTo(b.position));
                const target = entities[0];

                console.log(`[KillEntityAction] 锁定目标 (ID: ${target.id}), 距离锚点: ${target.position.distanceTo(this.anchorPos).toFixed(1)}`);

                // 3. 针对该目标的追踪与攻击循环
                let targetDead = false;
                let targetTimeout = false;
                const startTime = Date.now();

                while (this.isExecuting && !targetDead && !targetTimeout) {
                    while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

                    // 检查目标是否已死亡或消失 (不在内存中)
                    if (!this.bot.entities[target.id]) {
                        targetDead = true;
                        console.log(`[KillEntityAction] 目标已死亡 (ID: ${target.id})`);
                        break;
                    }

                    // 检查是否超时
                    if (Date.now() - startTime > this.timeoutMs) {
                        targetTimeout = true;
                        this.ignoredEntities.add(target.id);
                        sendToOwner(this.bot, `⚠️ 目标 (ID: ${target.id}) 难以触达或击杀超时，已放弃并更换目标。`);
                        break;
                    }

                    const distanceToTarget = this.bot.entity.position.distanceTo(target.position);

                    if (distanceToTarget > 3) {
                        // 距离较远，尝试靠近
                        if (this.bot.pathfinder) {
                            const { goals } = require('mineflayer-pathfinder');
                            // 动态更新目标位置
                            this.bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
                        }
                        // 等待一小段时间让机器人移动
                        await new Promise(resolve => setTimeout(resolve, 400));
                    } else {
                        // 距离足够近，停止移动并攻击
                        if (this.bot.pathfinder) {
                            this.bot.pathfinder.setGoal(null);
                        }

                        await this._equipBestWeapon();
                        
                        try {
                            // 看向目标头部/身体
                            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
                            if (!this.isExecuting) break;

                            this.bot.attack(target);
                            
                            // 攻击冷却时间 (简单设定为 600ms，适配大多数武器)
                            await new Promise(resolve => setTimeout(resolve, 600));
                        } catch (attackErr) {
                            console.log(`[KillEntityAction] 攻击异常: ${attackErr.message}`);
                        }
                    }
                }

                // 稍微停顿，准备寻找下一个目标
                await new Promise(resolve => setTimeout(resolve, 500));
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[KillEntityAction] 执行异常:`, err.message);
            sendToOwner(this.bot, `❌ 清理异常: ${err.message}`);
            this.stop('execute_error');
        }
    }

    // 辅助方法：自动装备背包中最好的武器
    async _equipBestWeapon() {
        const items = this.bot.inventory.items();
        // 简单按名称过滤剑和斧头
        const weapons = items.filter(item => item.name.includes('sword') || item.name.includes('axe'));
        
        if (weapons.length > 0) {
            // 简单的优先级排序：钻石 > 铁 > 石 > 木/金
            const getWeaponScore = (name) => {
                if (name.includes('diamond')) return 4;
                if (name.includes('iron')) return 3;
                if (name.includes('stone')) return 2;
                return 1;
            };

            weapons.sort((a, b) => getWeaponScore(b.name) - getWeaponScore(a.name));
            const bestWeapon = weapons[0];

            // 如果当前手里拿的不是这把武器，则装备
            if (!this.bot.heldItem || this.bot.heldItem.name !== bestWeapon.name) {
                try {
                    await this.bot.equip(bestWeapon, 'hand');
                } catch (err) {
                    console.log(`[KillEntityAction] 装备武器失败: ${err.message}`);
                }
            }
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 暂停时停止移动
        }
        console.log(`[KillEntityAction] 动作已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[KillEntityAction] 动作已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 停止时打断寻路
        }

        console.log(`[KillEntityAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = KillEntityAction;
