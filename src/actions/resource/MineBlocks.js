const { EventEmitter } = require('events');
const { Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../../utils/chat');

class MineBlocks extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        this.blockName = params.block_name;
        this.radius = params.radius || 32;
        this.count = params.count || 1;

        this.minedCount = 0;
        this.isPaused = false;
        this.isExecuting = false;

        this._stuckTimer = null;
        this._lastPos = null;
        this._stuckCount = 0;

        this._isBerserk = false;
        this._berserkCancelling = false;

        // ── 狂暴频率限制 ──────────────────────────────────────────
        /** 两次狂暴之间的最小间隔（ms） */
        this._berserkCooldownMs = 15_000;
        /** 滑动窗口时长（ms） */
        this._berserkWindowMs = 60_000;
        /** 窗口内最多触发次数，超过则放弃任务 */
        this._berserkMaxPerWindow = 3;
        /** 记录每次狂暴触发的时间戳 */
        this._berserkTimestamps = [];
        /** 上次狂暴结束的时间戳 */
        this._lastBerserkEndTime = 0;
        // ─────────────────────────────────────────────────────────

        // 黑名单：FIFO 滑动窗口，最多保留3个
        this._blacklistQueue = [];
        this._blacklistSet = new Set();
        this._BLACK_LIST_MAX = 3;

        this._currentTargetBlock = null;
    }

    // ── 狂暴频率检查 ──────────────────────────────────────────────

    /**
     * 检查是否允许触发狂暴。
     * @returns {{ allowed: boolean, reason?: string }}
     */
    _checkBerserkAllowed() {
        const now = Date.now();

        // 1. 冷却检查
        const cooldownRemaining = this._berserkCooldownMs - (now - this._lastBerserkEndTime);
        if (cooldownRemaining > 0) {
            return {
                allowed: false,
                reason: `冷却中，还需等待 ${(cooldownRemaining / 1000).toFixed(1)}s`,
            };
        }

        // 2. 滑动窗口频率检查
        const windowStart = now - this._berserkWindowMs;
        // 清理窗口外的旧记录
        this._berserkTimestamps = this._berserkTimestamps.filter(t => t > windowStart);
        if (this._berserkTimestamps.length >= this._berserkMaxPerWindow) {
            return {
                allowed: false,
                reason: `${this._berserkWindowMs / 1000}s 内已触发 ${this._berserkTimestamps.length} 次，达到上限`,
                overLimit: true,
            };
        }

        return { allowed: true };
    }

    // ─────────────────────────────────────────────────────────────

    _blockKey(pos) {
        return `${pos.x},${pos.y},${pos.z}`;
    }

    _addToBlacklist(block) {
        const key = this._blockKey(block.position);
        if (this._blacklistSet.has(key)) return;

        if (this._blacklistQueue.length >= this._BLACK_LIST_MAX) {
            const oldest = this._blacklistQueue.shift();
            this._blacklistSet.delete(oldest);
            console.log(`[MineBlocks] 黑名单已满，移除最旧条目: ${oldest}`);
        }

        this._blacklistQueue.push(key);
        this._blacklistSet.add(key);
        console.log(`[MineBlocks] 加入黑名单: ${key}，当前黑名单: [${this._blacklistQueue.join(' | ')}]`);
    }

    _isBlacklisted(pos) {
        return this._blacklistSet.has(this._blockKey(pos));
    }

    _clearBlacklist() {
        this._blacklistQueue = [];
        this._blacklistSet.clear();
    }

    async _berserkClear() {
        if (this._isBerserk) return;
        this._isBerserk = true;
        this._berserkCancelling = true;

        this.bot.pathfinder.setGoal(null);
        this.bot.collectBlock.cancelTask();

        await new Promise(r => setTimeout(r, 200));
        this._berserkCancelling = false;

        sendToOwner(this.bot, '😡 狂暴模式！清除周围障碍物！');
        console.log('[MineBlocks] 进入狂暴模式，开始清除周围方块...');

        const feetY = Math.floor(this.bot.entity.position.y);
        const feetX = Math.floor(this.bot.entity.position.x);
        const feetZ = Math.floor(this.bot.entity.position.z);

        console.log(`[MineBlocks] 机器人位置: x=${feetX} y=${feetY} z=${feetZ}`);

        const UNBREAKABLE = new Set([
            'air', 'cave_air', 'void_air', 'bedrock',
            'water', 'lava', 'flowing_water', 'flowing_lava',
        ]);

        const blocksToBreak = [];

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dy = 0; dy <= 2; dy++) {
                    const pos = new Vec3(feetX + dx, feetY + dy, feetZ + dz);
                    const block = this.bot.blockAt(pos);
                    if (!block) continue;

                    console.log(`[MineBlocks] 扫描 (${dx},${dy},${dz}) -> ${block.name} hardness=${block.hardness}`);

                    if (UNBREAKABLE.has(block.name)) continue;
                    if (block.hardness < 0) continue;

                    blocksToBreak.push(block);
                }
            }
        }

        if (blocksToBreak.length === 0) {
            console.log('[MineBlocks] 狂暴模式：周围没有可挖的障碍物');
        } else {
            console.log(`[MineBlocks] 狂暴模式：将挖掉 ${blocksToBreak.length} 个方块`);
            blocksToBreak.sort((a, b) => (a.hardness || 0) - (b.hardness || 0));

            for (const block of blocksToBreak) {
                if (!this.isExecuting) break;
                try {
                    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
                    await this.bot.dig(block, true);
                    console.log(`[MineBlocks] 狂暴挖掉: ${block.name} @ ${block.position}`);
                } catch (e) {
                    console.log(`[MineBlocks] 狂暴模式跳过 ${block.name}: ${e.message}`);
                }
            }
        }

        this.bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 300));
        this.bot.setControlState('jump', false);

        // ✅ 记录本次狂暴结束时间
        this._lastBerserkEndTime = Date.now();

        this._isBerserk = false;
        console.log('[MineBlocks] 狂暴模式结束');
    }

    // ✅ 触发狂暴 + 换目标的统一入口（含频率限制）
    async _berserkAndSwitch(reason) {
        console.log(`[MineBlocks] 触发狂暴+换目标，原因: ${reason}，累计卡住: ${this._stuckCount}`);

        // ── 频率检查 ──────────────────────────────────────────────
        const check = this._checkBerserkAllowed();
        if (!check.allowed) {
            console.log(`[MineBlocks] 狂暴被限流，跳过本次: ${check.reason}`);
            sendToOwner(this.bot, `⏳ 狂暴冷却中（${check.reason}），跳过清障直接换目标`);

            if (check.overLimit) {
                // 超出窗口上限，说明环境极度恶劣，放弃任务
                sendToOwner(this.bot, `🚫 狂暴触发过于频繁，放弃【${this.blockName}】采集任务！`);
                this.stop('berserk_rate_limit_exceeded');
                return;
            }

            // 冷却中：仅换目标，不执行狂暴
            if (this._currentTargetBlock) {
                this._addToBlacklist(this._currentTargetBlock);
            }
            this._stuckCount = 0;
            this._stopStuckDetection();

            if (this.isExecuting && !this.isPaused) {
                setTimeout(() => this._mineNext(), 500);
            }
            return;
        }
        // ─────────────────────────────────────────────────────────

        // ✅ 记录本次触发时间戳
        this._berserkTimestamps.push(Date.now());

        if (this._currentTargetBlock) {
            this._addToBlacklist(this._currentTargetBlock);
            sendToOwner(this.bot, `⚠️ 【${this.blockName}】到不了(${reason})，狂暴清障并换目标！`);
        }

        this._stuckCount = 0;
        this._stopStuckDetection();

        await this._berserkClear();

        if (this.isExecuting && !this.isPaused) {
            setTimeout(() => this._mineNext(), 500);
        }
    }

    _startStuckDetection() {
        this._lastPos = this.bot.entity.position.clone();

        if (this._stuckTimer) return;

        this._stuckTimer = setInterval(async () => {
            if (!this.isExecuting || this.isPaused) return;
            if (this._isBerserk) return;

            const currentPos = this.bot.entity.position;
            const moved = Math.abs(currentPos.x - this._lastPos.x)
                        + Math.abs(currentPos.y - this._lastPos.y)
                        + Math.abs(currentPos.z - this._lastPos.z);
            if (this.bot.targetDigBlock) {
                this._lastPos = this.bot.entity.position.clone();
                this._stuckCount = 0;
                return;
            }
            if (moved < 0.1) {
                this._stuckCount++;
                console.log(`[MineBlocks] 卡住检测 #${this._stuckCount}`);

                if (this._stuckCount === 3) {
                    await this._berserkAndSwitch('卡住3次');
                    return;
                }

                if (this._stuckCount >= 30) {
                    sendToOwner(this.bot, '🆘 反复卡住超过30次，强制狂暴换目标！');
                    await this._berserkAndSwitch('累计卡住30次');
                    return;
                }

                const actionStep = this._stuckCount % 3;
                if (actionStep === 1) {
                    this.bot.setControlState('jump', true);
                    this.bot.setControlState('forward', true);
                    setTimeout(() => {
                        this.bot.setControlState('jump', false);
                        this.bot.setControlState('forward', false);
                    }, 400);
                } else if (actionStep === 2) {
                    this.bot.setControlState('back', true);
                    this.bot.setControlState('jump', true);
                    setTimeout(() => {
                        this.bot.setControlState('back', false);
                        this.bot.setControlState('jump', false);
                    }, 600);
                } else {
                    this.bot.clearControlStates();
                    this.bot.collectBlock.cancelTask();
                }

            } else {
                if (this._stuckCount > 0) {
                    console.log(`[MineBlocks] 已移动，卡住计数重置（之前: ${this._stuckCount}）`);
                }
                this._stuckCount = 0;
            }

            this._lastPos = currentPos.clone();
        }, 1200);
    }

    _stopStuckDetection() {
        if (this._stuckTimer) {
            clearInterval(this._stuckTimer);
            this._stuckTimer = null;
        }
    }

    async execute() {
        this.isExecuting = true;
        this.minedCount = 0;
        this._stuckCount = 0;
        this._berserkTimestamps = [];   // ✅ 新任务开始时重置频率记录
        this._lastBerserkEndTime = 0;
        this._clearBlacklist();
        this._mineNext();
    }

    async _mineNext() {
        if (!this.isExecuting || this.isPaused) return;

        if (this.minedCount >= this.count) {
            this.stop('success');
            return;
        }

        const mcData = require('minecraft-data')(this.bot.version);
        const blockType = mcData.blocksByName[this.blockName];

        if (!blockType) {
            sendToOwner(this.bot, `⚠️ 无法识别的方块名称: ${this.blockName}`);
            this.stop('invalid_block');
            return;
        }

        const movements = new Movements(this.bot, mcData);
        movements.canDig = true;
        movements.allow1by1towers = true;
        movements.allowParkour = true;
        movements.allowSprinting = true;

        const transparentBlocks = [
            'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
            'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
            'azalea_leaves', 'flowering_azalea_leaves',
            'vine', 'glow_lichen', 'twisting_vines', 'weeping_vines',
            'twisting_vines_plant', 'weeping_vines_plant',
        ];
        for (const name of transparentBlocks) {
            const block = mcData.blocksByName[name];
            if (block) {
                movements.replaceables.delete(block.id);
                movements.blocksToAvoid.delete(block.id);
            }
        }
        this.bot.pathfinder.setMovements(movements);

        const candidates = this.bot.findBlocks({
            matching: blockType.id,
            maxDistance: this.radius,
            count: 20,
        });

        const target = candidates.find(pos => !this._isBlacklisted(pos));

        if (!target) {
            sendToOwner(this.bot, `🤷 在 ${this.radius} 格内找不到可用的【${this.blockName}】了（黑名单: ${this._blacklistQueue.length} 个）。已采集 ${this.minedCount} 个。`);
            this.stop('no_blocks_found');
            return;
        }

        const block = this.bot.blockAt(target);
        this._currentTargetBlock = block;

        try {
            this._startStuckDetection();

            await this.bot.collectBlock.collect(block);

            this._currentTargetBlock = null;
            this._stuckCount = 0;
            this.minedCount++;
            console.log(`[MineBlocks] 成功挖掘 ${this.blockName} (${this.minedCount}/${this.count})`);

            if (this.minedCount >= this.count) {
                this.stop('success');
                return;
            }

            setTimeout(() => this._mineNext(), 500);

        } catch (err) {
            this._currentTargetBlock = null;

            if (!this.isExecuting) return;

            if (this._berserkCancelling) {
                console.log('[MineBlocks] 狂暴模式取消，忽略此错误');
                return;
            }

            if (err.message === 'Cancelled') {
                console.log('[MineBlocks] 挖掘任务被取消/重试');
                                if (!this.isPaused && !this._isBerserk) {
                    setTimeout(() => this._mineNext(), 500);
                }
            } else {
                console.log(`[MineBlocks] 挖掘失败: ${err.message}`);
                sendToOwner(this.bot, `⚠️ 挖掘【${this.blockName}】时遇到问题: ${err.message}`);
                
                if (block) {
                    console.log(`[MineBlocks] 将无法到达的方块加入黑名单`);
                    this._addToBlacklist(block);
                }

                setTimeout(() => this._mineNext(), 2000);
            }
        
        }
    }
    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        this._isBerserk = false;
        this._berserkCancelling = false;
        this._stuckCount = 0;
        this._stopStuckDetection();
        this.bot.collectBlock.cancelTask();
        
        // 👇 新增：强制中断底层挖掘动作
        if (this.bot.targetDigBlock) {
            this.bot.stopDigging();
        }

        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();
    }


    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        this._mineNext();
    }
    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        this._isBerserk = false;
        this._berserkCancelling = false;
        this._stuckCount = 0;
        this._currentTargetBlock = null;
        this._clearBlacklist();

        this._stopStuckDetection();
        this.bot.collectBlock.cancelTask();

        // 👇 新增：强制中断底层挖掘动作
        if (this.bot.targetDigBlock) {
            this.bot.stopDigging();
        }

        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();

        this.emit('stop', reason);
    }
}

module.exports = MineBlocks;