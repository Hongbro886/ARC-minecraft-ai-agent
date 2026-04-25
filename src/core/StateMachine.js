const ConditionParser = require('./ConditionParser');
const ObjectiveParser = require('./ObjectiveParser');
const { sendToOwner } = require('../utils/chat');

// 动作注册表 (后续增加新动作只需在这里注册)
const ActionRegistry = {
    'GoTo': require('../actions/move/GoTo'),
    'MineBlocks': require('../actions/resource/MineBlocks'),
    'CraftItem': require('../actions/craft/CraftItem'),
    'PlaceBlock': require('../actions/build/PlaceBlock'),
    'SmeltItem': require('../actions/craft/SmeltItem'),
    'ClearArea': require('../actions/resource/ClearArea'),  // 新增的两个动作
    'Command': require('../actions/basic/Command'),
    'TeleportRequest': require('../actions/move/TeleportRequest'),
    'TakeItemsAction': require('../actions/logic/TakeItems'),
    'FillArea': require('../actions/build/FillArea'),
    'FarmAction': require('../actions/resource/FarmAction'),
    'DropItemAction': require('../actions/basic/DropItemAction'),
    'BreedAnimalAction': require('../actions/basic/BreedAnimalAction'),
    'KillEntityAction': require('../actions/fight/KillEntityAction'),
    'PvpAction': require('../actions/fight/PvpAction'),
    'StoreItemAction': require('../actions/logic/StoreItems'),
    'PatrolAction': require('../actions/fight/PatrolAction'),
    'ShearSheepAction': require('../actions/basic/ShearSheepAction'),
    'BuildGediaoAction': require('../actions/basic/BuildGediao'),
    'FollowPlayer': require('../actions/move/FollowPlayer'),
    'DelayAction': require('../actions/basic/DelayAction'),
    'BoneMealAction': require('../actions/basic/BoneMealAction'),
    'FishAction': require('../actions/resource/FishAction'),
    // 新增的两个动作
};

class StateMachine {
    constructor(bot) {
        this.bot = bot;
        this.currentActionInstance = null;
        this.isSleeping = false;
        this.wakeUpResolver = null; // 用于存储 Promise 的 resolve 函数
        this.currentPlan = null;
        this.currentIndex = 0;
    }

    /**
     * 接收 DeepSeek 的 JSON 并开始执行
     */
    async processPlan(planJson) {
        this.currentPlan = planJson;
        this.currentIndex = 0;
        console.log(`[StateMachine] 收到新计划 [${planJson.session_id}]，共 ${planJson.todo_list.length} 个任务。`);
        
        while (this.currentPlan && this.currentIndex < this.currentPlan.todo_list.length) {
            const todo = this.currentPlan.todo_list[this.currentIndex];
            let taskCompleted = false;

            console.log(`[StateMachine] 开始执行任务 (${this.currentIndex+1}/${this.currentPlan.todo_list.length}): ${todo.task_name}`);

            while (!taskCompleted) {
                // --- 1. 前置条件校验 ---
                let missingConditions = ConditionParser.evaluate(this.bot, todo.condition);
                if (missingConditions.length > 0) {
                    sendToOwner(this.bot, `⚠️ 主人，执行【${todo.task_name}】缺少: ${missingConditions.join(', ')}。`);
                    sendToOwner(this.bot, `💤 我已进入休眠。请丢给我物资，或输入 'retry' 重试，输入 'skip' 跳过该任务。`);
                    
                    const response = await this._waitForWakeUp();
                    if (response === 'skip') {
                        console.log(`[StateMachine] 已跳过任务: ${todo.task_name}`);
                        break; // 跳出 while，进入下一个 todo
                    }
                    if (response === 'stop') {
                        break;
                    }
                    continue; // retry 或 收到物品后，重新走 while 循环校验条件
                }

                // --- 2. 实例化并启动 Action ---
                let ActionClass = ActionRegistry[todo.action];
                
                // 动态插件匹配逻辑
                if (!ActionClass && global.registeredPlugins && global.registeredPlugins[todo.action]) {
                    ActionClass = global.registeredPlugins[todo.action];
                }

                if (!ActionClass) {
                    console.warn(`[StateMachine] 未知的动作类型: ${todo.action}，跳过此任务。`);
                    break;
                }

                this.currentActionInstance = new ActionClass(this.bot, todo.params);
                const snapshot = ObjectiveParser.takeSnapshot(this.bot); // 记录背包快照
                
                this.currentActionInstance.execute();

                // --- 3. 实时事件循环 (Tick) ---
                const actionResult = await new Promise((resolve) => {
                    // 高频轮询器 (每 1 秒检查一次)
                    const ticker = setInterval(() => {
                        if (!this.currentActionInstance || !this.currentActionInstance.isExecuting || this.currentActionInstance.isPaused) return;

                        // 3.1 实时校验 Condition (如挖矿中途镐子爆了)
                        const missingNow = ConditionParser.evaluate(this.bot, todo.condition);
                        if (missingNow.length > 0) {
                            this.currentActionInstance.pause();
                            clearInterval(ticker);
                            resolve('condition_lost'); // 触发外层重新索要
                        }

                        // 3.2 实时校验 Objective (如目标物品已凑齐)
                        if (ObjectiveParser.evaluate(this.bot, todo.objective, snapshot)) {
                            this.currentActionInstance.stop('objective_reached');
                            clearInterval(ticker);
                            resolve('success');
                        }
                    }, 1000);

                    // 监听 Action 自身的结束事件 (如 GoTo 卡步失败、寻路成功等)
                    this.currentActionInstance.once('stop', (reason) => {
                        clearInterval(ticker);
                        resolve(reason);
                    });
                });

                // --- 4. 处理 Action 结果 ---
                this.currentActionInstance = null;

                if (actionResult === 'success' || actionResult === 'objective_reached' || actionResult === 'skipped_by_user') {
                    taskCompleted = true;
                    if (actionResult !== 'skipped_by_user') {
                        console.log(`[StateMachine] 【${todo.task_name}】已完成！`);
                    }

                    await new Promise(r => setTimeout(r, 1500));
                } else if (actionResult === 'condition_lost') {
                    // 啥也不做，while 循环会回到顶部重新检查 condition 并索要
                } else if (actionResult === 'stopped_by_user') {
                    taskCompleted = true;
                    break;
                } else {
                    // Action 内部报错或失败 (例如 GoTo 卡步卡死)
                    sendToOwner(this.bot, `❌ 任务失败，原因: ${actionResult}。`);
                    sendToOwner(this.bot, `💤 我已进入休眠。请帮我解决困境后，输入 'retry' 重试，或 'skip' 跳过。`);
                    const response = await this._waitForWakeUp();
                    if (response === 'skip' || response === 'stop') break;
                }
            }
            this.currentIndex++;
        }
        if (this.currentPlan) {
            console.log("[StateMachine] 所有任务队列已执行完毕！");
            this.currentPlan = null;
        }
    }

    /**
     * 替换当前执行索引之后的所有任务
     */
    replaceRemainingTasks(newTasks) {
        if (!this.currentPlan) {
            // 如果当前没有计划在执行，直接作为新计划启动
            this.processPlan({
                session_id: "PLAN_" + Date.now(),
                todo_list: newTasks
            });
            return;
        }
        
        // 保留当前正在执行的任务（及之前的任务），替换后续任务
        const completedAndCurrent = this.currentPlan.todo_list.slice(0, this.currentIndex + 1);
        this.currentPlan.todo_list = completedAndCurrent.concat(newTasks);
        console.log(`[StateMachine] 计划已更新，当前任务完成后将执行新的 ${newTasks.length} 个任务。`);
    }

    /**
     * 停止所有任务
     */
    stopAll() {
        if (this.currentPlan) {
            this.currentPlan.todo_list = []; // 清空后续任务
        }
        if (this.currentActionInstance) {
            this.currentActionInstance.stop('stopped_by_user');
        }
        if (this.isSleeping) {
            this.wakeUp('stop');
        }
        console.log(`[StateMachine] 已停止所有任务。`);
        this.currentPlan = null;
    }

    /**
     * 跳过当前正在执行的任务
     */
    /**
     * 跳过当前正在执行的任务
     */
    skipCurrentTask() {
        if (!this.currentPlan) {
            console.warn(`[StateMachine] 当前没有正在执行的计划。`);
            return;
        }

        console.log(`[StateMachine] 收到指令，正在彻底停止并跳过当前任务...`);

        // 1. 提取当前任务之后的后续任务
        const remainingTasks = this.currentPlan.todo_list.slice(this.currentIndex + 1);

        // 2. 彻底销毁当前计划，这会让 processPlan 的 while 循环安全退出
        this.currentPlan = null; 

        // 3. 强制停止当前的 Action 和休眠状态
        if (this.currentActionInstance) {
            this.currentActionInstance.stop('stopped_by_user');
            this.currentActionInstance = null;
        }
        if (this.isSleeping) {
            this.wakeUp('stop');
        }

        // 4. 如果还有后续任务，延迟一小段时间后作为新计划启动
        if (remainingTasks.length > 0) {
            setTimeout(() => {
                this.processPlan({
                    session_id: "PLAN_SKIP_" + Date.now(),
                    todo_list: remainingTasks
                });
            }, 500); // 延迟 500ms 确保旧的 Action 已经彻底释放资源
        } else {
            console.log(`[StateMachine] 已跳过，后续没有其他任务了。`);
        }
    }
        /**
     * 重试当前正在执行的任务
     */
    retryCurrentTask() {
        if (!this.currentPlan) {
            console.warn(`[StateMachine] 当前没有正在执行的计划。`);
            return;
        }

        console.log(`[StateMachine] 收到指令，正在彻底停止并重试当前任务...`);

        // 1. 提取当前任务及之后的后续任务（注意这里是 slice(this.currentIndex)，包含当前任务）
        const remainingTasks = this.currentPlan.todo_list.slice(this.currentIndex);

        // 2. 彻底销毁当前计划，中断原来的 while 循环
        this.currentPlan = null; 

        // 3. 强制停止当前的 Action 和休眠状态
        if (this.currentActionInstance) {
            this.currentActionInstance.stop('stopped_by_user');
            this.currentActionInstance = null;
        }
        if (this.isSleeping) {
            this.wakeUp('stop'); // 唤醒并终止旧的等待
        }

        // 4. 延迟一小段时间后作为新计划启动
        if (remainingTasks.length > 0) {
            setTimeout(() => {
                this.processPlan({
                    session_id: "PLAN_RETRY_" + Date.now(),
                    todo_list: remainingTasks
                });
            }, 500); // 延迟 500ms 确保旧的 Action 已经彻底释放资源
        }
    }



    /**
     * 挂起状态机，等待玩家唤醒 (Human-in-the-loop)
     */
    _waitForWakeUp() {
        this.isSleeping = true;
        return new Promise((resolve) => {
            this.wakeUpResolver = resolve;
        });
    }

    /**
     * 玩家通过指令唤醒 AI
     */
    wakeUp(command = 'retry') {
        if (this.isSleeping && this.wakeUpResolver) {
            this.isSleeping = false;
            this.wakeUpResolver(command);
            this.wakeUpResolver = null;
        }
    }

    getCurrentAction() {
        return this.currentActionInstance;
    }
}

module.exports = StateMachine;
