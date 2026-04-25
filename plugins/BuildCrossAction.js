const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../src/utils/chat'); // 修正路径：从 plugins 目录指向 src/utils/chat

class BuildCross extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.isPaused = false;
        this.isExecuting = false;
    }

    async execute() {
        this.isExecuting = true;

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            
            // 1. 在背包中随机寻找一种数量 >= 6 的方块 (十字架需要6个方块)
            const items = this.bot.inventory.items();
            const validBlocks = items.filter(item => {
                const blockData = mcData.blocksByName[item.name];
                return blockData && item.count >= 6;
            });

            if (validBlocks.length === 0) {
                sendToOwner(this.bot, `⚠️ 背包中没有数量足够（至少6个）的方块来建造十字架！`);
                return this.stop('no_blocks');
            }

            // 随机选择一种方块
            const selectedItem = validBlocks[Math.floor(Math.random() * validBlocks.length)];
            const blockName = selectedItem.name;
            sendToOwner(this.bot, `✝️ 决定使用【${blockName}】来建造十字架，愿圣光忽悠着你~`);

            // 2. 计算建造基准位置（玩家正前方2格的地面）
            const yaw = this.bot.entity.yaw;
            const dx = -Math.sin(yaw) * 2;
            const dz = -Math.cos(yaw) * 2;
            const basePos = this.bot.entity.position.floored().offset(Math.round(dx), 0, Math.round(dz));

            // 计算左右偏移方向（与玩家朝向垂直）
            let offsetLeft, offsetRight;
            if (Math.abs(dx) > Math.abs(dz)) {
                offsetLeft = new Vec3(0, 0, -1);
                offsetRight = new Vec3(0, 0, 1);
            } else {
                offsetLeft = new Vec3(-1, 0, 0);
                offsetRight = new Vec3(1, 0, 0);
            }

            // 3. 规划建造步骤 (必须从下往上，保证有方块可以依附)
            // 结构:
            //       [顶部]
            // [左臂] [中心] [右臂]
            //       [下半]
            //       [底座]
            const buildSteps = [
                { pos: basePos, desc: "底座 (0层)" },
                { pos: basePos.offset(0, 1, 0), desc: "下半部分 (1层)" },
                { pos: basePos.offset(0, 2, 0), desc: "十字中心 (2层)" },
                { pos: basePos.offset(0, 3, 0), desc: "顶部 (3层)" },
                { pos: basePos.offset(0, 2, 0).plus(offsetLeft), desc: "左臂 (2层)" },
                { pos: basePos.offset(0, 2, 0).plus(offsetRight), desc: "右臂 (2层)" }
            ];

            // 4. 依次放置方块
            for (const step of buildSteps) {
                if (!this.isExecuting) return;
                await this._placeSingleBlock(step.pos, blockName);
                await new Promise(resolve => setTimeout(resolve, 400)); // 稍微增加一点延迟，防止服务器判定过快导致放置失败
            }

            if (!this.isExecuting) return;
            console.log(`[BuildCross] 成功建造十字架！`);
            sendToOwner(this.bot, `✅ 祈祷完毕！一个神圣的十字架已经建好啦喵~`);
            this.stop('success');

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[BuildCross] 建造异常:`, err.message);
            sendToOwner(this.bot, `❌ 建造异常: ${err.message}`);
            this.stop('build_error');
        }
    }

    async _placeSingleBlock(targetPos, blockName) {
        // 1. 目标位置状态校验与自动清理
        const existingBlock = this.bot.blockAt(targetPos);
        if (existingBlock && existingBlock.name !== 'air' && existingBlock.name !== 'cave_air') {
            if (existingBlock.name === blockName) {
                return; // 已经是目标方块
            } else if (existingBlock.boundingBox !== 'empty') {
                if (!this.bot.canDigBlock(existingBlock)) {
                    throw new Error(`目标位置的【${existingBlock.name}】无法挖掘！`);
                }
                await this.bot.lookAt(existingBlock.position.offset(0.5, 0.5, 0.5), true);
                if (!this.isExecuting) return;
                await this.bot.dig(existingBlock);
            }
        }

        // 2. 实体碰撞校验与自动避让
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
                this.bot.setControlState('back', true);
                await new Promise(resolve => setTimeout(resolve, 600));
                this.bot.setControlState('back', false);
            } else {
                throw new Error(`目标位置有其他实体挡住了，无法放置！`);
            }
        }

        // 3. 装备方块
        const item = this.bot.inventory.items().find(i => i.name === blockName);
        if (!item) {
            throw new Error(`背包中找不到【${blockName}】了！`);
        }
        await this.bot.equip(item, 'hand');
        if (!this.isExecuting) return;

        // 4. 计算参考方块
        const { referenceBlock, faceVector } = this._getPlacementDetails(targetPos);
        if (!referenceBlock) {
            throw new Error(`目标位置附近没有可以依附的方块！`);
        }

        // 5. 放置方块
        try {
            await this.bot.lookAt(referenceBlock.position.offset(0.5, 0.5, 0.5), true);
            if (!this.isExecuting) return;
            await this.bot.placeBlock(referenceBlock, faceVector);
        } catch (placeErr) {
            if (placeErr.message && placeErr.message.includes('did not fire within timeout')) {
                await new Promise(resolve => setTimeout(resolve, 500));
                const checkBlock = this.bot.blockAt(targetPos);
                if (!checkBlock || checkBlock.name !== blockName) {
                    throw new Error(`放置超时且服务器未确认`);
                }
            } else {
                throw placeErr;
            }
        }
    }

    _getPlacementDetails(targetPos) {
        const offsets = [
            new Vec3(0, -1, 0),  // 下方
            new Vec3(1, 0, 0),   // 东
            new Vec3(-1, 0, 0),  // 西
            new Vec3(0, 0, 1),   // 南
            new Vec3(0, 0, -1),  // 北
            new Vec3(0, 1, 0),   // 上方
        ];

        for (const offset of offsets) {
            const refPos = targetPos.plus(offset);
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
        
        this.bot.setControlState('jump', false);
        this.bot.setControlState('back', false);

        console.log(`[BuildCross] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

// ==========================================
// 暴露给动态插件系统的配置信息
// ==========================================
module.exports = {
    actionName: "BuildCrossAction",
    description: "在玩家面前用方块建造一个十字架",
    params: {}, // 这个动作不需要额外参数
    condition: {}, 
    objective: {},
    actionClass: BuildCross // 暴露类本身供 StateMachine 实例化
};