const { EventEmitter } = require('events');

class Command extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.command = params.command; // 要发送的指令或文本
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;

        if (!this.command) {
            this.stop('missing_command');
            return;
        }

        try {
            // 发送指令
            this.bot.chat(this.command);
            console.log(`[Command] 执行了指令: ${this.command}`);
            
            // 稍微等待几个 Tick，防止连续发送指令过快被服务器判定为 Spam
            await this.bot.waitForTicks(10);
            
            this.stop('success');
        } catch (err) {
            console.error(`[Command] 指令执行失败:`, err);
            this.stop('error');
        }
    }

    pause() {} // 瞬发动作无需暂停
    resume() {}

    stop(reason = 'cancelled') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.emit('stop', reason);
    }
}

module.exports = Command;
