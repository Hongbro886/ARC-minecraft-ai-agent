const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class ShearSheepAction extends EventEmitter {
    constructor(bot, params = {}) {
        super();
        this.bot = bot;

        // 基础参数
        this.radius = params.radius || 16;                 // 扫描羊半径
        this.collectRadius = params.collect_radius || 10;  // 捡物半径
        this.loop = params.loop ?? false;                  // 是否持续循环
        this.loopInterval = params.loop_interval || 2500;  // 循环间隔(ms)

        // 寻路接近距离
        this.approachDistance = params.approach_distance || 2;

        // 连续处理同一只羊的冷却（避免短时间反复尝试）
        this.sheepCooldownMs = params.sheep_cooldown_ms || 30_000;

        // 调试日志
        this.debug = params.debug ?? false;

        this.isPaused = false;
        this.isExecuting = false;

        // 记录羊处理时间戳：sheepId -> lastTryTs
        this.sheepCooldownMap = new Map();

        // 常见羊毛掉落物（不同版本可再扩展）
        this.woolItemNames = new Set([
            'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool',
            'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool',
            'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool',
            'brown_wool', 'green_wool', 'red_wool', 'black_wool'
        ]);
    }

    _log(...args) {
        if (this.debug) console.log('[ShearSheepAction]', ...args);
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async _waitIfPaused() {
        while (this.isExecuting && this.isPaused) {
            await this._sleep(400);
        }
    }

    _distanceTo(pos) {
        return this.bot.entity.position.distanceTo(pos);
    }

    _isSheepEntity(e) {
        return e && e.name === 'sheep' && e.position;
    }

    _isBabySheep(entity) {
        // mineflayer 常见字段：metadata[16]（年龄，负值通常代表幼崽）或 entity.isBaby
        // 不同版本协议字段会有差异，做多重兜底判断
        try {
            if (typeof entity.isBaby === 'boolean') return entity.isBaby;
            const ageMeta = entity.metadata?.[16];
            if (typeof ageMeta === 'number' && ageMeta < 0) return true;
        } catch (_) {}
        return false;
    }

    _isLikelySheared(entity) {
        // 不同版本里“是否已剪毛”元数据位不一致，这里用保守策略：
        // 1) 读已知可能字段
        // 2) 无法确认时返回 false（允许尝试一次，失败后进入冷却）
        try {
            // 某些版本/实现里可能有直接字段
            if (typeof entity.sheared === 'boolean') return entity.sheared;

            // 常见羊状态可能放在 metadata 某项 bit flag（不同版本索引不同）
            // 这里尝试扫描 number 型 metadata，若命中低位特征则作为“疑似已剪”
            if (Array.isArray(entity.metadata)) {
                for (const m of entity.metadata) {
                    if (typeof m === 'number') {
                        // 经验性判断：最低位可能表示 sheared（仅作弱判断）
                        if ((m & 0x10) === 0x10) return true;
                    }
                }
            }
        } catch (_) {}
        return false;
    }

    _isInCooldown(entityId) {
        const ts = this.sheepCooldownMap.get(entityId);
        if (!ts) return false;
        return Date.now() - ts < this.sheepCooldownMs;
    }

    _touchCooldown(entityId) {
        this.sheepCooldownMap.set(entityId, Date.now());
    }

    _cleanupCooldownMap(maxSize = 2000) {
        if (this.sheepCooldownMap.size <= maxSize) return;
        const now = Date.now();
        for (const [id, ts] of this.sheepCooldownMap) {
            if (now - ts > this.sheepCooldownMs * 3) {
                this.sheepCooldownMap.delete(id);
            }
        }
    }

    _findShears() {
        return this.bot.inventory.items().find(i => i.name === 'shears');
    }

    _getNearbySheep() {
        return Object.values(this.bot.entities)
            .filter(e => this._isSheepEntity(e) && this._distanceTo(e.position) <= this.radius)
            .sort((a, b) => this._distanceTo(a.position) - this._distanceTo(b.position));
    }

    async _gotoNear(pos, range = this.approachDistance) {
        if (!this.bot.pathfinder) return false;
        const { goals } = require('mineflayer-pathfinder');
        await this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
        return true;
    }

    async _equipShearsOrThrow() {
        const shears = this._findShears();
        if (!shears) throw new Error('no_shears');
        await this.bot.equip(shears, 'hand');
        return shears;
    }

    async _tryShearOne(entity) {
        if (!this.isExecuting) return { ok: false, reason: 'stopped' };
        await this._waitIfPaused();
        if (!this.isExecuting) return { ok: false, reason: 'stopped' };

        if (this._isBabySheep(entity)) {
            this._log(`跳过幼崽羊 ID=${entity.id}`);
            this._touchCooldown(entity.id);
            return { ok: false, reason: 'baby' };
        }

        if (this._isLikelySheared(entity)) {
            this._log(`跳过疑似已剪羊 ID=${entity.id}`);
            this._touchCooldown(entity.id);
            return { ok: false, reason: 'already_sheared' };
        }

        if (this._isInCooldown(entity.id)) {
            return { ok: false, reason: 'cooldown' };
        }

        // 先记录冷却，避免异常导致短时间反复追同一只
        this._touchCooldown(entity.id);

        // 距离太远则靠近
        const dist = this._distanceTo(entity.position);
        if (dist > 3) {
            if (!this.bot.pathfinder) return { ok: false, reason: 'no_pathfinder' };
            try {
                await this._gotoNear(entity.position, this.approachDistance);
            } catch (e) {
                this._log(`无法接近羊 ID=${entity.id}，${e.message}`);
                return { ok: false, reason: 'move_fail' };
            }
        }

        if (!this.isExecuting) return { ok: false, reason: 'stopped' };

        try {
            await this._equipShearsOrThrow();
            await this.bot.lookAt(entity.position.offset(0, entity.height / 2, 0), true);
            await this.bot.activateEntity(entity);
            await this._sleep(350); // 给服务端处理时间
            return { ok: true };
        } catch (e) {
            if (e.message === 'no_shears') return { ok: false, reason: 'no_shears' };
            this._log(`剪毛失败 ID=${entity.id}: ${e.message}`);
            return { ok: false, reason: 'interact_fail' };
        }
    }

    _getNearbyWoolDrops() {
        // mineflayer 掉落物通常是 object 实体，实际物品在 entity.metadata / entity.objectType / entity.displayName 中体现
        // 不同版本结构差异较大，这里采用多重兜底判断
        return Object.values(this.bot.entities).filter(e => {
            if (!e || !e.position) return false;
            if (this._distanceTo(e.position) > this.collectRadius) return false;

            // 常见：掉落物实体名可能是 'item'
            if (e.name !== 'item') return false;

            // 尝试解析物品名
            const itemName =
                e.metadata?.find?.(m => typeof m === 'object' && m?.itemId)?.name || // 兜底，通常取不到
                e.objectTypeName ||
                e.displayName ||
                '';

            // 放宽：无法精确解析时，不直接判定为羊毛
            if (typeof itemName === 'string' && this.woolItemNames.has(itemName)) return true;

            // 某些版本无法从实体直接拿到 name，后续可直接靠近“item”让 bot 吸附拾取
            // 为避免误捡，这里只捡近距离 item（例如 4 格内）
            return this._distanceTo(e.position) <= 4;
        }).sort((a, b) => this._distanceTo(a.position) - this._distanceTo(b.position));
    }

    async _collectNearbyWool(maxTargets = 8) {
        if (!this.bot.pathfinder) return 0;
        let collectedTry = 0;

        const drops = this._getNearbyWoolDrops().slice(0, maxTargets);
        for (const drop of drops) {
            if (!this.isExecuting) break;
            await this._waitIfPaused();
            if (!this.isExecuting) break;

            try {
                await this._gotoNear(drop.position, 1);
                collectedTry++;
                await this._sleep(180);
            } catch (_) {
                // 忽略单个掉落物失败
            }
        }
        return collectedTry;
    }

    async _runOnce() {
        const shears = this._findShears();
        if (!shears) {
            sendToOwner(this.bot, '⚠️ 背包里没有【shears】(剪刀)，无法剪羊毛！');
            return { stop: true, reason: 'no_shears' };
        }

        const sheepList = this._getNearbySheep();
        if (sheepList.length === 0) {
            this._log('附近没有羊');
            // 没羊时也尝试捡一下附近物品
            await this._collectNearbyWool(4);
            return { stop: false, reason: 'no_sheep' };
        }

        let success = 0;
        let attempted = 0;
        let skippedBaby = 0;
        let skippedCooldown = 0;

        for (const sheep of sheepList) {
            if (!this.isExecuting) break;
            await this._waitIfPaused();
            if (!this.isExecuting) break;

            const res = await this._tryShearOne(sheep);
            if (res.reason === 'no_shears') {
                sendToOwner(this.bot, '⚠️ 剪刀已损坏或不在背包中，停止剪羊毛！');
                return { stop: true, reason: 'no_shears' };
            }

            if (res.reason === 'baby') skippedBaby++;
            if (res.reason === 'cooldown') skippedCooldown++;

            if (res.ok) {
                attempted++;
                success++;

                // 成功剪完顺手捡掉落
                await this._collectNearbyWool(5);
            } else if (res.reason !== 'cooldown') {
                attempted++;
            }

            await this._sleep(220);
        }

        this._cleanupCooldownMap();

        sendToOwner(this.bot, 
            `✂️ 本轮完成：成功 ${success}，尝试 ${attempted}，跳过幼崽 ${skippedBaby}，冷却跳过 ${skippedCooldown}。`
        );

        return { stop: false, reason: 'round_done', success, attempted };
    }

    async execute() {
        this.isExecuting = true;

        try {
            sendToOwner(this.bot, 
                this.loop
                    ? `✂️ 启动增强剪羊毛（循环模式），半径 ${this.radius}，捡物半径 ${this.collectRadius}。`
                    : `✂️ 启动增强剪羊毛（单轮模式），半径 ${this.radius}，捡物半径 ${this.collectRadius}。`
            );

            if (this.loop) {
                while (this.isExecuting) {
                    await this._waitIfPaused();
                    if (!this.isExecuting) break;

                    const result = await this._runOnce();
                    if (result.stop) {
                        this.stop(result.reason);
                        return;
                    }

                    // 循环间隔
                    let waitLeft = this.loopInterval;
                    while (this.isExecuting && !this.isPaused && waitLeft > 0) {
                        const step = Math.min(250, waitLeft);
                        await this._sleep(step);
                        waitLeft -= step;
                    }
                }
            } else {
                const result = await this._runOnce();
                if (result.stop) return this.stop(result.reason);
                if (!this.isExecuting) return;
                this.stop('success');
            }
        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[ShearSheepAction] 作业异常:`, err.message);
            sendToOwner(this.bot, `❌ 剪羊毛异常: ${err.message}`);
            this.stop('shear_error');
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
        console.log(`[ShearSheepAction] 动作已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[ShearSheepAction] 动作已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
        console.log(`[ShearSheepAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = ShearSheepAction;
