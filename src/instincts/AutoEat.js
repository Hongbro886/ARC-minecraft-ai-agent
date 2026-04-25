/**
 * 被动本能：自动进食
 * 当饥饿值低于阈值时，自动暂停当前任务，吃东西，然后恢复。
 */
const { sendToOwner } = require('../utils/chat');

// 食物优先级列表（按饱和度和饥饿值恢复排序）
const FOOD_PRIORITY = [
    // 高级食物（饱和度高）
    'cooked_beef',      // +8食物 +12.8饱和度
    'cooked_porkchop',  // +8食物 +12.8饱和度
    'cooked_mutton',    // +6食物 +9.6饱和度
    'cooked_salmon',    // +6食物 +9.6饱和度
    'cooked_chicken',   // +6食物 +7.2饱和度
    'cooked_cod',       // +5食物 +6饱和度
    'baked_potato',     // +5食物 +6饱和度
    'bread',            // +5食物 +6饱和度
    'pumpkin_pie',      // +8食物 +4.8饱和度
    'golden_carrot',    // +6食物 +14.4饱和度
    'golden_apple',     // +4食物 +9.6饱和度
    
    // 中级食物
    'carrot',           // +3食物 +3.6饱和度
    'apple',            // +4食物 +2.4饱和度
    'melon_slice',      // +2食物 +1.2饱和度
    'cookie',           // +2食物 +0.4饱和度
    'sweet_berries',    // +2食物 +0.4饱和度
    
    // 生食（最后选择）
    'raw_beef',
    'raw_porkchop',
    'raw_mutton',
    'raw_chicken',
    'raw_salmon',
    'raw_cod',
    'potato',
    'poisonous_potato', // 紧急情况
];

const HUNGER_THRESHOLD = 18;        // 饥饿值低于此值时触发（满值为20）
const CHECK_INTERVAL = 1000;        // 每1秒检查一次
const ALERT_COOLDOWN = 30000;       // 求助提示冷却时间（30秒）
const EAT_TIMEOUT = 5000;           // 进食超时时间（5秒）

class AutoEat {
    constructor(bot, getCurrentAction) {
        this.bot = bot;
        this.getCurrentAction = getCurrentAction;
        this.isEating = false;
        this.checkInterval = null;
        this.hungerAlertCooldown = null;
        this.pausedAction = null; // 记录被暂停的任务
    }

    mount() {
        // 多重监听机制，确保不会遗漏
        this.bot.on('health', () => this._check());
        this.bot.on('physicsTick', () => this._check()); // 每个物理tick检查
        
        // 定期主动检查（备用机制）
        this.checkInterval = setInterval(() => this._check(), CHECK_INTERVAL);
        
        console.log('[AutoEat] 自动进食本能已挂载');
    }

    unmount() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        if (this.hungerAlertCooldown) {
            clearTimeout(this.hungerAlertCooldown);
            this.hungerAlertCooldown = null;
        }
        console.log('[AutoEat] 自动进食本能已卸载');
    }

    async _check() {
        // 防止重复触发
        if (this.isEating) return;
        
        // 检查饥饿值
        const currentFood = this.bot.food;
        if (currentFood >= HUNGER_THRESHOLD) return;

        // 查找最佳食物
        const foodItem = this._findBestFood();
        if (!foodItem) {
            this._alertNoFood(currentFood);
            return;
        }

        // 开始进食流程
        await this._eatFood(foodItem, currentFood);
    }

    async _eatFood(foodItem, currentFood) {
        this.isEating = true;
        
        console.log(`[AutoEat] 饥饿值 ${currentFood}/20，开始吃 ${foodItem.name} (数量: ${foodItem.count})`);

        try {
            // 暂停当前任务
            this._pauseCurrentAction();

            // 装备食物到手上
            await this.bot.equip(foodItem, 'hand');
            
            // 开始进食（带超时保护）
            await this._consumeWithTimeout(foodItem);
            
            console.log(`[AutoEat] 吃完了 ${foodItem.name}，饥饿值恢复至 ${this.bot.food}/20`);
            
        } catch (err) {
            console.error('[AutoEat] 进食失败:', err.message);
            // 如果是因为食物已经在最大饱食度，不算错误
            if (err.message.includes('food') || err.message.includes('hungry')) {
                console.log('[AutoEat] 当前不需要进食（饱食度已满）');
            }
        } finally {
            this.isEating = false;
            
            // 恢复当前任务
            this._resumeCurrentAction();
        }
    }

    _pauseCurrentAction() {
        const action = this.getCurrentAction();
        if (action && !action.isPaused) {
            try {
                action.pause();
                this.pausedAction = action;
                console.log('[AutoEat] 已暂停当前任务');
            } catch (err) {
                console.error('[AutoEat] 暂停任务失败:', err.message);
            }
        }
    }

    _resumeCurrentAction() {
        if (this.pausedAction && this.pausedAction.isPaused) {
            try {
                this.pausedAction.resume();
                console.log('[AutoEat] 已恢复当前任务');
            } catch (err) {
                console.error('[AutoEat] 恢复任务失败:', err.message);
            }
        }
        this.pausedAction = null;
    }

    async _consumeWithTimeout(foodItem) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('进食超时'));
            }, EAT_TIMEOUT);

            this.bot.consume()
                .then(() => {
                    clearTimeout(timeout);
                    resolve();
                })
                .catch((err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
        });
    }

    _findBestFood() {
        const items = this.bot.inventory.items();
        
        // 按优先级查找
        for (const foodName of FOOD_PRIORITY) {
            const found = items.find(item => item.name === foodName);
            if (found) return found;
        }
        
        // 如果优先级列表没有，尝试查找任何可食用物品
        const anyFood = items.find(item => {
            return item.foodPoints !== undefined && item.foodPoints > 0;
        });
        
        return anyFood || null;
    }

    _alertNoFood(currentFood) {
        if (!this.hungerAlertCooldown) {
            const message = `🍎 主人！我饿了（饥饿值: ${currentFood}/20），背包里没有食物了，快给我点吃的！`;
            sendToOwner(this.bot, message);
            console.warn('[AutoEat]', message);
            
            this.hungerAlertCooldown = setTimeout(() => {
                this.hungerAlertCooldown = null;
            }, ALERT_COOLDOWN);
        }
    }

    // 手动触发进食（供外部调用）
    async forceEat() {
        if (this.isEating) {
            console.log('[AutoEat] 正在进食中，无法重复触发');
            return false;
        }

        const foodItem = this._findBestFood();
        if (!foodItem) {
            console.log('[AutoEat] 没有可用的食物');
            return false;
        }

        await this._eatFood(foodItem, this.bot.food);
        return true;
    }
}

module.exports = AutoEat;
