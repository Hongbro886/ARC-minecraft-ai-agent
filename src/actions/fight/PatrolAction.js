const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../../utils/chat');

// 敌对生物列表（会主动攻击）
const HOSTILE_MOBS = [
    'blaze', 'bogged', 'breeze', 'creaking', 'creeper',
    'elder_guardian', 'endermite', 'evoker', 'ghast', 'guardian',
    'hoglin', 'husk', 'magma_cube', 'parched', 'phantom',
    'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish',
    'skeleton', 'slime', 'stray', 'vex', 'vindicator',
    'warden', 'witch', 'wither_skeleton', 'zoglin', 'zombie',
    'zombie_villager',
];

class PatrolAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 巡逻和索敌的半径，默认 24 格
        this.radius = params.radius || 24;
        // 单个目标的最大处理时间（毫秒），超时则放弃，默认 15 秒
        this.timeoutMs = params.timeout || 15000;
        
        this.isPaused = false;
        this.isExecuting = false;
        
        // 记录启动时的中心坐标，作为巡逻锚点
        this.anchorPos = null;
        // 记录无法到达或超时的实体 ID
        this.ignoredEntities = new Set();
        // 记录当前随机巡逻的目标点
        this.currentPatrolGoal = null;
    }

    async execute() {
        this.isExecuting = true;
        // 锁定作业中心点
        this.anchorPos = this.bot.entity.position.floored();
        this.ignoredEntities.clear();

        sendToOwner(this.bot, `🛡️ 开始在驻地附近 ${this.radius} 格范围内巡逻并清理敌对生物...`);

        try {
            while (this.isExecuting) {
                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 1. 扫描锚点范围内的敌对生物
                const enemies = Object.values(this.bot.entities).filter(e => 
                    HOSTILE_MOBS.includes(e.name) && 
                    e.position.distanceTo(this.anchorPos) <= this.radius &&
                    !this.ignoredEntities.has(e.id) &&
                    e.isValid // 确保实体还存在
                );

                if (enemies.length > 0) {
                    // --- 战斗状态 ---
                    this.currentPatrolGoal = null; // 打断巡逻状态

                    // 按距离机器人的远近排序，优先攻击最近的
                    enemies.sort((a, b) => this.bot.entity.position.distanceTo(a.position) - this.bot.entity.position.distanceTo(b.position));
                    const target = enemies[0];

                    console.log(`[PatrolAction] 发现敌人: ${target.name} (ID: ${target.id}), 准备交战！`);
                    await this._engageTarget(target);

                } else {
                    // --- 巡逻状态 ---
                    await this._patrolArea();
                }

                // 每次大循环稍微停顿，降低 CPU 占用
                await new Promise(resolve => setTimeout(resolve, 500));
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[PatrolAction] 执行异常:`, err.message);
            sendToOwner(this.bot, `❌ 巡逻异常: ${err.message}`);
            this.stop('execute_error');
        }
    }

    // 战斗逻辑
    async _engageTarget(target) {
        let targetDead = false;
        let targetTimeout = false;
        const startTime = Date.now();

        while (this.isExecuting && !targetDead && !targetTimeout) {
            while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

            // 检查目标是否已死亡或消失
            if (!this.bot.entities[target.id] || !target.isValid) {
                targetDead = true;
                console.log(`[PatrolAction] 敌人已被消灭 (ID: ${target.id})`);
                break;
            }

            // 检查是否超时
            if (Date.now() - startTime > this.timeoutMs) {
                targetTimeout = true;
                this.ignoredEntities.add(target.id);
                console.log(`[PatrolAction] 敌人 (ID: ${target.id}) 难以触达或击杀超时，已加入黑名单。`);
                break;
            }

            const distanceToTarget = this.bot.entity.position.distanceTo(target.position);

            if (distanceToTarget > 3) {
                // 距离较远，尝试靠近
                if (this.bot.pathfinder) {
                    const { goals } = require('mineflayer-pathfinder');
                    this.bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
                }
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
                    
                    // 攻击冷却时间
                    await new Promise(resolve => setTimeout(resolve, 600));
                } catch (attackErr) {
                    console.log(`[PatrolAction] 攻击异常: ${attackErr.message}`);
                }
            }
        }
    }

    // 随机巡逻逻辑
    async _patrolArea() {
        if (!this.bot.pathfinder) return;

        const { goals } = require('mineflayer-pathfinder');
        const currentPos = this.bot.entity.position;

        // 如果没有巡逻目标，或者已经到达了当前巡逻目标，则生成一个新目标
        if (!this.currentPatrolGoal || currentPos.distanceTo(this.currentPatrolGoal) < 2) {
            
            // 随机生成一个在锚点半径内的点 (为了避免走得太边缘，巡逻半径取设定半径的 0.7 倍)
            const patrolRadius = this.radius * 0.7;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * patrolRadius;
            
            const dx = Math.cos(angle) * r;
            const dz = Math.sin(angle) * r;
            
            this.currentPatrolGoal = new Vec3(
                this.anchorPos.x + dx,
                this.anchorPos.y, // 保持 y 轴大致不变，依赖 pathfinder 自己找路
                this.anchorPos.z + dz
            ).floored();

            console.log(`[PatrolAction] 区域安全，前往新的巡逻点: [${this.currentPatrolGoal.x}, ${this.currentPatrolGoal.z}]`);
            
            try {
                // 设置寻路目标，允许 y 轴有一定的容差
                this.bot.pathfinder.setGoal(new goals.GoalNearXZ(this.currentPatrolGoal.x, this.currentPatrolGoal.z, 2));
            } catch (err) {
                console.log(`[PatrolAction] 巡逻寻路异常: ${err.message}`);
                this.currentPatrolGoal = null; // 寻路失败则重置，下次循环重新生成
            }
        }
    }

    // 辅助方法：自动装备背包中最好的武器
    async _equipBestWeapon() {
        const items = this.bot.inventory.items();
        const weapons = items.filter(item => item.name.includes('sword') || item.name.includes('axe'));
        
        if (weapons.length > 0) {
            const getWeaponScore = (name) => {
                if (name.includes('netherite')) return 5;
                if (name.includes('diamond')) return 4;
                if (name.includes('iron')) return 3;
                if (name.includes('stone')) return 2;
                return 1;
            };

            weapons.sort((a, b) => getWeaponScore(b.name) - getWeaponScore(a.name));
            const bestWeapon = weapons[0];

            if (!this.bot.heldItem || this.bot.heldItem.name !== bestWeapon.name) {
                try {
                    await this.bot.equip(bestWeapon, 'hand');
                } catch (err) {
                    // 忽略装备失败的错误
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
        console.log(`[PatrolAction] 巡逻已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[PatrolAction] 巡逻已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 停止时打断寻路
        }

        console.log(`[PatrolAction] 巡逻结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = PatrolAction;
