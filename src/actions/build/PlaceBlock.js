const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../../utils/chat');

class PlaceBlock extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.blockName = params.block_name;
        
        if (params.coords === 'player_feet') {
            const player = this.bot.players[this.bot.username];
            if (player && player.entity) {
                this.targetPos = player.entity.position.floored();
            } else {
                this.targetPos = this.bot.entity.position.floored();
            }
        } else if (Array.isArray(params.coords) && params.coords.length === 3) {
            this.targetPos = new Vec3(params.coords[0], params.coords[1], params.coords[2]).floored();
        } else {
            this.targetPos = this.bot.entity.position.floored();
        }
        
        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;
        let isJumping = false;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            const blockItem = mcData.itemsByName[this.blockName];

            if (!blockItem) {
                sendToOwner(this.bot, `❌ 无法识别的方块: ${this.blockName}`);
                return this.stop('invalid_block');
            }

            // 1. 距离校验
            const distance = this.bot.entity.position.distanceTo(this.targetPos);
            if (distance > 5.5) {
                sendToOwner(this.bot, `⚠️ 目标位置太远，够不到！`);
                return this.stop('too_far');
            }

            // 2. 目标位置状态校验与自动清理
            const existingBlock = this.bot.blockAt(this.targetPos);
            if (existingBlock && existingBlock.name !== 'air' && existingBlock.name !== 'cave_air') {
                if (existingBlock.name === this.blockName) {
                    console.log(`[PlaceBlock] 目标位置已经是 ${this.blockName}，无需重复放置`);
                    return this.stop('success');
                } else if (existingBlock.boundingBox !== 'empty') {
                    sendToOwner(this.bot, `⚠️ 目标位置已有【${existingBlock.name}】，正在挖掘清除...`);
                    
                    if (!this.bot.canDigBlock(existingBlock)) {
                        sendToOwner(this.bot, `❌ 目标位置的【${existingBlock.name}】无法挖掘！`);
                        return this.stop('obstructed');
                    }

                    try {
                        await this.bot.lookAt(existingBlock.position.offset(0.5, 0.5, 0.5), true);
                        if (!this.isExecuting) return;
                        
                        await this.bot.dig(existingBlock);
                        if (!this.isExecuting) return;
                        
                        console.log(`[PlaceBlock] 成功清除障碍方块: ${existingBlock.name}`);
                    } catch (digErr) {
                        if (!this.isExecuting) return;
                        sendToOwner(this.bot, `❌ 清除障碍方块失败: ${digErr.message}`);
                        return this.stop('dig_failed');
                    }
                }
            }

            // 3. 实体碰撞校验与自动避让（核心改进）
            const entitiesInBlock = Object.values(this.bot.entities).filter(e => {
                if (!e.position) return false;
                const dx = Math.abs(e.position.x - (this.targetPos.x + 0.5));
                const dy = e.position.y - this.targetPos.y;
                const dz = Math.abs(e.position.z - (this.targetPos.z + 0.5));
                return dx < 0.8 && dz < 0.8 && dy >= -0.5 && dy < 1.5;
            });

            if (entitiesInBlock.length > 0) {
                const isSelf = entitiesInBlock.some(e => e === this.bot.entity);
                if (isSelf) {
                    sendToOwner(this.bot, `⚠️ 我挡住了目标位置，尝试避让...`);
                    
                    // 判断目标方块在脚下还是在上半身
                    if (this.targetPos.y <= this.bot.entity.position.y) {
                        // 目标在脚下，执行垫脚跳跃
                        this.bot.setControlState('jump', true);
                        isJumping = true;
                        // 等待 300ms 让机器人跳到半空中，腾出脚下的空间
                        await new Promise(resolve => setTimeout(resolve, 300));
                    } else {
                        // 目标在头上或身子，尝试后退让出空间
                        this.bot.setControlState('back', true);
                        await new Promise(resolve => setTimeout(resolve, 400));
                        this.bot.setControlState('back', false);
                    }
                    
                    if (!this.isExecuting) {
                        if (isJumping) this.bot.setControlState('jump', false);
                        return;
                    }
                } else {
                    sendToOwner(this.bot, `⚠️ 目标位置有其他实体挡住了，无法放置！`);
                    return this.stop('entity_in_way');
                }
            }

            // 4. 检查背包并装备
            const item = this.bot.inventory.items().find(i => i.name === this.blockName);
            if (!item) {
                if (isJumping) this.bot.setControlState('jump', false);
                sendToOwner(this.bot, `⚠️ 背包中没有【${this.blockName}】！`);
                return this.stop('no_item_in_inventory');
            }
            await this.bot.equip(item, 'hand');
            if (!this.isExecuting) {
                if (isJumping) this.bot.setControlState('jump', false);
                return;
            }

            // 5. 计算参考方块
            const { referenceBlock, faceVector } = this._getPlacementDetails();
            if (!referenceBlock) {
                if (isJumping) this.bot.setControlState('jump', false);
                sendToOwner(this.bot, `⚠️ 目标位置附近没有可以依附的方块！`);
                return this.stop('no_reference_block');
            }

            // 6. 放置方块
            try {
                await this.bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5), true);
                if (!this.isExecuting) {
                    if (isJumping) this.bot.setControlState('jump', false);
                    return;
                }

                await this.bot.placeBlock(referenceBlock, faceVector);
                
                // 放置完成后松开跳跃键
                if (isJumping) {
                    this.bot.setControlState('jump', false);
                    isJumping = false;
                }
            } catch (placeErr) {
                if (isJumping) this.bot.setControlState('jump', false);
                if (!this.isExecuting) return; 

                if (placeErr.message && placeErr.message.includes('did not fire within timeout')) {
                    console.warn(`[PlaceBlock] 收到超时警告，正在二次验证...`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    if (!this.isExecuting) return;

                    const checkBlock = this.bot.blockAt(this.targetPos);
                    if (checkBlock && checkBlock.name === this.blockName) {
                        console.log(`[PlaceBlock] 二次验证通过：方块已放置。`);
                    } else {
                        throw new Error(`放置超时且服务器未确认 (可能被隐形实体阻挡)`);
                    }
                } else {
                    throw placeErr; 
                }
            }
            
            if (!this.isExecuting) return;

            console.log(`[PlaceBlock] 成功在 [${this.targetPos.x}, ${this.targetPos.y}, ${this.targetPos.z}] 放置 ${this.blockName}`);
            sendToOwner(this.bot, `✅ 已放置【${this.blockName}】！`);
            this.stop('success');

        } catch (err) {
            if (isJumping) this.bot.setControlState('jump', false);
            if (!this.isExecuting) return;
            console.error(`[PlaceBlock] 放置异常:`, err.message);
            sendToOwner(this.bot, `❌ 放置异常: ${err.message}`);
            this.stop('place_error');
        }
    }

    _getPlacementDetails() {
        const offsets = [
            new Vec3(0, -1, 0),  // 下方
            new Vec3(1, 0, 0),   // 东
            new Vec3(-1, 0, 0),  // 西
            new Vec3(0, 0, 1),   // 南
            new Vec3(0, 0, -1),  // 北
            new Vec3(0, 1, 0),   // 上方
        ];

        for (const offset of offsets) {
            const refPos = this.targetPos.plus(offset);
            const block = this.bot.blockAt(refPos);
            
            if (block && block.name !== 'air' && block.boundingBox === 'block') {
                const faceVector = new Vec3(0, 0, 0).minus(offset);
                return { referenceBlock: block, faceVector };
            }
        }
        return { referenceBlock: null, faceVector: null };
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        // 确保停止时松开按键
        this.bot.setControlState('jump', false);
        this.bot.setControlState('back', false);

        console.log(`[PlaceBlock] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = PlaceBlock;

