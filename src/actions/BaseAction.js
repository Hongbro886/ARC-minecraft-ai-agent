const EventEmitter = require('events');

/**
 * 所有具体 Action (Todo) 的公共基类
 * 实现了标准的生命周期：execute -> pause -> resume -> stop
 */
class BaseAction extends EventEmitter {
    constructor(bot, params, condition, objective) {
        super();
        this.bot = bot;                 // Mineflayer bot 实例
        this.params = params;           // 动作参数 (如 { block_name: "stone", radius: 20 })
        this.condition = condition;     // 维持条件
        this.objective = objective;     // 目标条件
        
        this.status = 'idle';           // 状态: idle | running | paused | completed | failed
        this.tickInterval = null;       // 轮询定时器
    }

    // 1. 启动任务
    async execute() {
        this.status = 'running';
        this.emit('start');
        
        // 开启高频轮询 (Tick)，校验条件和目标
        this.tickInterval = setInterval(() => this._tick(), 500); // 每 0.5 秒校验一次

        // 子类需要实现具体的执行逻辑
        await this.onExecute(); 
    }

    // 2. 挂起任务 (被动本能触发时调用)
    pause() {
        if (this.status !== 'running') return;
        this.status = 'paused';
        this.emit('pause');
        
        // 子类需要实现具体的暂停逻辑 (例如停止寻路、停止挖掘)
        this.onPause();
    }

    // 3. 恢复任务 (危机解除后调用)
    resume() {
        if (this.status !== 'paused') return;
        this.status = 'running';
        this.emit('resume');
        
        // 子类需要实现具体的恢复逻辑
        this.onResume();
    }

    // 4. 停止/结束任务
    stop(reason = 'completed') {
        this.status = reason;
        if (this.tickInterval) clearInterval(this.tickInterval);
        this.emit('stop', reason);
        
        // 子类清理逻辑
        this.onStop();
    }

    // --- 内部高频轮询机制 ---
    _tick() {
        if (this.status !== 'running') return;

        // 触发外部状态机进行 Condition 和 Objective 校验
        this.emit('tick');
    }

    // ==========================================
    // 以下方法由具体的子类 (如 MineBlocks.js) 重写
    // ==========================================
    async onExecute() { throw new Error("子类必须实现 onExecute 方法"); }
    onPause() { /* 默认留空，子类按需重写 */ }
    onResume() { /* 默认留空，子类按需重写 */ }
    onStop() { /* 默认留空，子类按需重写 */ }
}

module.exports = BaseAction;
