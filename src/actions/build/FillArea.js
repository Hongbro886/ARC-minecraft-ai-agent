const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { Movements } = require('mineflayer-pathfinder');
const { sendToOwner } = require('../../utils/chat');

class FillArea extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.blockName = params.block_name;
        
        // 接收并转换坐标参数
        this.pos1 = params.pos1 ? new Vec3(params.pos1.x, params.pos1.y, params.pos1.z).floored() : null;
        this.pos2 = params.pos2 ? new Vec3(params.pos2.x, params.pos2.y, params.pos2.z).floored() : null;
        
        this.areaBlocksList = [];
        this.retryQueue = [];
        this.placedCount = 0;
        
        this.isPaused = false;
        this.isExecuting = false;
        this._lastRoundPlacedCount = -1; // 用于防止重试队列死循环
    }

    _initAreaBlocks() {
        this.areaBlocksList = [];
        if (!this.pos1 || !this.pos2) return false;

        const minX = Math.min(this.pos1.x, this.pos2.x);
        const maxX = Math.max(this.pos1.x, this.pos2.x);
        const minY = Math.min(this.pos1.y, this.pos2.y);
        const maxY = Math.max(this.pos1.y, this.pos2.y);
        const minZ = Math.min(this.pos1.z, this.pos2.z);
        const maxZ = Math.max(this.pos1.z, this.pos2.z);

        // 🌟 核心：从下到上遍历 (Y轴递增)，确保方块有依附点
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                for (let z = minZ; z <= maxZ; z++) {
                    this.areaBlocksList.push(new Vec3(x, y, z));
                }
            }
        }
        console.log(`[FillArea] 区域填充初始化完成，共计 ${this.areaBlocksList.length} 个坐标点。`);
        return true;
    }

    async execute() {
        this.isExecuting = true;
        this.placedCount = 0;
        this.retryQueue = [];
        this._lastRoundPlacedCount = -1;

        if (!this._initAreaBlocks()) {
            sendToOwner(this.bot, '⚠️ 区域坐标不完整，无法执行填充任务。');
            this.stop('invalid_params');
            return;
        }

        sendToOwner(this.bot, `🧱 开始将指定区域填充为【${this.blockName}】...`);
        this._placeNextArea();
    }

    async _placeNextArea() {
        if (!this.isExecuting || this.isPaused) return;

        // 1. 队列管理与死循环检测
        if (this.areaBlocksList.length === 0) {
            if (this.retryQueue.length > 0) {
                console.log(`[FillArea] 主队列为空，开始处理重试队列 (${this.retryQueue.length} 个)`);
                
                // 如果上一轮重试中一个方块都没放成功，说明剩下的全悬空或被死死挡住，直接结束防死循环
                if (this._lastRoundPlacedCount === 0) {
                    sendToOwner(this.bot, `⚠️ 剩下的 ${this.retryQueue.length} 个方块找不到依附点或被阻挡，无法继续填充。`);
                    this.stop('unreachable_blocks');
                    return;
                }
                
                this.areaBlocksList = this.retryQueue;
                this.retryQueue = [];
                this._lastRoundPlacedCount = 0; // 开启新一轮，重置计数
            } else {
                sendToOwner(this.bot, `✅ 区域填充完成！共放置了 ${this.placedCount} 个方块。`);
                this.stop('success');
                return;
            }
        }

        const targetPos = this.areaBlocksList.shift();
        let isJumping = false;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const blockItem = mcData.itemsByName[this.blockName];

            if (!blockItem) {
                sendToOwner(this.bot, `❌ 无法识别的方块: ${this.blockName}`);
                return this.stop('invalid_block');
            }

            // 2. 距离校验与自动寻路
            const distance = this.bot.entity.position.distanceTo(targetPos);
            if (distance > 4.5) {
                const movements = new Movements(this.bot, mcData);
                movements.canDig = false; // 寻路时不挖方块，防止破坏刚建好的结构
                this.bot.pathfinder.setMovements(movements);
                
                const { GoalNear } = require('mineflayer-pathfinder').goals;
                try {
                    // 走到距离目标 3 格以内
                    await this.bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
                } catch (e) {
                    console.log(`[FillArea] 寻路到目标失败，加入重试队列: ${e.message}`);
                    this.retryQueue.push(targetPos);
                    setTimeout(() => this._placeNextArea(), 500);
                    return;
                }
                if (!this.isExecuting) return;
            }

            // 3. 目标位置状态校验与自动清理障碍
            const existingBlock = this.bot.blockAt(targetPos);
            if (existingBlock && existingBlock.name !== 'air' && existingBlock.name !== 'cave_air') {
                if (existingBlock.name === this.blockName) {
                    // 已经是目标方块，直接跳过
                    setTimeout(() => this._placeNextArea(), 50);
                    return;
                } else if (existingBlock.boundingBox !== 'empty') {
                    if (!this.bot.canDigBlock(existingBlock)) {
                        console.log(`[FillArea] 目标位置的【${existingBlock.name}】无法挖掘，跳过`);
                        setTimeout(() => this._placeNextArea(), 50);
                        return;
                    }
                    try {
                        await this.bot.lookAt(existingBlock.position.offset(0.5, 0.5, 0.5), true);
                        if (!this.isExecuting) return;
                        await this.bot.dig(existingBlock);
                        if (!this.isExecuting) return;
                    } catch (digErr) {
                        console.log(`[FillArea] 清除障碍方块失败，加入重试队列`);
                        this.retryQueue.push(targetPos);
                        setTimeout(() => this._placeNextArea(), 500);
                        return;
                    }
                }
            }

            // 4. 实体碰撞校验与自动避让
            const entitiesInBlock = Object.values(this.bot.entities).filter(e => {
                if (!e.position) return false;
                const dx = Math.abs(e.position.x - (targetPos.x + 0.5));
                const dy = e.position.y - targetPos.y;
                const dz = Math.abs(e.position.z - (targetPos.z + 0.5));
                return dx < 0.8 && dz < 0.8 && dy >= -0.5 && dy < 1.5;
            });

            if (entitiesInBlock.length > 0) {
                const isSelf = entitiesInBlock.some(e => e === this.bot.entity);
                if (isSelf) {
                    if (targetPos.y <= this.bot.entity.position.y) {
                        this.bot.setControlState('jump', true);
                        isJumping = true;
                        await new Promise(resolve => setTimeout(resolve, 300));
                    } else {
                        this.bot.setControlState('back', true);
                        await new Promise(resolve => setTimeout(resolve, 400));
                        this.bot.setControlState('back', false);
                    }
                    if (!this.isExecuting) {
                        if (isJumping) this.bot.setControlState('jump', false);
                        return;
                    }
                } else {
                    console.log(`[FillArea] 目标位置有其他实体挡住了，加入重试队列`);
                    this.retryQueue.push(targetPos);
                    setTimeout(() => this._placeNextArea(), 500);
                    return;
                }
            }

            // 5. 检查背包并装备
            const item = this.bot.inventory.items().find(i => i.name === this.blockName);
            if (!item) {
                if (isJumping) this.bot.setControlState('jump', false);
                sendToOwner(this.bot, `⚠️ 背包中没有【${this.blockName}】了！已放置 ${this.placedCount} 个。`);
                return this.stop('no_item_in_inventory');
            }
            await this.bot.equip(item, 'hand');
            if (!this.isExecuting) {
                if (isJumping) this.bot.setControlState('jump', false);
                return;
            }

            // 6. 计算参考方块
            const { referenceBlock, faceVector } = this._getPlacementDetails(targetPos);
            if (!referenceBlock) {
                if (isJumping) this.bot.setControlState('jump', false);
                console.log(`[FillArea] ${targetPos} 附近没有可以依附的方块，加入重试队列`);
                this.retryQueue.push(targetPos);
                setTimeout(() => this._placeNextArea(), 100);
                return;
            }

            // 7. 放置方块
            try {
                await this.bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5), true);
                if (!this.isExecuting) {
                    if (isJumping) this.bot.setControlState('jump', false);
                    return;
                }

                await this.bot.placeBlock(referenceBlock, faceVector);
                
                if (isJumping) {
                    this.bot.setControlState('jump', false);
                    isJumping = false;
                }
            } catch (placeErr) {
                if (isJumping) this.bot.setControlState('jump', false);
                if (!this.isExecuting) return; 

                if (placeErr.message && placeErr.message.includes('did not fire within timeout')) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    if (!this.isExecuting) return;

                    const checkBlock = this.bot.blockAt(targetPos);
                    if (checkBlock && checkBlock.name !== this.blockName) {
                        this.retryQueue.push(targetPos);
                        setTimeout(() => this._placeNextArea(), 500);
                        return;
                    }
                } else {
                    console.log(`[FillArea] 放置异常: ${placeErr.message}`);
                    this.retryQueue.push(targetPos);
                    setTimeout(() => this._placeNextArea(), 500);
                    return;
                }
            }
            
            if (!this.isExecuting) return;

            this.placedCount++;
            if (this._lastRoundPlacedCount !== -1) this._lastRoundPlacedCount++; // 记录本轮成功次数
            console.log(`[FillArea] 成功在 ${targetPos} 放置 ${this.blockName} (已放置 ${this.placedCount} 个)`);
            
            setTimeout(() => this._placeNextArea(), 100);

        } catch (err) {
            if (isJumping) this.bot.setControlState('jump', false);
            if (!this.isExecuting) return;
            console.error(`[FillArea] 严重异常:`, err.message);
            this.retryQueue.push(targetPos);
            setTimeout(() => this._placeNextArea(), 1000);
        }
    }

    _getPlacementDetails(targetPos) {
        const offsets = [
            new Vec3(0, -1, 0),  // 下方优先
            new Vec3(1, 0, 0),   // 东
            new Vec3(-1, 0, 0),  // 西
            new Vec3(0, 0, 1),   // 南
            new Vec3(0, 0, -1),  // 北
            new Vec3(0, 1, 0),   // 上方
        ];

        for (const offset of offsets) {
            const refPos = targetPos.plus(offset);
            const block = this.bot.blockAt(refPos);
            
            if (block && block.name !== 'air' && block.name !== 'cave_air' && block.boundingBox === 'block') {
                const faceVector = new Vec3(0, 0, 0).minus(offset);
                return { referenceBlock: block, faceVector };
            }
        }
        return { referenceBlock: null, faceVector: null };
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        this.bot.setControlState('jump', false);
        this.bot.setControlState('back', false);
        this.bot.pathfinder.setGoal(null);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        this._placeNextArea();
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        this.bot.setControlState('jump', false);
        this.bot.setControlState('back', false);
        this.bot.pathfinder.setGoal(null);

        console.log(`[FillArea] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = FillArea;
