/**
 * 严格本能：仅接受主人传送 + 自动登录并切服 + 死亡/back
 *
 * 特性：
 * 1) 严格解析传送请求发起人，必须与 ownerName 完全一致（大小写不敏感）
 * 2) 进服后 5 秒：/l <password>，再延迟执行 /server lobby
 * 3) 接受传送时冻结移动，降低失败率
 * 4) 死亡后 2 秒自动 /back
 */
const { sendToOwner } = require('../utils/chat');

class StrictAutoTeleportLogin {
  constructor(bot, config = {}) {
    this.bot = bot;

    // 必填配置
    this.ownerName = (config.ownerName || '').trim(); // 原始
    this.ownerNameLower = this.ownerName.toLowerCase();
    this.loginPassword = config.loginPassword || '';

    // 命令与时间参数
    this.acceptCommand = config.acceptCommand || '/tpaccept';
    this.backCommand = config.backCommand || '/back';

    this.loginDelay = config.loginDelay ?? 5000;                 // 进服后多久发 /l
    this.freezeBeforeAccept = config.freezeBeforeAccept ?? 300;
    this.freezeAfterAccept = config.freezeAfterAccept ?? 1200;
    this.acceptCooldown = config.acceptCooldown ?? 2000;
    this.backDelay = config.backDelay ?? 2000;

    this.debug = config.debug ?? true;

    // 状态
    this._accepting = false;
    this._lastAcceptAt = 0;
    this._dead = false;
    this._didLoginSequence = false; // 仅在首次进服执行登录+切服
    this._timers = new Set();

    // 绑定
    this._onMessage = this._onMessage.bind(this);
    this._onSpawn = this._onSpawn.bind(this);
    this._onLogin = this._onLogin.bind(this); // 新增
    this._onDeath = this._onDeath.bind(this);
  }

  mount() {
    this.bot.on('message', this._onMessage);
    this.bot.on('messagestr', this._onMessage);
    this.bot.on('spawn', this._onSpawn);
    this.bot.on('login', this._onLogin); // 使用已绑定的函数
    this.bot.on('death', this._onDeath);

    this._log('模块已挂载');
    this._log(`严格模式主人: "${this.ownerName || '(未设置)'}"`);
  }

  unmount() {
    this.bot.off('message', this._onMessage);
    this.bot.off('messagestr', this._onMessage);
    this.bot.off('spawn', this._onSpawn);
    this.bot.off('login', this._onLogin);
    this.bot.off('death', this._onDeath);

    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();

    this._log('模块已卸载');
  }

  _log(...args) {
    if (this.debug) console.log('[StrictTP+Login]', ...args);
  }

  _setTimer(fn, ms) {
    const t = setTimeout(() => {
      this._timers.delete(t);
      fn();
    }, ms);
    this._timers.add(t);
    return t;
  }

  _sleep(ms) {
    return new Promise((resolve) => this._setTimer(resolve, ms));
  }

  _extractText(msgLike) {
    if (typeof msgLike === 'string') return msgLike;
    if (!msgLike) return '';
    if (typeof msgLike.toString === 'function') return msgLike.toString();
    return String(msgLike);
  }

  _stripColorCodes(s) {
    return (s || '').replace(/§[0-9a-fk-or]/gi, '');
  }

  _normalizeSpaces(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 严格解析请求人：
   * 支持：
   * - "<name> 请求传送到你这里!"
   * - "<name> 请求传送到他们的位置!"
   * - "<name> has requested to teleport to you"
   * - "<name> has requested that you teleport to them"
   *
   * 返回：
   * { requester: string, type: 'tpa'|'tpahere' } | null
   */
  _parseTeleportRequest(rawText) {
    const clean = this._normalizeSpaces(this._stripColorCodes(rawText));
    if (!clean) return null;

    // 中文
    let m = clean.match(/^([A-Za-z0-9_]{3,16})\s*请求传送到你这里!?/);
    if (m) return { requester: m[1], type: 'tpa' };

    m = clean.match(/^([A-Za-z0-9_]{3,16})\s*请求传送到他们的位置!?/);
    if (m) return { requester: m[1], type: 'tpahere' };

    // 英文常见
    m = clean.match(/^([A-Za-z0-9_]{3,16})\s*has requested to teleport to you/i);
    if (m) return { requester: m[1], type: 'tpa' };

    m = clean.match(/^([A-Za-z0-9_]{3,16})\s*has requested that you teleport to them/i);
    if (m) return { requester: m[1], type: 'tpahere' };

    return null;
  }

  _onMessage(msgLike) {
    const raw = this._extractText(msgLike);
    if (!raw) return;

    const parsed = this._parseTeleportRequest(raw);
    if (!parsed) return;

    const requesterLower = parsed.requester.toLowerCase();

    // 严格校验：必须完全等于 ownerName
    if (!this.ownerNameLower) {
      this._log(`收到 ${parsed.requester} 的 ${parsed.type}，但 ownerName 未设置，忽略`);
      return;
    }

    if (requesterLower !== this.ownerNameLower) {
      this._log(`拒绝非主人请求: ${parsed.requester} (${parsed.type})`);
      return;
    }

    this._log(`识别到主人请求: ${parsed.requester} (${parsed.type})，准备自动接受`);
    this._tryAcceptTeleport();
  }

  async _tryAcceptTeleport() {
    const now = Date.now();
    if (this._accepting) return;
    if (this._dead) return;
    if (now - this._lastAcceptAt < this.acceptCooldown) {
      this._log('命中接受冷却，跳过本次');
      return;
    }

    this._accepting = true;
    this._lastAcceptAt = now;

    try {
      this._freezeMovement();
      this._log(`已冻结移动，${this.freezeBeforeAccept}ms 后发送 ${this.acceptCommand}`);

      await this._sleep(this.freezeBeforeAccept);
      sendToOwner(this.bot, this.acceptCommand);
      this._log(`已发送：${this.acceptCommand}`);

      this._log(`继续冻结 ${this.freezeAfterAccept}ms，等待传送稳定`);
      await this._sleep(this.freezeAfterAccept);
    } catch (err) {
      this._log('自动接受失败:', err?.message || err);
    } finally {
      this._unfreezeMovement();
      this._accepting = false;
      this._log('传送接受流程结束');
    }
  }

  _onLogin() {
    this._log('收到 login 事件 (已连接到服务器)');
    // 如果服务器在 spawn 之前就需要登录，可以在这里触发
    this._startLoginSequence('login');
  }

  _onSpawn() {
    this._dead = false;
    this._log('收到 spawn 事件 (已进入世界)');
    this._startLoginSequence('spawn');
  }

  /**
   * 统一的登录流程启动器
   * @param {string} source - 触发来源 ('login' 或 'spawn')
   */
  _startLoginSequence(source) {
    // 只做一次完整登录流程
    if (this._didLoginSequence) {
      this._log(`登录流程已执行过，本次 ${source} 跳过`);
      return;
    }

    // 参数校验与积极日志
    if (!this.loginPassword) {
      this._log(`警告：未配置 loginPassword，跳过 /l (来自 ${source})`);
      this._didLoginSequence = true;
      return;
    }

    this._didLoginSequence = true;
    this._log(`登录流程启动 (触发源: ${source})：${this.loginDelay}ms 后发送 /l ******`);

    this._setTimer(() => {
      try {
        sendToOwner(this.bot, `/l ${this.loginPassword}`);
        this._log('步骤1完成：已发送 /l ******');
      } catch (err) {
        this._log('步骤1失败：发送 /l 失败 ->', err?.message || err);
      }
    }, this.loginDelay);
  }

  _onDeath() {
    this._dead = true;
    this._log(`检测到死亡，${this.backDelay}ms 后执行 ${this.backCommand}`);

    this._setTimer(() => {
      try {
        sendToOwner(this.bot, this.backCommand);
        this._log(`已发送：${this.backCommand}`);
      } catch (err) {
        this._log('发送 /back 失败:', err?.message || err);
      }
    }, this.backDelay);
  }

  _freezeMovement() {
    const states = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    for (const s of states) this.bot.setControlState(s, false);

    if (this.bot.pathfinder?.isMoving?.()) {
      try {
        this.bot.pathfinder.stop();
        this._log('已停止 pathfinder 移动');
      } catch (_) {}
    }
  }

  _unfreezeMovement() {
    // 不恢复按键状态，交给上层任务系统重新下发
  }
}

module.exports = StrictAutoTeleportLogin;
