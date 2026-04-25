const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class TeleportRequest extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.target = params.target; 
        this.timeout = params.timeout || 60000; 
        
        this.isExecuting = false;
        this.isPaused = false;
        
        this.timeoutTimer = null;
        this.forcedMoveListener = null;
        this.positionCheckTimer = null; // 新增：坐标突变检测定时器
    }

    async execute() {
        this.isExecuting = true;

        if (!this.target) {
            sendToOwner(this.bot, '❌ 缺少 TPA 目标玩家！');
            this.stop('missing_target');
            return;
        }

        // 1. 强制停止所有移动
        this.bot.clearControlStates();
        if (this.bot.pathfinder && this.bot.pathfinder.isMoving()) {
            this.bot.pathfinder.stop();
        }

        // 记录传送前的初始坐标
        const startPos = this.bot.entity.position.clone();

        // 2. 发送 TPA 请求
        sendToOwner(this.bot, `/tpa ${this.target}`);
        console.log(`[TeleportRequest] 发送 /tpa ${this.target}，等待传送...`);

        // 3. 成功判定机制 A：监听服务器强制位移事件 (原版机制)
        this.forcedMoveListener = () => {
            if (!this.isExecuting) return;
            sendToOwner(this.bot, `✨ 传送成功 (事件触发)！`);
            console.log(`[TeleportRequest] 监听到 forcedMove，传送成功！`);
            this.stop('success');
        };
        this.bot.once('forcedMove', this.forcedMoveListener);

        // 4. 成功判定机制 B：坐标突变轮询 (对抗插件服数据包丢失的终极杀器)
        this.positionCheckTimer = setInterval(() => {
            if (!this.isExecuting || this.isPaused) return;
            
            const currentPos = this.bot.entity.position;
            // 如果坐标瞬间变化超过 10 格，说明绝对是传送了
            if (currentPos.distanceTo(startPos) > 10) {
                sendToOwner(this.bot, `✨ 传送成功 (坐标突变检测)！`);
                console.log(`[TeleportRequest] 检测到坐标突变，传送成功！`);
                this.stop('success');
            }
        }, 500);

        // 5. 设置超时检测
        this.timeoutTimer = setTimeout(() => {
            if (!this.isExecuting) return;
            
            sendToOwner(this.bot, `⚠️ TPA 请求超时 (${this.timeout / 1000}秒)，对方未接受或传送失败。`);
            console.log(`[TeleportRequest] TPA 等待超时`);
            this.stop('timeout');
        }, this.timeout);
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        this.bot.clearControlStates();
    }

    stop(reason = 'cancelled') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;

        // 彻底清理所有定时器和监听器
        if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
        if (this.positionCheckTimer) clearInterval(this.positionCheckTimer);
        if (this.forcedMoveListener) this.bot.removeListener('forcedMove', this.forcedMoveListener);

        console.log(`[TeleportRequest] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = TeleportRequest;
