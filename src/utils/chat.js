/**
 * 发送消息给主人
 * @param {import('mineflayer').Bot} bot 
 * @param {string} message 
 */
function sendToOwner(bot, message) {
    const ownerName = process.env.MC_OWNER_NAME;
    const tellMode = process.env.TELL_MODE || 'whisper'; // 默认为私聊模式

    if (ownerName) {
        // 如果消息本身就是指令（以 / 开头），则直接发送
        if (message.startsWith('/')) {
            bot.chat(message);
        } else if (tellMode === 'public') {
            // 公屏模式：直接发送消息，并带上主人的名字作为前缀（可选，为了更自然）
            bot.chat(`${message}`);
        } else {
            // 私聊模式：使用 /tell
            bot.chat(`/tell ${ownerName} ${message}`);
        }
    } else {
        bot.chat(message);
    }
}

module.exports = { sendToOwner };
