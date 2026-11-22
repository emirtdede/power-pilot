/**
 * agents/commandAgent.js - F9.1
 * Komut niyeti: AiService ayrıştırıcısına devreder (tek LLM temas noktası).
 */
module.exports = {
    id: 'command',
    version: '1.0.0',
    description: 'Doğal dil cümlesini görev önerisine çevirir.',
    async execute({ text, aiService }) {
        if (!aiService || typeof aiService.parseCommand !== 'function') {
            return { ok: false, code: 'NO_PARSER', message: 'Ayrıştırıcı yok.' };
        }
        return aiService.parseCommand(text);
    }
};
