const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class PvpAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 目标玩家的用户名
        this.targetName = params.target_name;
        
        this.isPaused = false;
        this.isExecuting = false;
        
        this.lastAttackTime = 0;
    }

    async execute() {
        this.isExecuting = true;

        if (!this.targetName) {
            sendToOwner(this.bot, `❌ 未指定目标玩家！`);
            return this.stop('no_target');
        }

        sendToOwner(this.bot, `⚔️ 锁定目标玩家【${this.targetName}】，准备战斗！`);

        try {
            while (this.isExecuting) {
                if (this.isPaused) {
                    this._resetControls();
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 确保自身实体已加载
                if (!this.bot.entity || !this.bot.entity.position) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 检查自己是否死亡
                if (this.bot.health <= 0) {
                    return this.stop('bot_dead');
                }

                // 1. 获取目标玩家实体 (忽略大小写进行匹配)
                const playerKey = Object.keys(this.bot.players).find(p => p.toLowerCase() === this.targetName.toLowerCase());
                const targetPlayer = playerKey ? this.bot.players[playerKey] : null;
                const targetEntity = targetPlayer ? targetPlayer.entity : null;

                // 如果玩家不存在或未加载实体，不要直接退出，而是等待其进入视野
                if (!targetEntity || !targetEntity.isValid) {
                    this._resetControls();
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // 2. 状态检查：血量过低时尝试吃东西
                if (this.bot.health < 8 && this.bot.food < 20) {
                    await this._tryEatFood();
                    continue; // 吃完东西后重新评估状态
                }

                // 3. 装备最强武器
                await this._equipBestWeapon();

                // 4. 计算距离并执行移动与攻击
                const distance = this.bot.entity.position.distanceTo(targetEntity.position);

                // 实时看向目标头部偏下位置 (增加 try-catch 防止 lookAt 被打断抛出异常)
                try {
                    const height = targetEntity.height || 1.62; // 增加默认高度防止 NaN 报错
                    await this.bot.lookAt(targetEntity.position.offset(0, height * 0.8, 0), true);
                } catch (e) {
                    // 忽略 lookAt 被打断的错误
                }

                if (!this.isExecuting) break;

                // --- 移动逻辑 ---
                if (distance > 2.5) {
                    // 距离较远，追击
                    this.bot.setControlState('forward', true);
                    this.bot.setControlState('sprint', true);
                    
                    // 如果前方有方块挡住则跳跃
                    if (this.bot.entity.isCollidedHorizontally) {
                        this.bot.setControlState('jump', true);
                    } else {
                        this.bot.setControlState('jump', false);
                    }
                } else {
                    // 距离足够近，停止前进，防止穿模
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('sprint', false);
                    this.bot.setControlState('jump', false); // 确保停止乱跳
                }

                // --- 攻击逻辑 ---
                if (distance <= 3.5) {
                    const now = Date.now();
                    // 动态计算冷却时间 (斧头较慢，剑较快)
                    let cooldown = 600;
                    if (this.bot.heldItem && this.bot.heldItem.name.includes('axe')) {
                        cooldown = 1000;
                    }

                    if (now - this.lastAttackTime >= cooldown) {
                        // 尝试跳跃暴击（如果在地面上）
                        if (this.bot.entity.onGround) {
                            this.bot.setControlState('jump', true);
                            // 短暂延迟后松开跳跃键，完成一次跳跃
                            setTimeout(() => {
                                if (this.isExecuting) this.bot.setControlState('jump', false);
                            }, 250);
                        }
                        
                        try {
                            this.bot.attack(targetEntity);
                            this.lastAttackTime = now;
                        } catch (e) {
                            console.error(`[PvpAction] 攻击出错:`, e.message);
                        }
                    }
                }

                // 极短的延迟，保持高频的追踪循环
                await new Promise(resolve => setTimeout(resolve, 50));
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[PvpAction] PVP 异常:`, err.message);
            sendToOwner(this.bot, `❌ PVP 异常: ${err.message}`);
            this.stop('pvp_error');
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
                    // 忽略装备失败的错误，防止打断战斗
                }
            }
        }
    }

    // 辅助方法：危急时刻吃食物
    async _tryEatFood() {
        const foods = this.bot.inventory.items().filter(item => 
            ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop'].includes(item.name)
        );

        if (foods.length > 0) {
            this._resetControls(); // 停下脚步吃东西
            try {
                await this.bot.equip(foods[0], 'hand');
                console.log(`[PvpAction] 血量危急，正在吃 ${foods[0].name}...`);
                
                // 优先使用新版更稳定的 consume 方法
                if (typeof this.bot.consume === 'function') {
                    await this.bot.consume();
                } else {
                    this.bot.activateItem(); 
                    await new Promise(resolve => setTimeout(resolve, 1600));
                    this.bot.deactivateItem();
                }
            } catch (err) {
                try { this.bot.deactivateItem(); } catch (e) {}
            }
        }
    }

    _resetControls() {
        try {
            this.bot.setControlState('forward', false);
            this.bot.setControlState('back', false);
            this.bot.setControlState('left', false);
            this.bot.setControlState('right', false);
            this.bot.setControlState('sprint', false);
            this.bot.setControlState('jump', false);
        } catch (e) {}
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        this._resetControls();
        console.log(`[PvpAction] PVP 已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[PvpAction] PVP 已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        this._resetControls();

        console.log(`[PvpAction] PVP 结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = PvpAction;
