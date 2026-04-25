const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class DelayAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 接收等待秒数，支持传入 seconds 或 delay，默认等待 5 秒
        this.seconds = params.seconds || params.delay || 5;
        
        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;

        try {
            sendToOwner(this.bot, `⏳ 开始原地等待 ${this.seconds} 秒...`);
            
            // 冻结机器人：停止寻路并清除所有按键控制状态
            if (this.bot.pathfinder) {
                this.bot.pathfinder.setGoal(null);
            }
            this.bot.clearControlStates();

            // 将秒数转换为毫秒
            let remainingTimeMs = this.seconds * 1000;

            // 使用循环等待，以便在等待期间可以随时响应暂停和停止指令
            while (remainingTimeMs > 0 && this.isExecuting) {
                if (this.isPaused) {
                    // 如果处于暂停状态，只等待，不减少剩余时间
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }

                // 每次最多等待 100 毫秒，方便及时打断
                const step = Math.min(100, remainingTimeMs);
                await new Promise(resolve => setTimeout(resolve, step));
                remainingTimeMs -= step;
            }

            // 如果循环正常结束且没有被强制停止
            if (this.isExecuting) {
                sendToOwner(this.bot, `✅ ${this.seconds} 秒等待结束。`);
                this.stop('success');
            }

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[DelayAction] 等待异常:`, err.message);
            sendToOwner(this.bot, `❌ 等待异常: ${err.message}`);
            this.stop('delay_error');
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        console.log(`[DelayAction] 等待已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[DelayAction] 等待已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;

        console.log(`[DelayAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = DelayAction;
