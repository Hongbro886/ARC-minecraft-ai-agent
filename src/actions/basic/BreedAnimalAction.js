const { EventEmitter } = require('events');
const { sendToOwner } = require('../../utils/chat');

class BreedAnimalAction extends EventEmitter {
    constructor(bot, params) {
        super();
        this.bot = bot;
        // 目标动物名称，例如 'cow', 'sheep', 'pig', 'chicken'
        this.animalName = params.animal_name;
        // 扫描半径，默认 16 格
        this.radius = params.radius || 16;
        
        this.isPaused = false;
        this.isExecuting = false;

        // 常见动物与繁殖所需食物的映射表
        this.animalFoodMap = {
            'cow': ['wheat'],
            'sheep': ['wheat'],
            'pig': ['carrot', 'potato', 'beetroot'],
            'chicken': ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'],
            'horse': ['golden_apple', 'golden_carrot'],
            'wolf': ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'rotten_flesh'],
            'cat': ['cod', 'salmon'],
            'turtle': ['seagrass'],
            'panda': ['bamboo'],
            'fox': ['sweet_berries', 'glow_berries'],
            'bee': ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy']
        };
    }

    async execute() {
        this.isExecuting = true;
        const fedEntities = new Set(); // 记录已经喂过的动物 ID

        try {
            const mcData = require('minecraft-data')(this.bot.version);
            
            // 1. 校验动物类型和食物
            const validFoods = this.animalFoodMap[this.animalName];
            if (!validFoods) {
                sendToOwner(this.bot, `❌ 暂不支持自动繁殖该动物或未知的动物类型: ${this.animalName}`);
                return this.stop('unsupported_animal');
            }

            // 2. 检查背包中是否有对应的食物
            let foodItem = null;
            for (const foodName of validFoods) {
                const item = this.bot.inventory.items().find(i => i.name === foodName);
                if (item) {
                    foodItem = item;
                    break;
                }
            }

            if (!foodItem) {
                sendToOwner(this.bot, `⚠️ 背包中没有繁殖【${this.animalName}】所需的食物 (${validFoods.join(' 或 ')})！`);
                return this.stop('no_food');
            }

            sendToOwner(this.bot, `💕 开始在 ${this.radius} 格范围内寻找并繁殖【${this.animalName}】...`);

            // 3. 扫描附近实体
            const entities = Object.values(this.bot.entities).filter(e => 
                e.name === this.animalName && 
                e.position.distanceTo(this.bot.entity.position) <= this.radius
            );

            if (entities.length === 0) {
                sendToOwner(this.bot, `✅ 附近没有找到任何【${this.animalName}】。`);
                return this.stop('no_animals_found');
            }

            // 按距离从近到远排序
            entities.sort((a, b) => this.bot.entity.position.distanceTo(a.position) - this.bot.entity.position.distanceTo(b.position));

            let successCount = 0;

            // 4. 遍历并喂养
            for (const entity of entities) {
                if (!this.isExecuting) break;
                while (this.isPaused) await new Promise(resolve => setTimeout(resolve, 500));

                if (fedEntities.has(entity.id)) continue;

                // 检查食物是否耗尽
                const currentFood = this.bot.inventory.items().find(i => i.name === foodItem.name);
                if (!currentFood) {
                    sendToOwner(this.bot, `⚠️ 食物【${foodItem.name}】已用完，停止繁殖！`);
                    break;
                }

                // 距离校验与寻路
                const distance = this.bot.entity.position.distanceTo(entity.position);
                if (distance > 3) {
                    if (this.bot.pathfinder) {
                        const { goals } = require('mineflayer-pathfinder');
                        try {
                            // 走到距离动物 2 格以内
                            await this.bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
                        } catch (moveErr) {
                            console.log(`[BreedAnimalAction] 无法到达动物身边 (ID: ${entity.id}), 跳过`);
                            continue;
                        }
                    } else {
                        console.log(`[BreedAnimalAction] 动物太远且未安装 pathfinder，跳过 (ID: ${entity.id})`);
                        continue;
                    }
                }

                if (!this.isExecuting) break;

                try {
                    // 装备食物
                    await this.bot.equip(currentFood, 'hand');
                    
                    // 看向动物
                    await this.bot.lookAt(entity.position.offset(0, entity.height / 2, 0), true);
                    
                    if (!this.isExecuting) break;

                    // 喂养动物 (右键交互)
                    await this.bot.activateEntity(entity);
                    fedEntities.add(entity.id);
                    successCount++;
                    
                    console.log(`[BreedAnimalAction] 成功喂养了一只 ${this.animalName} (ID: ${entity.id})`);
                    
                    // 稍微等待，防止发包过快，也给动物进入发情期留出时间
                    await new Promise(resolve => setTimeout(resolve, 600));
                } catch (interactErr) {
                    console.log(`[BreedAnimalAction] 喂养失败 (ID: ${entity.id}): ${interactErr.message}`);
                }
            }

            if (!this.isExecuting) return;

            sendToOwner(this.bot, `✅ 繁殖作业完成！共尝试喂养了 ${successCount} 只【${this.animalName}】。`);
            this.stop('success');

        } catch (err) {
            if (!this.isExecuting) return;
            console.error(`[BreedAnimalAction] 作业异常:`, err.message);
            sendToOwner(this.bot, `❌ 繁殖异常: ${err.message}`);
            this.stop('breed_error');
        }
    }

    pause() {
        if (!this.isExecuting || this.isPaused) return;
        this.isPaused = true;
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 暂停时停止移动
        }
        console.log(`[BreedAnimalAction] 动作已暂停`);
    }

    resume() {
        if (!this.isExecuting || !this.isPaused) return;
        this.isPaused = false;
        console.log(`[BreedAnimalAction] 动作已恢复`);
    }

    stop(reason = 'cancelled_by_user') {
        if (!this.isExecuting) return;
        this.isExecuting = false;
        this.isPaused = false;
        
        if (this.bot.pathfinder) {
            this.bot.pathfinder.setGoal(null); // 停止时打断寻路
        }

        console.log(`[BreedAnimalAction] 动作结束，原因: ${reason}`);
        this.emit('stop', reason);
    }
}

module.exports = BreedAnimalAction;
