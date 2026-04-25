const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');
const { goals, Movements } = require('mineflayer-pathfinder');
class GoTo extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.coords = params.coords;
        this.range = params.range || 1;
        this.goal = new goals.GoalNear(
            this.coords[0],
            this.coords[1],
            this.coords[2],
            this.range
        );

        this.isPaused = false;
        this.isExecuting = false;
        this._stuckTimer = null;
        this._lastPos = null;
        this._stuckCount = 0;
    }

    _startStuckDetection() {
        this._lastPos = this.bot.entity.position.clone();
        this._stuckCount = 0;

        this._stuckTimer = setInterval(() => {
            if (!this.isExecuting || this.isPaused) return;

            const currentPos = this.bot.entity.position;
            
            const moved = Math.abs(currentPos.x - this._lastPos.x)
                        + Math.abs(currentPos.y - this._lastPos.y) 
                        + Math.abs(currentPos.z - this._lastPos.z);

            if (moved < 0.1) {
                this._stuckCount++;
                console.log(`[GoTo] 卡住检测 #${this._stuckCount}`);

                // ✅ 达到 30 次，呼叫玩家并停止任务
                if (this._stuckCount >= 30) {
                    sendToOwner(this.bot, '🆘 主人救命！我在这里卡住好久了，快来帮帮我！');
                    this.stop('stuck_too_long');
                    return; // 结束本次检测
                }

                // 使用取余数来循环执行脱困动作 (1, 2, 0, 1, 2, 0...)
                const actionStep = this._stuckCount % 3;

                if (actionStep === 1) {
                    this.bot.pathfinder.setGoal(null);
                    
                    this.bot.setControlState('jump', true);
                    this.bot.setControlState('forward', true);
                    
                    setTimeout(() => {
                        this.bot.setControlState('jump', false);
                        this.bot.setControlState('forward', false);
                        if (this.isExecuting && !this.isPaused) {
                            this.bot.pathfinder.setGoal(this.goal, false);
                        }
                    }, 400);

                } else if (actionStep === 2) {
                    this.bot.pathfinder.setGoal(null);
                    
                    this.bot.setControlState('back', true);
                    this.bot.setControlState('jump', true);
                    
                    setTimeout(() => {
                        this.bot.setControlState('back', false);
                        this.bot.setControlState('jump', false);
                        if (this.isExecuting && !this.isPaused) {
                            this.bot.pathfinder.setGoal(this.goal, false);
                        }
                    }, 600);

                } else { 
                    // actionStep === 0 (即第 3, 6, 9... 次卡住)
                    console.log('[GoTo] 多次卡住，尝试重新计算路径...');
                    this.bot.clearControlStates();
                    this.bot.pathfinder.setGoal(this.goal, false);
                }
            } else {
                // 只要有移动，就重置卡住计数器
                this._stuckCount = 0;
            }

            this._lastPos = currentPos.clone();
        }, 10000);
    }


    _stopStuckDetection() {
        if (this._stuckTimer) {
            clearInterval(this._stuckTimer);
            this._stuckTimer = null;
        }
    }

    execute() {
        this.isExecuting = true;

        const mcData = require('minecraft-data')(this.bot.version);
        const movements = new Movements(this.bot, mcData);
        
        movements.canDig = false;
        movements.allow1by1towers = true;
        movements.allowParkour = true;
        movements.allowSprinting = true;
        movements.allowFreeMotion = false;
        movements.maxDropDown = 4;

        // 1. 获取泥土的物品 ID
        const dirtItem = mcData.itemsByName['dirt'];
        if (dirtItem) {
            // 告诉 pathfinder 只能用泥土垫脚
            movements.scafoldingBlocks = [dirtItem.id];
            
            // 2. 检查机器人背包里是否有泥土
            const dirtCount = this.bot.inventory.items().reduce((acc, item) => {
                return item.type === dirtItem.id ? acc + item.count : acc;
            }, 0);

            // 3. 如果没有泥土，向玩家发送请求
            if (dirtCount === 0) {
                sendToOwner(this.bot, '主人，我背包里没有泥土用来垫脚了！如果遇到高处我可能会上不去，请丢给我一些泥土！');
            } else {
                console.log(`[GoTo] 当前拥有泥土数量: ${dirtCount}`);
            }
        }

        this.bot.pathfinder.setMovements(movements);

        // ✅ 事件监听在 bot 上，不是 bot.pathfinder 上
        this._onGoalReached = () => {
            if (this.isExecuting) {
                this.stop('success');
            }
        };

        this._onPathUpdate = (results) => {
            if (!this.isExecuting) return;
            if (results.status === 'noPath') {
                console.log('[GoTo] 无法找到路径');
                sendToOwner(this.bot, '找不到通往目的地的路径！(可能是因为没有垫脚方块，或者目标被完全封死)');
                this.stop('no_path_found');
            } else if (results.status === 'timeout') {
                console.log('[GoTo] 寻路超时');
                this.stop('timeout');
            }
        };

        this.bot.on('goal_reached', this._onGoalReached);
        this.bot.on('path_update', this._onPathUpdate);

        this.bot.pathfinder.setGoal(this.goal, false);
        this._startStuckDetection();
    }


    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        this._stopStuckDetection();
        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        this._startStuckDetection();
        this.bot.pathfinder.setGoal(this.goal, false);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;

        this._stopStuckDetection();

        // ✅ 移除监听，防止内存泄漏
        if (this._onGoalReached) {
            this.bot.removeListener('goal_reached', this._onGoalReached);
        }
        if (this._onPathUpdate) {
            this.bot.removeListener('path_update', this._onPathUpdate);
        }

        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();

        this.emit('stop', reason);
    }
}

module.exports = GoTo;