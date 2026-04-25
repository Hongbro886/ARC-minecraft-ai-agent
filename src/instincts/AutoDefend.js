/**
 * 被动本能：自动反击
 * 纯已知模式：只识别已知敌对生物，不追踪未知攻击者
 * 适配 MythicMobs 等插件
 */
const { sendToOwner } = require('../utils/chat');
const { goals } = require('mineflayer-pathfinder');

// 武器优先级
const WEAPON_PRIORITY = [
    'netherite_sword', 'diamond_sword', 'iron_sword',
    'stone_sword', 'wooden_sword', 'golden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe',
    'stone_axe', 'wooden_axe',
];

// 敌对生物列表（会主动攻击）
const HOSTILE_MOBS = [
    'blaze', 'bogged', 'breeze', 'creaking', 'creeper',
    'elder_guardian', 'endermite', 'evoker', 'guardian',
    'hoglin', 'husk', 'magma_cube', 'parched', 
    'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish',
    'skeleton', 'slime', 'stray', 'vex', 'vindicator',
    'warden', 'witch', 'wither_skeleton', 'zoglin', 'zombie',
    'spider','cave_spider'
];

// Boss 生物
const BOSS_MOBS = [
    'ender_dragon', 'wither',
];

// 忽略的实体类型（非生物）
const IGNORE_ENTITY_TYPES = [
    'object', 'orb', 'item', 'arrow', 'egg',
    'snowball', 'fireball', 'small_fireball',
    'ender_pearl', 'experience_orb', 'area_effect_cloud',
    'falling_block', 'tnt', 'armor_stand', 'boat',
    'minecart', 'item_frame', 'painting', 'leash_knot',
];

const ATTACK_RANGE = 24;        // 检测范围
const HOSTILE_SCAN_RANGE = 16;  // 主动扫描敌对生物的范围
const COMBAT_TIMEOUT = 30000;   // 战斗超时（30秒）
const CHECK_INTERVAL = 200;     // 检查间隔（0.2秒）
const FLEE_HEALTH = 6;          // 生命值低于此值时逃跑

class AutoDefend {
    constructor(bot, getCurrentAction, options = {}) {
        this.bot = bot;
        this.getCurrentAction = getCurrentAction;

        // 配置选项
        this.options = {
            attackPlayers: false,           // 是否攻击玩家
            whitelistPlayers: [],           // 玩家白名单
            autoFlee: true,                 // 是否自动逃跑
            fleeHealth: FLEE_HEALTH,        // 逃跑阈值
            proactiveDefense: true,         // 是否主动攻击敌对生物
            ...options
        };

        this.isDefending = false;
        this.isFleeing = false;
        this.attackTarget = null;
        this.pausedAction = null;
        this.combatTimeout = null;
        this.checkInterval = null;

        // 生命值追踪
        this._lastHealth = null;
        this._attackLoop = null;
    }

    mount() {
        // 监听生命值变化
        this.bot.on('health', () => {
            this._onHealthChange();
        });

        // 监听实体死亡
        this.bot.on('entityDead', (entity) => {
            if (entity === this.attackTarget) {
                this._onThreatEliminated();
            }
        });

        // 监听实体消失
        this.bot.on('entityGone', (entity) => {
            if (entity === this.attackTarget) {
                this._onThreatLost();
            }
        });

        // 定期检查
        this.checkInterval = setInterval(() => {
            this._checkCombatStatus();

            // 主动扫描敌对生物
            if (this.options.proactiveDefense && !this.isDefending && !this.isFleeing) {
                this._scanForHostileMobs();
            }
        }, CHECK_INTERVAL);

        console.log('[AutoDefend] 自动反击本能已挂载（已知敌对生物模式）');
    }

    unmount() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        if (this.combatTimeout) {
            clearTimeout(this.combatTimeout);
            this.combatTimeout = null;
        }
        this._stopCombat();
        console.log('[AutoDefend] 自动反击本能已卸载');
    }

    _onHealthChange() {
        const currentHealth = this.bot.health;

        // 初始化
        if (this._lastHealth === null) {
            this._lastHealth = currentHealth;
            return;
        }

        // 检测生命值下降（受到伤害）
        if (currentHealth < this._lastHealth) {
            const damage = this._lastHealth - currentHealth;
            console.log(`[AutoDefend] 受到 ${damage.toFixed(1)} 点伤害！当前生命: ${currentHealth.toFixed(1)}/20`);

            // 检查是否需要逃跑
            if (this.options.autoFlee && currentHealth <= this.options.fleeHealth && !this.isFleeing) {
                this._startFleeing();
            }
        }

        this._lastHealth = currentHealth;
    }

    _scanForHostileMobs() {
        // 扫描附近的敌对生物
        const hostileMob = this._findNearestHostileMob();

        if (hostileMob) {
            const distance = hostileMob.position.distanceTo(this.bot.entity.position);

            // 只在较近距离才主动攻击
            if (distance < HOSTILE_SCAN_RANGE) {
                console.log(`[AutoDefend] 检测到敌对生物: ${hostileMob.name || hostileMob.type} (距离: ${distance.toFixed(1)})`);
                this._startCombat(hostileMob);
            }
        }
    }

    _findNearestHostileMob() {
        let nearest = null;
        let minDist = Infinity;

        for (const entity of Object.values(this.bot.entities)) {
            if (!entity || !entity.position || !entity.isValid) continue;
            if (entity === this.bot.entity) continue;

            const entityName = entity.name?.toLowerCase() || entity.type?.toLowerCase() || '';

            // 检查是否是敌对生物或 Boss
            const isHostile = HOSTILE_MOBS.includes(entityName) || BOSS_MOBS.includes(entityName);

            if (!isHostile) continue;

            const dist = entity.position.distanceTo(this.bot.entity.position);

            if (dist < HOSTILE_SCAN_RANGE && dist < minDist) {
                minDist = dist;
                nearest = entity;
            }
        }

        return nearest;
    }

    async _startCombat(threat) {
        if (this.isDefending || this.isFleeing) return;

        this.isDefending = true;
        this.attackTarget = threat;

        // 暂停当前任务
        this._pauseCurrentAction();

        const threatName = threat.name || threat.type || 'Unknown';
        const distance = threat.position.distanceTo(this.bot.entity.position).toFixed(1);

        sendToOwner(this.bot, `⚔️ 反击 ${threatName}！(距离: ${distance}m)`);
        console.log(`[AutoDefend] 开始反击: ${threatName}`);

        // 装备最佳武器
        await this._equipBestWeapon();

        // 开始攻击
        this._attackTarget();

        // 设置战斗超时
        this._setCombatTimeout();
    }

    _startFleeing() {
        console.log('[AutoDefend] 生命值过低，开始逃跑！');
        sendToOwner(this.bot, '🏃 生命值过低！撤退！');

        this.isFleeing = true;

        // 停止当前战斗
        if (this.isDefending) {
            this._stopCombat();
        }

        // 暂停当前任务
        this._pauseCurrentAction();

        // 寻找安全位置并逃跑
        this._flee();
    }

    _flee() {
        try {
            // 找到最近的威胁
            const threat = this._findNearestHostileMob();

            if (threat && this.bot.pathfinder) {
                // 远离威胁
                const goal = new goals.GoalInvert(new goals.GoalFollow(threat, 30));
                this.bot.pathfinder.setGoal(goal, true);
                console.log('[AutoDefend] 正在远离威胁...');
            } else {
                // 随机逃跑
                const angle = Math.random() * Math.PI * 2;
                const distance = 30;
                const randomX = this.bot.entity.position.x + Math.cos(angle) * distance;
                const randomZ = this.bot.entity.position.z + Math.sin(angle) * distance;
                const goal = new goals.GoalXZ(randomX, randomZ);

                if (this.bot.pathfinder) {
                    this.bot.pathfinder.setGoal(goal, true);
                }
                console.log('[AutoDefend] 正在随机逃跑...');
            }

            // 5秒后检查是否安全
            setTimeout(() => {
                if (this.isFleeing) {
                    this._checkIfSafe();
                }
            }, 5000);

        } catch (err) {
            console.error('[AutoDefend] 逃跑失败:', err.message);
        }
    }

    _checkIfSafe() {
        const threat = this._findNearestHostileMob();
        const distance = threat ? threat.position.distanceTo(this.bot.entity.position) : Infinity;

        if (this.bot.health > this.options.fleeHealth && distance > 20) {
            console.log('[AutoDefend] 已经安全，停止逃跑');
            sendToOwner(this.bot, '✅ 已经安全了！');
            this.isFleeing = false;

            if (this.bot.pathfinder) {
                this.bot.pathfinder.setGoal(null);
            }

            this._resumeCurrentAction();
        } else {
            console.log('[AutoDefend] 还不安全，继续逃跑...');
            this._flee();
        }
    }

    _attackTarget() {
        if (!this.attackTarget || !this.isDefending) return;

        try {
            // 使用 mineflayer-pvp 插件
            if (this.bot.pvp) {
                this.bot.pvp.attack(this.attackTarget);
                console.log('[AutoDefend] 使用 PVP 插件攻击');
            } else {
                // 手动实现攻击逻辑
                this._manualAttack();
            }
        } catch (err) {
            console.error('[AutoDefend] 攻击失败:', err.message);
            this._manualAttack();
        }
    }

    _manualAttack() {
        if (this._attackLoop) {
            clearInterval(this._attackLoop);
        }

        this._attackLoop = setInterval(() => {
            if (!this.isDefending || !this.attackTarget || !this.attackTarget.isValid) {
                clearInterval(this._attackLoop);
                this._attackLoop = null;
                return;
            }

            // 检查生命值，如果太低就逃跑
            if (this.options.autoFlee && this.bot.health <= this.options.fleeHealth) {
                clearInterval(this._attackLoop);
                this._attackLoop = null;
                this._startFleeing();
                return;
            }

            const target = this.attackTarget;
            const distance = target.position.distanceTo(this.bot.entity.position);

            // 目标太远，停止攻击
            if (distance > ATTACK_RANGE) {
                console.log('[AutoDefend] 目标超出范围，停止追击');
                clearInterval(this._attackLoop);
                this._attackLoop = null;
                this._onThreatLost();
                return;
            }

            // 如果在攻击范围内，直接攻击
            if (distance < 4) {
                try {
                    const targetHeight = target.height || 1;
                    this.bot.lookAt(target.position.offset(0, targetHeight * 0.5, 0));
                    this.bot.attack(target);
                    console.log(`[AutoDefend] 攻击 ${target.name || target.type} (HP: ${this.bot.health.toFixed(1)}/20)`);
                } catch (err) {
                    console.error('[AutoDefend] 攻击出错:', err.message);
                }
            } else {
                // 靠近目标
                try {
                    if (this.bot.pathfinder) {
                        const goal = new goals.GoalFollow(target, 2);
                        this.bot.pathfinder.setGoal(goal, true);
                    } else {
                        this.bot.lookAt(target.position);
                        this.bot.setControlState('forward', true);
                    }
                } catch (err) {
                    console.error('[AutoDefend] 移动出错:', err.message);
                }
            }
        }, 500);
    }

    _checkCombatStatus() {
        if (!this.isDefending || !this.attackTarget) return;

        const target = this.attackTarget;

        // 检查目标是否还有效
        if (!target.isValid) {
            this._onThreatEliminated();
            return;
        }

        // 检查距离
        const distance = target.position.distanceTo(this.bot.entity.position);
        if (distance > ATTACK_RANGE) {
            console.log('[AutoDefend] 目标超出范围');
            this._onThreatLost();
            return;
        }

        // 检查生命值
        if (this.options.autoFlee && this.bot.health <= this.options.fleeHealth) {
            this._startFleeing();
            return;
        }
    }

    _onThreatEliminated() {
        if (!this.isDefending) return;
        console.log('[AutoDefend] 威胁已消除');
        sendToOwner(this.bot, '✅ 威胁已消除！');
        this._stopCombat();
    }

    _onThreatLost() {
        if (!this.isDefending) return;
        console.log('[AutoDefend] 目标丢失');
        sendToOwner(this.bot, '⚠️ 目标丢失！');
        this._stopCombat();
    }

    _stopCombat() {
        // 停止攻击
        if (this.bot.pvp) {
            try {
                this.bot.pvp.stop();
            } catch (err) {
                console.error('[AutoDefend] 停止PVP失败:', err.message);
            }
        }

        if (this._attackLoop) {
            clearInterval(this._attackLoop);
            this._attackLoop = null;
        }

        // 停止移动
        this.bot.clearControlStates();
        if (this.bot.pathfinder) {
            try {
                this.bot.pathfinder.setGoal(null);
            } catch (err) {
                console.error('[AutoDefend] 清除路径失败:', err.message);
            }
        }

        // 清理状态
        this.isDefending = false;
        this.attackTarget = null;

        if (this.combatTimeout) {
            clearTimeout(this.combatTimeout);
            this.combatTimeout = null;
        }

        // 恢复任务
        this._resumeCurrentAction();
    }

    _setCombatTimeout() {
        if (this.combatTimeout) {
            clearTimeout(this.combatTimeout);
        }

        this.combatTimeout = setTimeout(() => {
            console.log('[AutoDefend] 战斗超时，强制结束');
            sendToOwner(this.bot, '⏱️ 战斗超时，撤退！');
            this._stopCombat();
        }, COMBAT_TIMEOUT);
    }

    _pauseCurrentAction() {
        const action = this.getCurrentAction();
        if (action && !action.isPaused) {
            try {
                action.pause();
                this.pausedAction = action;
                console.log('[AutoDefend] 已暂停当前任务');
            } catch (err) {
                console.error('[AutoDefend] 暂停任务失败:', err.message);
            }
        }
    }

    _resumeCurrentAction() {
        if (this.pausedAction && this.pausedAction.isPaused) {
            try {
                this.pausedAction.resume();
                console.log('[AutoDefend] 已恢复当前任务');
            } catch (err) {
                console.error('[AutoDefend] 恢复任务失败:', err.message);
            }
        }
        this.pausedAction = null;
    }

    async _equipBestWeapon() {
        const items = this.bot.inventory.items();

        for (const weaponName of WEAPON_PRIORITY) {
            const weapon = items.find(item => item.name === weaponName);
            if (weapon) {
                try {
                    await this.bot.equip(weapon, 'hand');
                    console.log(`[AutoDefend] 装备武器: ${weapon.name}`);
                    return true;
                } catch (err) {
                    console.error('[AutoDefend] 装备武器失败:', err.message);
                }
            }
        }

        console.log('[AutoDefend] 背包中没有武器，徒手反击！');
        return false;
    }

    // 手动触发攻击（供外部调用）
    async forceAttack(targetEntity) {
        if (this.isDefending) {
            console.log('[AutoDefend] 已在战斗中');
            return false;
        }

        if (!targetEntity || !targetEntity.isValid) {
            console.log('[AutoDefend] 无效的目标');
            return false;
        }

        await this._startCombat(targetEntity);
        return true;
    }

    // 停止防御（供外部调用）
    forceStop() {
        if (this.isDefending) {
            console.log('[AutoDefend] 强制停止战斗');
            this._stopCombat();
        }
        if (this.isFleeing) {
            console.log('[AutoDefend] 停止逃跑');
            this.isFleeing = false;
            if (this.bot.pathfinder) {
                this.bot.pathfinder.setGoal(null);
            }
            this._resumeCurrentAction();
        }
    }

    // 添加玩家到白名单
    addWhitelistPlayer(username) {
        if (!this.options.whitelistPlayers.includes(username)) {
            this.options.whitelistPlayers.push(username);
            console.log(`[AutoDefend] 已添加玩家到白名单: ${username}`);
        }
    }

    // 从白名单移除玩家
    removeWhitelistPlayer(username) {
        const index = this.options.whitelistPlayers.indexOf(username);
        if (index > -1) {
            this.options.whitelistPlayers.splice(index, 1);
            console.log(`[AutoDefend] 已从白名单移除玩家: ${username}`);
        }
    }

    // 设置是否攻击玩家
    setAttackPlayers(enabled) {
        this.options.attackPlayers = enabled;
        console.log(`[AutoDefend] 攻击玩家: ${enabled ? '启用' : '禁用'}`);
    }

    // 设置是否主动防御
    setProactiveDefense(enabled) {
        this.options.proactiveDefense = enabled;
        console.log(`[AutoDefend] 主动防御: ${enabled ? '启用' : '禁用'}`);
    }
}

module.exports = AutoDefend;