const { EventEmitter } = require('events');
const { goals } = require('mineflayer-pathfinder');
const { sendToOwner } = require('../../utils/chat');

class FollowPlayer extends EventEmitter {
  constructor(bot, params = {}) {
    super();
    this.bot = bot;

    this.targetName = params.player_name || params.username || null;
    this.minDistance = typeof params.min_distance === 'number' ? params.min_distance : 2; // 小于这个距离就不再贴近
    this.maxDistance = typeof params.max_distance === 'number' ? params.max_distance : 4; // 大于这个距离就追
    this.repathInterval = typeof params.repath_interval === 'number' ? params.repath_interval : 500; // ms
    this.unseenTimeout = typeof params.unseen_timeout === 'number' ? params.unseen_timeout : 8000; // ms

    this.isPaused = false;
    this.isExecuting = false;

    this._timer = null;
    this._lastSeenAt = Date.now();
  }

  async execute() {
    this.isExecuting = true;

    try {
      if (!this.bot.pathfinder) {
        sendToOwner(this.bot, '❌ 未加载 pathfinder 插件，无法跟随。');
        return this.stop('pathfinder_not_loaded');
      }

      if (!this.targetName) {
        sendToOwner(this.bot, '❌ 缺少 player_name 参数。');
        return this.stop('missing_target_name');
      }

      const target = this._getTargetPlayer();
      if (!target || !target.entity) {
        sendToOwner(this.bot, `⚠️ 玩家 ${this.targetName} 不在线或不可见。`);
        return this.stop('target_not_found');
      }

      this._lastSeenAt = Date.now();
      sendToOwner(this.bot, `👣 开始跟随玩家：${this.targetName}`);

      this._timer = setInterval(() => this._tick(), this.repathInterval);
    } catch (err) {
      if (!this.isExecuting) return;
      sendToOwner(this.bot, `❌ 跟随异常: ${err.message}`);
      this.stop('follow_error');
    }
  }

  _tick() {
    if (!this.isExecuting) return;
    if (this.isPaused) return;

    const target = this._getTargetPlayer();
    if (!target || !target.entity) {
      // 玩家暂时不可见：给一段宽限时间
      if (Date.now() - this._lastSeenAt > this.unseenTimeout) {
        sendToOwner(this.bot, `⚠️ 目标玩家 ${this.targetName} 长时间不可见，停止跟随。`);
        return this.stop('target_unseen_timeout');
      }
      return;
    }

    this._lastSeenAt = Date.now();

    const myPos = this.bot.entity.position;
    const tPos = target.entity.position;
    const dist = myPos.distanceTo(tPos);

    // 太近就停止移动，避免顶脸
    if (dist <= this.minDistance) {
      this.bot.pathfinder.setGoal(null);
      return;
    }

    // 超出追踪距离就持续追踪目标实体位置
    if (dist > this.maxDistance) {
      const goal = new goals.GoalFollow(target.entity, this.minDistance);
      this.bot.pathfinder.setGoal(goal, true); // dynamic=true，目标移动时持续跟随
      return;
    }

    // 在[minDistance, maxDistance]之间，保持当前状态（一般不需要频繁改目标）
  }

  _getTargetPlayer() {
    return this.bot.players[this.targetName];
  }

  pause() {
    if (!this.isExecuting || this.isPaused) return;
    this.isPaused = true;
    if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
  }

  resume() {
    if (!this.isExecuting || !this.isPaused) return;
    this.isPaused = false;
  }

  stop(reason = 'cancelled_by_user') {
    if (!this.isExecuting) return;
    this.isExecuting = false;
    this.isPaused = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this.bot.pathfinder) {
      this.bot.pathfinder.setGoal(null);
    }

    console.log(`[FollowPlayer] 动作结束，原因: ${reason}`);
    this.emit('stop', reason);
  }
}

module.exports = FollowPlayer;
