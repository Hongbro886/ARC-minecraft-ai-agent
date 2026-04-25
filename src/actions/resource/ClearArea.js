const { EventEmitter } = require('events');
const { Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { sendToOwner } = require('../../utils/chat');

class ClearArea extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        
        // 接收并转换坐标参数
        this.pos1 = params.pos1 ? new Vec3(params.pos1.x, params.pos1.y, params.pos1.z) : null;
        this.pos2 = params.pos2 ? new Vec3(params.pos2.x, params.pos2.y, params.pos2.z) : null;
        
        this.areaBlocksList = []; // 待清理的方块坐标列表
        this.minedCount = 0;
        this.isPaused = false;
        this.isExecuting = false;

        this._stuckTimer = null;
        this._lastPos = null;
        this._stuckCount = 0;

        this._isBerserk = false;
        this._berserkCancelling = false;

        // ── 狂暴频率限制 ──────────────────────────────────────────
        this._berserkCooldownMs = 15_000;
        this._berserkWindowMs = 60_000;
        this._berserkMaxPerWindow = 3;
        this._berserkTimestamps = [];
        this._lastBerserkEndTime = 0;
        // ─────────────────────────────────────────────────────────

        // 黑名单：防止死循环挖不到的方块
        this._blacklistQueue = [];
        this._blacklistSet = new Set();
        this._BLACK_LIST_MAX = 5;

        this._currentTargetBlock = null;
    }

    _checkBerserkAllowed() {
        const now = Date.now();
        const cooldownRemaining = this._berserkCooldownMs - (now - this._lastBerserkEndTime);
        if (cooldownRemaining > 0) {
            return { allowed: false, reason: `冷却中，还需等待 ${(cooldownRemaining / 1000).toFixed(1)}s` };
        }

        const windowStart = now - this._berserkWindowMs;
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

    _blockKey(pos) {
        return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    }

    _addToBlacklist(block) {
        const key = this._blockKey(block.position);
        if (this._blacklistSet.has(key)) return;

        if (this._blacklistQueue.length >= this._BLACK_LIST_MAX) {
            const oldest = this._blacklistQueue.shift();
            this._blacklistSet.delete(oldest);
        }

        this._blacklistQueue.push(key);
        this._blacklistSet.add(key);
        console.log(`[ClearArea] 加入黑名单: ${key}`);
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
        console.log('[ClearArea] 进入狂暴模式，开始清除周围方块...');

        const feetY = Math.floor(this.bot.entity.position.y);
        const feetX = Math.floor(this.bot.entity.position.x);
        const feetZ = Math.floor(this.bot.entity.position.z);

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

                    if (UNBREAKABLE.has(block.name)) continue;
                    if (block.hardness < 0) continue;

                    blocksToBreak.push(block);
                }
            }
        }

        if (blocksToBreak.length > 0) {
            blocksToBreak.sort((a, b) => (a.hardness || 0) - (b.hardness || 0));
            for (const block of blocksToBreak) {
                if (!this.isExecuting) break;
                try {
                    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
                    await this.bot.dig(block, true);
                } catch (e) {
                    console.log(`[ClearArea] 狂暴模式跳过 ${block.name}: ${e.message}`);
                }
            }
        }

        this.bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 300));
        this.bot.setControlState('jump', false);

        this._lastBerserkEndTime = Date.now();
        this._isBerserk = false;
        console.log('[ClearArea] 狂暴模式结束');
    }

    async _berserkAndSwitch(reason) {
        console.log(`[ClearArea] 触发狂暴+换目标，原因: ${reason}`);

        const check = this._checkBerserkAllowed();
        if (!check.allowed) {
            console.log(`[ClearArea] 狂暴被限流: ${check.reason}`);
            sendToOwner(this.bot, '⏳ 狂暴冷却中，跳过清障直接换目标');

            if (check.overLimit) {
                sendToOwner(this.bot, '🚫 狂暴触发过于频繁，放弃区域清理任务！');
                this.stop('berserk_rate_limit_exceeded');
                return;
            }

            if (this._currentTargetBlock) {
                this._addToBlacklist(this._currentTargetBlock);
            }
            this._stuckCount = 0;
            this._stopStuckDetection();

            if (this.isExecuting && !this.isPaused) {
                setTimeout(() => this._mineNextArea(), 500);
            }
            return;
        }

        this._berserkTimestamps.push(Date.now());

        if (this._currentTargetBlock) {
            this._addToBlacklist(this._currentTargetBlock);
            sendToOwner(this.bot, `⚠️ 到不了目标方块(${reason})，狂暴清障并换目标！`);
        }

        this._stuckCount = 0;
        this._stopStuckDetection();

        await this._berserkClear();

        if (this.isExecuting && !this.isPaused) {
            setTimeout(() => this._mineNextArea(), 500);
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

            if (moved < 0.1) {
                this._stuckCount++;
                console.log(`[ClearArea] 卡住检测 #${this._stuckCount}`);

                if (this._stuckCount === 3) {
                    await this._berserkAndSwitch('卡住3次');
                    return;
                }

                if (this._stuckCount >= 30) {
                    this.bot.chat('🆘 反复卡住超过30次，强制狂暴换目标！');
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
                this._stuckCount = 0;
            }

            this._lastPos = currentPos.clone();
        }, 1000);
    }

    _stopStuckDetection() {
        if (this._stuckTimer) {
            clearInterval(this._stuckTimer);
            this._stuckTimer = null;
        }
    }

    _initAreaBlocks() {
        this.areaBlocksList = [];
        if (!this.pos1 || !this.pos2) {
            return false;
        }

        const minX = Math.min(this.pos1.x, this.pos2.x);
        const maxX = Math.max(this.pos1.x, this.pos2.x);
        const minY = Math.min(this.pos1.y, this.pos2.y);
        const maxY = Math.max(this.pos1.y, this.pos2.y);
        const minZ = Math.min(this.pos1.z, this.pos2.z);
        const maxZ = Math.max(this.pos1.z, this.pos2.z);

        // 从上到下遍历，防止挖空脚下或被沙砾砸死
        for (let y = maxY; y >= minY; y--) {
            for (let x = minX; x <= maxX; x++) {
                for (let z = minZ; z <= maxZ; z++) {
                    this.areaBlocksList.push(new Vec3(x, y, z));
                }
            }
        }
        console.log(`[ClearArea] 区域清理初始化完成，共计 ${this.areaBlocksList.length} 个坐标点。`);
        return true;
    }

    async execute() {
        this.isExecuting = true;
        this.minedCount = 0;
        this._stuckCount = 0;
        this._berserkTimestamps = [];
        this._lastBerserkEndTime = 0;
        this._clearBlacklist();

        if (!this._initAreaBlocks()) {
            this.bot.chat('⚠️ 区域坐标不完整，无法执行清理任务。');
            this.stop('invalid_params');
            return;
        }

        this.bot.chat(`🧹 开始清理指定区域...`);
        this._mineNextArea();
    }

    async _mineNextArea() {
        if (!this.isExecuting || this.isPaused) return;

        const UNBREAKABLE = new Set([
            'air', 'cave_air', 'void_air', 'bedrock',
            'water', 'lava', 'flowing_water', 'flowing_lava',
        ]);

        let targetPos = null;
        let block = null;

        // 寻找列表中下一个合法的方块
        while (this.areaBlocksList.length > 0) {
            targetPos = this.areaBlocksList[0];

            if (this._isBlacklisted(targetPos)) {
                this.areaBlocksList.shift();
                continue;
            }

            block = this.bot.blockAt(targetPos);
            
            // 如果区块未加载，跳过
            if (!block) {
                this.areaBlocksList.shift();
                continue;
            }

            if (UNBREAKABLE.has(block.name) || block.hardness < 0) {
                this.areaBlocksList.shift(); // 跳过空气或不可破坏方块
                continue;
            }

            break; // 找到了需要挖的方块
        }

        if (this.areaBlocksList.length === 0) {
            this.bot.chat(`✅ 区域清理完成！共清理了 ${this.minedCount} 个方块。`);
            this.stop('success');
            return;
        }

        this._currentTargetBlock = block;

        try {
            this._startStuckDetection();

            const mcData = require('minecraft-data')(this.bot.version);
            const movements = new Movements(this.bot, mcData);
            movements.canDig = true;
            movements.allow1by1towers = true;
            movements.allowParkour = true;
            
            // 忽略树叶等透明方块的寻路阻挡
            const transparentBlocks = [
                'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
                'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
                'azalea_leaves', 'flowering_azalea_leaves', 'vine', 'glow_lichen'
            ];
            for (const name of transparentBlocks) {
                const b = mcData.blocksByName[name];
                if (b) {
                    movements.replaceables.delete(b.id);
                    movements.blocksToAvoid.delete(b.id);
                }
            }
            this.bot.pathfinder.setMovements(movements);

            await this.bot.collectBlock.collect(block);

            this.areaBlocksList.shift(); // 成功挖掉，移出队列
            this._currentTargetBlock = null;
            this._stuckCount = 0;
            this.minedCount++;
            console.log(`[ClearArea] 成功清理方块: ${block.name} @ ${targetPos} (已清理 ${this.minedCount} 个)`);

            setTimeout(() => this._mineNextArea(), 100);

        } catch (err) {
            this._currentTargetBlock = null;

            if (!this.isExecuting) return;

            if (this._berserkCancelling) {
                return;
            }

            if (err.message === 'Cancelled') {
                if (!this.isPaused) {
                    setTimeout(() => this._mineNextArea(), 500);
                }
            } else {
                console.log(`[ClearArea] 清理方块失败: ${err.message}`);
                // 挖不到则加入黑名单，防止死循环
                if (block) this._addToBlacklist(block);
                setTimeout(() => this._mineNextArea(), 2000);
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
        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        this._mineNextArea();
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
        this.bot.pathfinder.setGoal(null);
        this.bot.clearControlStates();

        this.emit('stop', reason);
    }
}

module.exports = ClearArea;
