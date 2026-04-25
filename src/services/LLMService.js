class LLMService {
    constructor() {
        this.apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
        this.baseUrl = process.env.LLM_API_URL || 'https://api.deepseek.com/v1';
        this.model = process.env.LLM_MODEL || 'deepseek-chat';
        
        // 自动处理 URL 拼接，确保支持 OpenAI 标准协议
        this.apiUrl = this.baseUrl.endsWith('/chat/completions') 
            ? this.baseUrl 
            : `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

        if (!this.apiKey) {
            console.warn('[LLMService] LLM_API_KEY 未设置，AI 功能将不可用。');
        }
    }

    async generatePlan(systemPrompt, history, userPrompt) {
        if (!this.apiKey) {
            throw new Error('LLM_API_KEY 未设置');
        }

        const messages = [
            { role: 'system', content: systemPrompt }
        ];

        // 添加历史记录
        for (const item of history) {
            messages.push({ role: 'user', content: item.user });
            messages.push({ role: 'assistant', content: item.summary });
        }

        // 添加当前用户输入
        messages.push({ role: 'user', content: userPrompt });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); 

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: messages,
                    response_format: { type: 'json_object' },
                    temperature: 0.1
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`LLM API 错误: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            const content = data.choices[0].message.content;
            
            let jsonString = content.trim();
            const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
            
            if (jsonMatch) {
                jsonString = jsonMatch[0];
            }

            try {
                return JSON.parse(jsonString);
            } catch (e) {
                console.error('[LLMService] 解析 JSON 失败. 净化后的字符串:', jsonString);
                console.error('[LLMService] 原始返回内容:', content);
                throw new Error('INVALID_JSON_RESPONSE');
            }
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                console.error('[LLMService] 请求 LLM API 超时');
                throw new Error('网络请求超时，API 无响应');
            }
            
            console.error('[LLMService] 调用 LLM 失败:', error);
            throw error;
        }
    }
}

module.exports = new LLMService();
